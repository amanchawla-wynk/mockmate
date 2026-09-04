import {
  TRAFFIC_LIMITS,
  type TrafficBodyDescriptor,
  type TrafficCapturedEvidence,
  type TrafficPage,
  type TrafficPromotionResult,
  type TrafficQuery,
  type TrafficStore,
  type TrafficStoredDetail,
  type TrafficSummary,
} from '../domain/traffic';

export interface TrafficBodyReference {
  projectId: string;
  trafficId: string;
  generation: string;
  side: 'request' | 'response';
  descriptor: Extract<TrafficBodyDescriptor, { state: 'available' }>;
}

interface StoredRow {
  detail: Readonly<TrafficStoredDetail>;
  captured: Readonly<TrafficCapturedEvidence>;
  pendingSides: Set<'request' | 'response'>;
}

interface Registration {
  trafficId: string;
  generation: string;
  row?: StoredRow;
  pendingDescriptors: Map<'request' | 'response', TrafficBodyDescriptor>;
}

interface ProjectRows {
  order: Registration[];
  byTrafficId: Map<string, Registration>;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function immutableClone<T>(value: T): Readonly<T> {
  return deepFreeze(structuredClone(value));
}

function bodyReferences(detail: Readonly<TrafficStoredDetail>): TrafficBodyReference[] {
  const references: TrafficBodyReference[] = [];
  for (const side of ['request', 'response'] as const) {
    const descriptor = detail[side].body;
    if (descriptor.state === 'available') {
      references.push({
        projectId: detail.projectId,
        trafficId: detail.id,
        generation: detail.generation,
        side,
        descriptor: { ...descriptor },
      });
    }
  }
  return references;
}

function summarize(detail: Readonly<TrafficStoredDetail>): TrafficSummary {
  return {
    id: detail.id,
    generation: detail.generation,
    projectId: detail.projectId,
    requestId: detail.requestId,
    startedAt: detail.startedAt,
    completedAt: detail.completedAt,
    durationMs: detail.durationMs,
    transport: detail.transport,
    allowlistPattern: detail.allowlistPattern,
    origin: detail.origin,
    method: detail.method,
    path: detail.path,
    queryNames: detail.queryNames.map(entry => ({ ...entry })),
    ...(detail.endpoint === undefined ? {} : { endpoint: { ...detail.endpoint } }),
    decision: detail.decision,
    ...(detail.routingReason === undefined ? {} : { routingReason: detail.routingReason }),
    status: detail.status,
    responseBytes: detail.responseBytes,
    requestBodyState: detail.requestBodyState,
    responseBodyState: detail.responseBodyState,
  };
}

function promotionFor(
  current: TrafficStoredDetail['promotion'],
  captured: Readonly<TrafficCapturedEvidence>,
  responseBody: TrafficBodyDescriptor,
): TrafficStoredDetail['promotion'] {
  if (current.state === 'promoted') return current;
  if (current.state === 'blocked'
    && (current.reason === 'request_failed' || current.reason === 'request_cancelled')) return current;
  if (!captured.request.query.ok) return { state: 'blocked', reason: 'query_parse_invalid' };
  if (!captured.response.contentEncoding.ok) {
    return { state: 'blocked', reason: 'invalid_content_encoding' };
  }
  if (responseBody.state === 'available') return { state: 'eligible' };
  if (responseBody.state === 'truncated') return { state: 'blocked', reason: 'body_truncated' };
  if (responseBody.state === 'evicted') return { state: 'blocked', reason: 'body_evicted' };
  return { state: 'blocked', reason: 'body_unavailable' };
}

function pendingSides(detail: TrafficStoredDetail): Set<'request' | 'response'> {
  if (detail.captureState === 'complete') return new Set();
  return new Set((['request', 'response'] as const).filter(side => (
    detail[side].body.state === 'unavailable'
    && detail[side].body.reason === 'body_unobservable'
  )));
}

export function createTrafficStore(options: {
  rowsPerProject?: number;
  releaseBodyReference?(reference: TrafficBodyReference): Promise<void>;
} = {}): TrafficStore {
  const rowsPerProject = options.rowsPerProject ?? TRAFFIC_LIMITS.rowsPerProject;
  if (!Number.isSafeInteger(rowsPerProject) || rowsPerProject < 1) {
    throw new RangeError('Traffic rows per Project must be a positive safe integer');
  }
  const releaseBodyReference = options.releaseBodyReference ?? (async () => undefined);
  const projects = new Map<string, ProjectRows>();
  let releaseTail = Promise.resolve();

  const enqueueReleases = (references: readonly TrafficBodyReference[]): Promise<void> => {
    if (references.length === 0) return releaseTail;
    const operation = releaseTail.then(async () => {
      for (const reference of references) await releaseBodyReference(reference);
    });
    releaseTail = operation.catch(() => undefined);
    return operation;
  };

  const projectRows = (projectId: string): ProjectRows => {
    let project = projects.get(projectId);
    if (project === undefined) {
      project = { order: [], byTrafficId: new Map() };
      projects.set(projectId, project);
    }
    return project;
  };

  const detach = (project: ProjectRows, registration: Registration): TrafficBodyReference[] => {
    if (project.byTrafficId.get(registration.trafficId) === registration) {
      project.byTrafficId.delete(registration.trafficId);
    }
    const index = project.order.indexOf(registration);
    if (index >= 0) project.order.splice(index, 1);
    return registration.row === undefined ? [] : bodyReferences(registration.row.detail);
  };

  const matchingRegistration = (
    projectId: string,
    trafficId: string,
    generation: string,
  ): Registration | undefined => {
    const registration = projects.get(projectId)?.byTrafficId.get(trafficId);
    return registration?.generation === generation ? registration : undefined;
  };

  return {
    registerGeneration(projectId, trafficId, generation) {
      const project = projectRows(projectId);
      const references: TrafficBodyReference[] = [];
      const existing = project.byTrafficId.get(trafficId);
      if (existing !== undefined) references.push(...detach(project, existing));

      const registration: Registration = {
        trafficId,
        generation,
        pendingDescriptors: new Map(),
      };
      project.order.push(registration);
      project.byTrafficId.set(trafficId, registration);
      while (project.order.length > rowsPerProject) {
        references.push(...detach(project, project.order[0]));
      }
      void enqueueReleases(references);
    },

    async append(detail, captured) {
      if (detail.projectId !== captured.projectId
        || detail.id !== captured.trafficId
        || detail.generation !== captured.generation) {
        throw new Error('Traffic detail and captured evidence identities must match');
      }
      const registration = matchingRegistration(detail.projectId, detail.id, detail.generation);
      if (registration === undefined || registration.row !== undefined) {
        await enqueueReleases(bodyReferences(detail));
        return false;
      }

      const effectiveDetail = structuredClone(detail) as TrafficStoredDetail;
      const effectiveCaptured = structuredClone(captured) as TrafficCapturedEvidence;
      for (const [side, descriptor] of registration.pendingDescriptors) {
        effectiveDetail[side].body = structuredClone(descriptor);
        if (side === 'request') effectiveDetail.requestBodyState = descriptor.state;
        else {
          effectiveDetail.responseBodyState = descriptor.state;
          effectiveCaptured.response.body = structuredClone(descriptor);
        }
      }
      effectiveDetail.promotion = promotionFor(
        effectiveDetail.promotion,
        effectiveCaptured,
        effectiveDetail.response.body,
      );
      registration.pendingDescriptors.clear();
      registration.row = {
        detail: immutableClone(effectiveDetail),
        captured: immutableClone(effectiveCaptured),
        pendingSides: pendingSides(effectiveDetail),
      };
      await releaseTail;
      return true;
    },

    list(projectId, query: TrafficQuery = {}): TrafficPage {
      const rows = (projects.get(projectId)?.order ?? [])
        .filter((registration): registration is Registration & { row: StoredRow } => (
          registration.row !== undefined
        ));
      const requestedLimit = query.limit ?? 100;
      const finiteLimit = Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : 100;
      const limit = Math.max(1, Math.min(rowsPerProject, finiteLimit));
      let candidates: typeof rows;
      let reset = false;

      if (query.afterId !== undefined) {
        const cursor = rows.findIndex(registration => registration.trafficId === query.afterId);
        if (cursor < 0) {
          candidates = rows;
          reset = true;
        } else {
          candidates = rows.slice(cursor + 1);
          const selected = candidates.slice(0, limit);
          return immutableClone({
            entries: selected.map(registration => summarize(registration.row.detail)),
            ...(selected.at(-1) === undefined ? {} : { latestId: selected.at(-1)!.trafficId }),
            hasMore: candidates.length > selected.length,
          }) as TrafficPage;
        }
      } else if (query.beforeId !== undefined) {
        const cursor = rows.findIndex(registration => registration.trafficId === query.beforeId);
        if (cursor < 0) {
          candidates = rows;
          reset = true;
        } else {
          candidates = rows.slice(0, cursor);
        }
      } else {
        candidates = rows;
      }

      const selected = candidates.slice(-limit);
      return immutableClone({
        entries: selected.map(registration => summarize(registration.row.detail)),
        ...(selected.at(-1) === undefined ? {} : { latestId: selected.at(-1)!.trafficId }),
        hasMore: candidates.length > selected.length,
        ...(reset ? { reset: true } : {}),
      }) as TrafficPage;
    },

    get(projectId, trafficId) {
      const row = projects.get(projectId)?.byTrafficId.get(trafficId)?.row;
      return row === undefined ? undefined : immutableClone(row.detail) as TrafficStoredDetail;
    },

    updateBody(projectId, trafficId, generation, side, descriptor) {
      if (descriptor.side !== side) return false;
      const registration = matchingRegistration(projectId, trafficId, generation);
      if (registration === undefined) return false;
      if (registration.row === undefined) {
        registration.pendingDescriptors.set(side, structuredClone(descriptor));
        return true;
      }
      const oldDetail = registration.row.detail;
      const oldDescriptor = oldDetail[side].body;
      const detail = structuredClone(oldDetail) as TrafficStoredDetail;
      detail[side].body = structuredClone(descriptor);
      if (side === 'request') detail.requestBodyState = descriptor.state;
      else detail.responseBodyState = descriptor.state;
      registration.row.pendingSides.delete(side);
      detail.captureState = registration.row.pendingSides.size === 0 ? 'complete' : 'pending';

      let captured = registration.row.captured;
      if (side === 'response') {
        const mutableCaptured = structuredClone(captured) as TrafficCapturedEvidence;
        mutableCaptured.response.body = structuredClone(descriptor);
        captured = immutableClone(mutableCaptured);
      }
      detail.promotion = promotionFor(detail.promotion, captured, detail.response.body);
      registration.row = {
        detail: immutableClone(detail),
        captured,
        pendingSides: new Set(registration.row.pendingSides),
      };
      if (oldDescriptor.state === 'available') {
        void enqueueReleases([{
          projectId,
          trafficId,
          generation,
          side,
          descriptor: { ...oldDescriptor },
        }]);
      }
      return true;
    },

    snapshotForAcceptance(projectId, trafficId, generation) {
      const row = matchingRegistration(projectId, trafficId, generation)?.row;
      if (row === undefined) return undefined;
      return deepFreeze({
        projectId,
        trafficId,
        generation,
        detail: immutableClone(row.detail),
        captured: immutableClone(row.captured),
      });
    },

    attachPromotion(projectId, trafficId, generation, result: TrafficPromotionResult) {
      const registration = matchingRegistration(projectId, trafficId, generation);
      if (registration?.row === undefined) return false;
      const detail = structuredClone(registration.row.detail) as TrafficStoredDetail;
      detail.promotion = { state: 'promoted', result: structuredClone(result) };
      registration.row = {
        ...registration.row,
        detail: immutableClone(detail),
      };
      return true;
    },

    async clear(projectId) {
      const project = projects.get(projectId);
      if (project === undefined) {
        await releaseTail;
        return;
      }
      projects.delete(projectId);
      const references = project.order.flatMap(registration => (
        registration.row === undefined ? [] : bodyReferences(registration.row.detail)
      ));
      project.order.length = 0;
      project.byTrafficId.clear();
      await enqueueReleases(references);
    },
  };
}
