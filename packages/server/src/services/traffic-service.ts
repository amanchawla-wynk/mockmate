import { createHash, randomUUID } from 'node:crypto';

import {
  createPreviewContentDecoder,
  type PreviewContentDecoder,
} from '../domain/content-encoding-decode';
import {
  normalizeContentEncoding,
  normalizeMediaType,
  normalizeResponseHeaders,
  projectContentEncoding,
} from '../domain/http-metadata';
import {
  isSensitiveHeaderName,
  isSensitiveQueryName,
  redactTrafficQuery,
} from '../domain/traffic-redaction';
import {
  type TrafficAcceptedSnapshot,
  type TrafficBeginInput,
  type TrafficBodyDescriptor,
  type TrafficDetail,
  type TrafficExchange,
  type TrafficPage,
  type TrafficLimits,
  type TrafficPromotionInput,
  type TrafficPromotionReview,
  type TrafficPromotionResult,
  type TrafficQuery,
  type TrafficRowLeaseSnapshot,
  type TrafficStore,
  type TrafficStoredDetail,
  type TrafficTerminalOutcome,
} from '../domain/traffic';
import type { FileSystem } from '../repository/file-system';
import type { ProjectRepository } from '../repository/project-repository';
import { canonicalEndpointIdentity } from '../repository/compile-project';
import type { BodyAsset, EndpointDetail, ResponseVariant } from '../domain/model';
import { HttpError } from './api-errors';
import { createCaptureSidecar, type CaptureSidecar } from './capture-sidecar';
import type { TrafficBodyBudgetManager } from './traffic-body-budget';
import type { TrafficBodyCache, TrafficBodyLease } from './traffic-body-cache';
import { createTrafficOutcomeBuilder } from './traffic-outcome';

export interface TrafficPromoter {
  promote(
    projectId: string,
    trafficId: string,
    input: TrafficPromotionInput,
  ): Promise<TrafficPromotionResult>;
}

export interface TrafficService {
  begin(input: TrafficBeginInput): TrafficExchange;
  list(projectId: string, query?: TrafficQuery): TrafficPage;
  get(projectId: string, trafficId: string): TrafficDetail | undefined;
  openBody(projectId: string, trafficId: string, side: 'request' | 'response'): Promise<{
    descriptor: Extract<TrafficBodyDescriptor, { state: 'available' }>;
    lease: TrafficBodyLease;
  }>;
  complete(exchange: TrafficExchange, outcome: TrafficTerminalOutcome): void;
  clear(projectId: string): Promise<void>;
  dispose(): Promise<void>;
  promoter: TrafficPromoter;
}

interface AcceptedTrafficPromotion {
  readonly snapshot: TrafficRowLeaseSnapshot;
  readonly lease: TrafficBodyLease;
  attachResult(result: TrafficPromotionResult): Promise<boolean>;
  settle(): Promise<void>;
}

interface TrafficPromotionAcceptor {
  accept(projectId: string, trafficId: string, expected: {
    generation: string;
    responseIdentity: string;
  }): Promise<AcceptedTrafficPromotion>;
}

interface TrafficServiceComposition {
  service: TrafficService;
  promotionAcceptor: TrafficPromotionAcceptor;
  installPromoter(promoter: TrafficPromoter): void;
}

function firstHeader(headers: readonly (readonly [string, string])[], name: string): string | undefined {
  return headers.find(([candidate]) => candidate.toLowerCase() === name)?.[1];
}

function isText(mediaType: string | undefined): boolean {
  const value = mediaType?.toLowerCase() ?? '';
  return value.startsWith('text/') || value.includes('json') || value.includes('xml');
}

function unavailable(side: 'request' | 'response'): TrafficBodyDescriptor {
  return { side, state: 'unavailable', observedSize: 0, reason: 'body_unobservable' };
}

function normalizedMediaType(mediaType: string | undefined): string {
  return mediaTypeProjection(mediaType).value;
}

function mediaTypeProjection(mediaType: string | undefined): {
  value: string;
  defaulted: boolean;
} {
  if (mediaType === undefined) return { value: 'application/octet-stream', defaulted: true };
  try {
    return { value: normalizeMediaType(mediaType), defaulted: false };
  } catch {
    return { value: 'application/octet-stream', defaulted: true };
  }
}

function identityContentEncoding(contentEncoding: string | undefined): string | null {
  if (contentEncoding === undefined) return null;
  try {
    return normalizeContentEncoding(contentEncoding) ?? null;
  } catch {
    return 'invalid';
  }
}

function identityResponseHeaders(
  headers: readonly (readonly [string, string])[],
): Array<[string, string]> {
  const grouped = new Map<string, string[]>();
  for (const [name, value] of normalizeResponseHeaders(headers)) {
    if (name === 'connection'
      || name === 'keep-alive'
      || name === 'proxy-authenticate'
      || name === 'proxy-authorization'
      || name === 'te'
      || name === 'trailer'
      || name === 'upgrade'
      || name === 'x-powered-by'
      || name === 'x-request-id'
      || name.startsWith('x-mockmate-')) continue;
    const values = grouped.get(name);
    if (values === undefined) grouped.set(name, [value]);
    else values.push(value);
  }
  return [...grouped]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .flatMap(([name, values]) => values.map(value => [name, value] as [string, string]));
}

function responseIdentity(input: {
  status: number;
  headers: readonly (readonly [string, string])[];
  delayMs: number;
  descriptor: TrafficBodyDescriptor;
}): string {
  const descriptor = input.descriptor;
  const body = descriptor.state === 'available'
    ? {
      mediaType: normalizedMediaType(descriptor.mediaType),
      contentEncoding: identityContentEncoding(descriptor.contentEncoding),
      sha256: descriptor.sha256,
      byteCount: descriptor.retainedSize,
    }
    : { state: descriptor.state };
  return createHash('sha256').update(JSON.stringify({
    status: input.status,
    headers: identityResponseHeaders(input.headers),
    delayMs: input.delayMs,
    body,
  })).digest('hex');
}

function endpointIdentity(accepted: TrafficAcceptedSnapshot): string {
  const query = new Map<string, Array<{ operator: 'equals'; value: string }>>();
  for (const entry of accepted.request.query) {
    const expressions = query.get(entry.name);
    if (expressions === undefined) query.set(entry.name, [{ operator: 'equals', value: entry.value }]);
    else expressions.push({ operator: 'equals', value: entry.value });
  }
  return canonicalEndpointIdentity({
    baseUrl: accepted.request.origin,
    matcher: {
      method: accepted.request.method,
      path: accepted.request.path,
      ...(query.size === 0 ? {} : { query: Object.fromEntries(query) }),
    },
  });
}

function variantHeaders(
  variant: ResponseVariant,
  body: BodyAsset | undefined,
): Array<[string, string]> {
  const headers = Object.entries(variant.responseHeaders).flatMap(([name, value]) => (
    (Array.isArray(value) ? value : [value]).map(item => [name, item] as [string, string])
  ));
  if (body !== undefined
    && !headers.some(([name]) => name.toLowerCase() === 'content-type')) {
    headers.push(['content-type', body.mediaType]);
  }
  return headers;
}

function variantMatches(
  projectId: string,
  variant: ResponseVariant,
  accepted: TrafficAcceptedSnapshot,
  repository: ProjectRepository,
): boolean {
  const expectedDigest = accepted.response.body.sha256;
  const emptyDigest = createHash('sha256').update(Buffer.alloc(0)).digest('hex');
  let body: BodyAsset | undefined;
  if (variant.bodyAssetId === undefined) {
    if (expectedDigest !== emptyDigest || accepted.response.body.retainedSize !== 0) return false;
  } else {
    try {
      body = repository.getBodyMetadata(projectId, variant.bodyAssetId);
    } catch {
      return false;
    }
  }
  const headers = variantHeaders(variant, body);
  const descriptor: TrafficBodyDescriptor = {
    ...accepted.response.body,
    observedSize: body?.size ?? 0,
    retainedSize: body?.size ?? 0,
    sha256: body?.id ?? emptyDigest,
    mediaType: firstHeader(headers, 'content-type'),
    contentEncoding: body?.encoding,
  };
  return responseIdentity({
    status: variant.status,
    headers,
    delayMs: variant.delayMs ?? 0,
    descriptor,
  }) === accepted.response.identity;
}

function acceptedSnapshot(
  snapshot: NonNullable<ReturnType<TrafficStore['snapshotForAcceptance']>>,
): TrafficAcceptedSnapshot | undefined {
  if (snapshot.detail.promotion.state !== 'eligible'
    || !snapshot.captured.request.query.ok
    || !snapshot.captured.response.contentEncoding.ok
    || snapshot.captured.response.body.state !== 'available') return undefined;
  return {
    projectId: snapshot.projectId,
    trafficId: snapshot.trafficId,
    generation: snapshot.generation,
    capturedAt: snapshot.captured.capturedAt,
    request: {
      origin: snapshot.captured.request.origin,
      method: snapshot.captured.request.method,
      path: snapshot.captured.request.path,
      query: snapshot.captured.request.query.entries.map(entry => ({ ...entry })),
    },
    response: {
      identity: snapshot.captured.response.identity,
      status: snapshot.captured.response.status,
      headers: snapshot.captured.response.headers.map(([name, value]) => [name, value]),
      contentEncoding: { ...snapshot.captured.response.contentEncoding },
      body: { ...snapshot.captured.response.body },
    },
    acceptedAt: new Date().toISOString(),
  };
}

export function createTrafficService(input: {
  runtimeNamespace: string;
  repository: ProjectRepository;
  store: TrafficStore;
  cache: TrafficBodyCache;
  budgets: TrafficBodyBudgetManager;
  fileSystem: FileSystem;
  limits: Readonly<TrafficLimits>;
}): TrafficServiceComposition {
  let installedPromoter: TrafficPromoter = {
    async promote() {
      throw new HttpError(501, 'TRAFFIC_PROMOTION_UNAVAILABLE', 'Traffic promotion is unavailable');
    },
  };
  let accepting = true;
  let disposePromise: Promise<void> | undefined;
  const active = new Set<Promise<unknown>>();
  const admitted = new Map<TrafficExchange, () => Promise<TrafficStoredDetail>>();
  const clearingProjects = new Set<string>();
  const clearTails = new Map<string, Promise<void>>();

  const own = <T>(operation: Promise<T>): Promise<T> => {
    active.add(operation);
    void operation.then(
      () => active.delete(operation),
      () => active.delete(operation),
    );
    return operation;
  };

  const acceptanceError = (
    projectId: string,
    trafficId: string,
    generation: string,
  ): HttpError => {
    const snapshot = input.store.snapshotForAcceptance(projectId, trafficId, generation);
    if (snapshot === undefined) return new HttpError(404, 'TRAFFIC_NOT_FOUND', 'Traffic entry was not found');
    if (!snapshot.captured.request.query.ok) {
      return new HttpError(409, 'TRAFFIC_PROMOTION_BLOCKED', 'Traffic promotion is blocked');
    }
    if (!snapshot.captured.response.contentEncoding.ok) {
      return new HttpError(409, 'TRAFFIC_PROMOTION_BLOCKED', 'Traffic promotion is blocked');
    }
    if (snapshot.detail.promotion.state === 'blocked'
      && (snapshot.detail.promotion.reason === 'request_failed'
        || snapshot.detail.promotion.reason === 'request_cancelled')) {
      return new HttpError(409, 'TRAFFIC_PROMOTION_BLOCKED', 'Traffic promotion is blocked');
    }
    const body = snapshot.captured.response.body;
    if (body.state === 'unavailable') {
      return new HttpError(409, 'TRAFFIC_BODY_UNAVAILABLE', 'Traffic body is unavailable');
    }
    if (body.state === 'truncated') {
      return new HttpError(409, 'TRAFFIC_BODY_TRUNCATED', 'Traffic body was truncated');
    }
    return new HttpError(410, 'TRAFFIC_BODY_EVICTED', 'Traffic body was evicted');
  };

  const publicDetail = (projectId: string, trafficId: string): TrafficDetail | undefined => {
    const detail = input.store.get(projectId, trafficId);
    if (detail === undefined) return undefined;
    if (detail.promotion.state === 'blocked') return {
      ...detail,
      promotion: { ...detail.promotion },
    };
    if (detail.promotion.state === 'promoted') return {
      ...detail,
      promotion: { state: 'promoted', result: { ...detail.promotion.result } },
    };
    const snapshot = input.store.snapshotForAcceptance(projectId, trafficId, detail.generation);
    const accepted = snapshot === undefined ? undefined : acceptedSnapshot(snapshot);
    if (accepted === undefined) return {
      ...detail,
      promotion: { state: 'blocked', reason: 'body_unavailable' },
    };
    let endpoint: TrafficPromotionReview['endpoint'] = { action: 'create', targetMode: 'mock' };
    let variant: TrafficPromotionReview['variant'] = {
      action: 'create',
      deterministicName: `Captured ${detail.status}`,
    };
    let currentEndpoint: EndpointDetail | undefined;
    const identity = endpointIdentity(accepted);
    for (const summary of input.repository.listEndpoints(projectId)) {
      const candidate = input.repository.getEndpoint(projectId, summary.id);
      if (canonicalEndpointIdentity(candidate) === identity) {
        currentEndpoint = candidate;
        break;
      }
    }
    if (currentEndpoint !== undefined) {
      const current = currentEndpoint;
        endpoint = {
          action: 'reuse',
          endpointId: current.id,
          expectedRevision: current.revision,
          currentMode: current.mode,
          targetMode: 'mock',
        };
      const matchingVariant = current.variants.find(candidate => variantMatches(
        projectId,
        candidate,
        accepted,
        input.repository,
      ));
      if (matchingVariant !== undefined) variant = { action: 'reuse', variantId: matchingVariant.id };
    }
    let state: TrafficPromotionReview['state'] = { action: 'unbound' };
    const activeStateId = input.repository.getProject(projectId).activeStateId;
    if (activeStateId !== undefined) {
      try {
        const current = input.repository.getState(projectId, activeStateId);
        state = { action: 'bind', stateId: current.id, expectedRevision: current.revision };
      } catch {
        // Deleted State evidence becomes an unbound target.
      }
    }
    const sensitiveQueryNames = [...new Set(accepted.request.query
      .filter(entry => isSensitiveQueryName(entry.name))
      .map(entry => entry.name))];
    const sensitiveHeaderNames = [...new Set(accepted.response.headers
      .map(([name]) => name.toLowerCase())
      .filter(isSensitiveHeaderName))];
    const mediaTypeDefaulted = mediaTypeProjection(accepted.response.body.mediaType).defaulted;
    const warnings: TrafficPromotionReview['warnings'] = [];
    if (mediaTypeDefaulted) warnings.push('media_type_defaulted');
    if (sensitiveQueryNames.length > 0) warnings.push('sensitive_query_values_persisted');
    if (sensitiveHeaderNames.length > 0) warnings.push('sensitive_response_headers_persisted');
    return {
      ...detail,
      promotion: {
        state: 'eligible',
        review: {
          expectedTrafficGeneration: accepted.generation,
          expectedResponseIdentity: accepted.response.identity,
          request: {
            origin: accepted.request.origin,
            method: accepted.request.method,
            path: accepted.request.path,
            query: redactTrafficQuery(accepted.request.query),
            headers: detail.request.headers.map(([name, value]) => [name, value]),
            sensitiveQueryNames,
          },
          response: {
            status: accepted.response.status,
            headers: detail.response.headers.map(([name, value]) => [name, value]),
            mediaType: normalizedMediaType(accepted.response.body.mediaType),
            ...(accepted.response.contentEncoding.value === undefined
              ? {}
              : { contentEncoding: accepted.response.contentEncoding.value }),
            byteCount: accepted.response.body.retainedSize,
            sha256: accepted.response.body.sha256,
            sensitiveHeaderNames,
          },
          endpoint,
          variant,
          state,
          ...(state.action === 'bind' ? { defaultStateId: state.stateId } : {}),
          warnings,
        },
      },
    };
  };

  const service: TrafficService = {
    begin(beginInput) {
      if (!accepting || clearingProjects.has(beginInput.projectId)) {
        throw new Error('Traffic service is unavailable');
      }
      const builder = createTrafficOutcomeBuilder({
        projectId: beginInput.projectId,
        requestId: beginInput.requestId,
        now: Date.now,
        id: randomUUID,
        transport: beginInput.transport,
        allowlistPattern: beginInput.allowlistPattern,
        origin: beginInput.origin,
        method: beginInput.method,
        path: beginInput.path,
        query: beginInput.query,
        headers: beginInput.headers,
        appStateContext: beginInput.appState,
        previewBytes: input.limits.previewBytes,
      });
      input.store.registerGeneration(beginInput.projectId, builder.trafficId, builder.generation);
      const requestMediaType = firstHeader(beginInput.headers, 'content-type');
      const requestEncoding = projectContentEncoding(beginInput.headers);
      const requestPreviewDecoder = createPreviewContentDecoder(
        requestEncoding.valid ? requestEncoding.value : undefined,
        input.limits.previewBytes,
      );
      const requestSidecar = createCaptureSidecar({
        runtimeNamespace: input.runtimeNamespace,
        projectId: beginInput.projectId,
        trafficId: builder.trafficId,
        generation: builder.generation,
        side: 'request',
        // Exact retention is always on; captureRawTraffic no longer gates capture.
        enabled: true,
        ...(requestMediaType === undefined ? {} : { mediaType: requestMediaType }),
        ...(requestEncoding.valid && requestEncoding.value !== undefined
          ? { contentEncoding: requestEncoding.value }
          : {}),
        textPreview: isText(requestMediaType),
        cache: input.cache,
        budgets: input.budgets,
        fileSystem: input.fileSystem,
        limits: input.limits,
      });
      let responseSidecar: CaptureSidecar | undefined;
      let responsePreviewDecoder: PreviewContentDecoder | undefined;
      let responseStatus = 0;
      let responseHeaders: Array<readonly [string, string]> = [];
      let requestCompletion: Promise<TrafficBodyDescriptor> | undefined;
      let responseCompletion: Promise<TrafficBodyDescriptor> | undefined;
      let finalization: Promise<ReturnType<typeof builder.finalize>> | undefined;

      const applyPreviewOverride = async (
        decoder: PreviewContentDecoder,
        side: 'request' | 'response',
      ): Promise<void> => {
        const result = await decoder.finish();
        if (result.ok) {
          if (result.decoded.byteLength === 0) return;
          if (side === 'request') {
            builder.setRequestPreviewOverride(result.decoded, result.truncated);
          } else {
            builder.setResponsePreviewOverride(result.decoded, result.truncated);
          }
          return;
        }
        if (result.encodedFallback.byteLength === 0) return;
        if (side === 'request') {
          builder.setRequestPreviewOverride(result.encodedFallback);
        } else {
          builder.setResponsePreviewOverride(result.encodedFallback);
        }
      };

      const completeRequest = (): Promise<TrafficBodyDescriptor> => {
        requestCompletion ??= own(requestSidecar.complete().then(observation => {
          builder.setRequestDescriptor(observation.descriptor);
          return observation.descriptor;
        }));
        return requestCompletion;
      };
      const completeResponse = (): Promise<TrafficBodyDescriptor> => {
        if (responseSidecar === undefined) return Promise.resolve(unavailable('response'));
        responseCompletion ??= own(responseSidecar.complete().then(observation => {
          builder.setResponseDescriptor(observation.descriptor);
          return observation.descriptor;
        }));
        return responseCompletion;
      };
      const setResponse = (status: number, headers: readonly (readonly [string, string])[]): void => {
        if (responseSidecar !== undefined) throw new Error('Traffic response is already set');
        responseStatus = status;
        responseHeaders = headers.map(([name, value]) => [name, value]);
        builder.setResponse(status, headers);
        const mediaType = firstHeader(headers, 'content-type');
        const contentEncoding = projectContentEncoding(headers);
        responsePreviewDecoder = createPreviewContentDecoder(
          contentEncoding.valid ? contentEncoding.value : undefined,
          input.limits.previewBytes,
        );
        responseSidecar = createCaptureSidecar({
          runtimeNamespace: input.runtimeNamespace,
          projectId: beginInput.projectId,
          trafficId: builder.trafficId,
          generation: builder.generation,
          side: 'response',
          enabled: true,
          ...(mediaType === undefined ? {} : { mediaType }),
          ...(contentEncoding.valid && contentEncoding.value !== undefined
            ? { contentEncoding: contentEncoding.value }
            : {}),
          textPreview: isText(mediaType),
          cache: input.cache,
          budgets: input.budgets,
          fileSystem: input.fileSystem,
          limits: input.limits,
        });
      };

      const exchange: TrafficExchange = {
        trafficId: builder.trafficId,
        generation: builder.generation,
        observeRequest(bytes) {
          if (!requestSidecar.acceptsObservation()) return;
          requestPreviewDecoder.write(bytes);
          builder.observeRequestPreview(bytes);
          requestSidecar.observe(bytes);
        },
        abandonRequest(reason) {
          if (finalization === undefined) requestSidecar.abandon(reason);
        },
        completeRequest,
        setDecision(decision) {
          builder.setDecision(decision);
        },
        setResponse,
        observeResponse(bytes) {
          if (responseSidecar === undefined) throw new Error('Traffic response is not set');
          if (!responseSidecar.acceptsObservation()) return;
          responsePreviewDecoder?.write(bytes);
          builder.observeResponsePreview(bytes);
          responseSidecar.observe(bytes);
        },
        completeResponse,
        finalize(outcome) {
          if (finalization === undefined) {
            if (outcome.kind === 'cancelled') {
              if (responseSidecar === undefined) setResponse(outcome.status, []);
              requestSidecar.abandon('stream_cancelled');
              responseSidecar?.abandon('stream_cancelled');
            } else if (outcome.kind === 'failure' && !outcome.responseBodyComplete) {
              responseSidecar?.abandon('body_unobservable');
            }
            finalization = own((async () => {
              const [requestBody, responseBody] = await Promise.all([
                completeRequest(),
                completeResponse(),
              ]);
              await applyPreviewOverride(requestPreviewDecoder, 'request');
              if (responsePreviewDecoder !== undefined) {
                await applyPreviewOverride(responsePreviewDecoder, 'response');
              }
              const detail = builder.finalize(outcome);
              const responseEncoding = projectContentEncoding(responseHeaders);
              const contentEncoding: { ok: true; value?: string }
                | { ok: false; reason: 'invalid_content_encoding' } = responseEncoding.valid
                  ? responseEncoding.value === undefined
                    ? { ok: true }
                    : { ok: true, value: responseEncoding.value }
                  : { ok: false, reason: responseEncoding.reason };
              await input.store.append(detail, {
                projectId: beginInput.projectId,
                trafficId: builder.trafficId,
                generation: builder.generation,
                capturedAt: detail.completedAt,
                request: {
                  origin: beginInput.origin.origin,
                  method: beginInput.method,
                  path: beginInput.path,
                  query: beginInput.query,
                },
                response: {
                  identity: responseIdentity({
                    status: responseStatus || outcome.status,
                    headers: responseHeaders,
                    delayMs: 0,
                    descriptor: responseBody,
                  }),
                  status: responseStatus || outcome.status,
                  headers: responseHeaders,
                  contentEncoding,
                  body: responseBody,
                },
              });
              void requestBody;
              return detail;
            })()).finally(() => admitted.delete(exchange));
          }
          return finalization;
        },
      };
      admitted.set(exchange, () => exchange.finalize({
        kind: 'cancelled',
        status: 499,
        responseBytes: 0,
      }));
      return exchange;
    },
    list: (projectId, query) => input.store.list(projectId, query),
    get: publicDetail,
    complete(exchange, outcome) {
      try {
        void exchange.finalize(outcome).catch(() => undefined);
      } catch {
        // Delivery has already settled; Traffic persistence cannot replace its result.
      }
    },
    async openBody(projectId, trafficId, side) {
      const detail = input.store.get(projectId, trafficId);
      if (detail === undefined) throw new HttpError(404, 'TRAFFIC_NOT_FOUND', 'Traffic entry was not found');
      const descriptor = detail[side].body;
      if (descriptor.state === 'unavailable') {
        throw new HttpError(409, 'TRAFFIC_BODY_UNAVAILABLE', 'Traffic body is unavailable');
      }
      if (descriptor.state === 'truncated') {
        throw new HttpError(409, 'TRAFFIC_BODY_TRUNCATED', 'Traffic body was truncated');
      }
      if (descriptor.state === 'evicted') {
        throw new HttpError(410, 'TRAFFIC_BODY_EVICTED', 'Traffic body was evicted');
      }
      const lease = await input.cache.acquire(projectId, trafficId, detail.generation, side);
      if (lease === undefined) throw new HttpError(410, 'TRAFFIC_BODY_EVICTED', 'Traffic body was evicted');
      return { descriptor, lease };
    },
    clear(projectId) {
      if (!accepting) return Promise.reject(new Error('Traffic service is unavailable'));
      clearingProjects.add(projectId);
      const run = async () => {
        const storeClear = input.store.clear(projectId);
        const cacheClear = input.cache.clearProject(projectId);
        await Promise.all([storeClear, cacheClear]);
      };
      const previous = clearTails.get(projectId);
      const operation = previous === undefined
        ? run()
        : previous.catch(() => undefined).then(run);
      const tail = operation.finally(() => {
        if (clearTails.get(projectId) === tail) {
          clearTails.delete(projectId);
          clearingProjects.delete(projectId);
        }
      });
      clearTails.set(projectId, tail);
      return tail;
    },
    dispose() {
      if (disposePromise !== undefined) return disposePromise;
      accepting = false;
      const admissionCancellations = [...admitted.values()].map(cancel => cancel());
      const cacheDisposal = input.cache.dispose();
      disposePromise = (async () => {
        await Promise.allSettled([...clearTails.values(), ...admissionCancellations]);
        while (active.size > 0) await Promise.allSettled([...active]);
        await cacheDisposal;
      })();
      return disposePromise;
    },
    promoter: {
      promote(projectId, trafficId, promotionInput) {
        return installedPromoter.promote(projectId, trafficId, promotionInput);
      },
    },
  };
  const promotionAcceptor: TrafficPromotionAcceptor = {
    accept(projectId, trafficId, expected) {
      return own((async () => {
        const initial = input.store.snapshotForAcceptance(projectId, trafficId, expected.generation);
        if (initial === undefined) throw acceptanceError(projectId, trafficId, expected.generation);
        const accepted = acceptedSnapshot(initial);
        if (accepted === undefined) throw acceptanceError(projectId, trafficId, expected.generation);
        if (accepted.response.identity !== expected.responseIdentity) {
          throw new HttpError(409, 'TRAFFIC_PROMOTION_STALE', 'Traffic promotion evidence is stale');
        }

        const lease = await input.cache.acquire(projectId, trafficId, expected.generation, 'response');
        if (lease === undefined) throw new HttpError(410, 'TRAFFIC_BODY_EVICTED', 'Traffic body was evicted');
        try {
          const current = input.store.snapshotForAcceptance(projectId, trafficId, expected.generation);
          const revalidated = current === undefined ? undefined : acceptedSnapshot(current);
          if (revalidated === undefined
            || revalidated.response.identity !== expected.responseIdentity
            || JSON.stringify(revalidated.response.body) !== JSON.stringify(accepted.response.body)) {
            throw new HttpError(409, 'TRAFFIC_PROMOTION_STALE', 'Traffic promotion evidence is stale');
          }

          let settled: Promise<void> | undefined;
          const settle = () => {
            settled ??= lease.release();
            return settled;
          };
          return {
            snapshot: {
              projectId,
              trafficId,
              generation: expected.generation,
              detail: current!.detail,
              accepted: revalidated,
            },
            lease,
            async attachResult(result) {
              return input.store.attachPromotion(projectId, trafficId, expected.generation, result);
            },
            settle,
          };
        } catch (error) {
          await lease.release().catch(() => undefined);
          throw error;
        }
      })());
    },
  };
  return {
    service,
    promotionAcceptor,
    installPromoter(promoter) {
      installedPromoter = promoter;
    },
  };
}
