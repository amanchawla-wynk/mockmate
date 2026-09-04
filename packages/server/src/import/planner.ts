import type {
  EndpointDetail,
  EndpointMatcherInput,
  ResponseHeaders,
  ResponseVariant,
} from '../domain/model';
import { normalizeHttpOrigin } from '../domain/http-origin';
import {
  canonicalEndpointIdentity,
  matcherSpecificity,
  normalizeCanonicalMatcher,
  type MatcherSpecificityExtras,
} from '../repository/compile-project';
import type { ValidatedProjectSnapshot } from '../repository/snapshot';
import type {
  CanonicalImportRequest,
  ImportExactTarget,
  ImportMessage,
  ImportOverlap,
  ImportPlan,
  ImportPreviewData,
  ImportPreviewItem,
  NormalizedImportMember,
  NormalizedImportResponse,
  ParsedImportSource,
  PlannedImportResponse,
} from './contracts';
import {
  compareCodeUnits,
  redactImportMatcher,
  sha256Bytes,
  sha256Identity,
} from './security';

interface ImportGroup {
  requestIdentity: string;
  request: CanonicalImportRequest;
  members: NormalizedImportMember[];
}

interface PlannedGroup {
  group: ImportGroup;
  item: ImportPreviewItem;
  createResponses: PlannedImportResponse[];
  mergeResponsesByEndpointId: Map<string, PlannedImportResponse[]>;
}

function normalizedCompleteMatcher(matcher: EndpointMatcherInput): EndpointMatcherInput {
  return normalizeCanonicalMatcher(matcher);
}

export function matcherIdentity(request: CanonicalImportRequest): string {
  return sha256Identity('import-matcher-v2', {
    baseUrl: normalizeHttpOrigin(request.baseUrl).origin,
    matcher: normalizedCompleteMatcher(request.matcher),
  });
}

function dimensionMayOverlap(left: string | undefined, right: string | undefined): boolean {
  if (left === undefined || right === undefined) return true;
  const leftWildcard = left.includes('*');
  const rightWildcard = right.includes('*');
  if (leftWildcard || rightWildcard) return true;
  return left === right;
}

export function matchersMayOverlap(
  leftRequest: CanonicalImportRequest,
  rightRequest: CanonicalImportRequest,
): boolean {
  if (normalizeHttpOrigin(leftRequest.baseUrl).origin
    !== normalizeHttpOrigin(rightRequest.baseUrl).origin) return false;
  const left = normalizeCanonicalMatcher(leftRequest.matcher);
  const right = normalizeCanonicalMatcher(rightRequest.matcher);
  return left.method === right.method
    && dimensionMayOverlap(left.path, right.path);
}

function specificityExtras(matcher: EndpointDetail['matcher']): MatcherSpecificityExtras {
  const query = Object.values(matcher.query ?? {}).flat();
  const headers = Object.values(matcher.headers ?? {});
  return {
    queryCount: query.length,
    exactQueryCount: query.filter(expression => expression.operator === 'equals').length,
    headerCount: headers.length,
    exactHeaderCount: headers.filter(expression => expression.operator === 'equals').length,
  };
}

function compareSpecificity(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function relativeSpecificity(
  imported: EndpointMatcherInput,
  target: EndpointMatcherInput,
  targetExtras?: MatcherSpecificityExtras,
): ImportOverlap['relativeSpecificity'] {
  const difference = compareSpecificity(
    matcherSpecificity(imported),
    matcherSpecificity(target, targetExtras),
  );
  return difference > 0 ? 'more-specific' : difference < 0 ? 'less-specific' : 'equal';
}

function cloneHeaders(headers: ResponseHeaders): ResponseHeaders {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [
    name,
    Array.isArray(value) ? [...value] : value,
  ]));
}

function identityHeaders(headers: ResponseHeaders): Record<string, string[]> {
  const grouped = new Map<string, string[]>();
  for (const [sourceName, sourceValue] of Object.entries(headers)
    .sort(([left], [right]) => compareCodeUnits(left, right))) {
    const name = sourceName.toLowerCase();
    const values = Array.isArray(sourceValue) ? sourceValue : [sourceValue];
    grouped.set(name, [...(grouped.get(name) ?? []), ...values]);
  }
  return Object.fromEntries([...grouped]
    .sort(([left], [right]) => compareCodeUnits(left, right)));
}

function existingResponseIdentity(variant: ResponseVariant): string {
  return sha256Identity('import-response-v1', {
    status: variant.status,
    headers: identityHeaders(variant.responseHeaders),
    body: variant.bodyAssetId === undefined
      ? { kind: 'none' }
      : { kind: 'sha256', value: variant.bodyAssetId },
  });
}

function plannedResponse(
  response: NormalizedImportResponse,
  name: string,
): PlannedImportResponse {
  const body = response.body === undefined
    ? { kind: 'none' as const }
    : {
        kind: 'sha256' as const,
        sha256: sha256Bytes(response.body),
        byteCount: response.body.length,
      };
  return {
    summary: {
      name,
      status: response.status,
      responseHeaders: cloneHeaders(response.responseHeaders),
      body,
      identity: response.identity,
    },
    ...(response.body === undefined ? {} : { body: Buffer.from(response.body) }),
  };
}

function defaultResponse(): PlannedImportResponse {
  return {
    summary: {
      name: 'Default',
      status: 200,
      responseHeaders: {},
      body: { kind: 'none' },
      identity: sha256Identity('import-response-v1', {
        status: 200,
        headers: {},
        body: { kind: 'none' },
      }),
    },
  };
}

function availableName(name: string, usedNames: Set<string>): string {
  if (!usedNames.has(name.toLowerCase())) {
    usedNames.add(name.toLowerCase());
    return name;
  }
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${name} (${suffix})`;
    if (!usedNames.has(candidate.toLowerCase())) {
      usedNames.add(candidate.toLowerCase());
      return candidate;
    }
  }
}

function namedCreateResponses(responses: NormalizedImportResponse[]): PlannedImportResponse[] {
  const usedNames = new Set<string>();
  return responses.map((response, index) => {
    const baseName = response.name.trim() || `Response ${index + 1}`;
    return plannedResponse(response, availableName(baseName, usedNames));
  });
}

function mergeCandidates(
  endpoint: EndpointDetail,
  responses: NormalizedImportResponse[],
): PlannedImportResponse[] {
  const identities = new Set(endpoint.variants.map(existingResponseIdentity));
  const usedNames = new Set(endpoint.variants.map(variant => variant.name.toLowerCase()));
  const candidates: PlannedImportResponse[] = [];
  for (let index = 0; index < responses.length; index += 1) {
    const response = responses[index];
    if (identities.has(response.identity)) continue;
    identities.add(response.identity);
    const baseName = response.name.trim() || `Response ${index + 1}`;
    candidates.push(plannedResponse(response, availableName(baseName, usedNames)));
  }
  return candidates;
}

function exactTarget(
  endpoint: EndpointDetail,
  candidates: PlannedImportResponse[],
): ImportExactTarget {
  return {
    endpointId: endpoint.id,
    endpointRevision: endpoint.revision,
    name: endpoint.name,
    newVariantCount: candidates.length,
    candidateResponses: candidates.map(candidate => candidate.summary),
  };
}

function collectMessages(
  members: NormalizedImportMember[],
  field: 'warnings' | 'errors',
): ImportMessage[] {
  return members.flatMap(member => member[field].map(message => ({ ...message })));
}

function isValidGroup(group: ImportGroup): boolean {
  return group.members.every(member => (
    !member.disabled
    && member.supportedMethod
    && member.errors.length === 0
  ));
}

function overlapSortKey(overlap: ImportOverlap): string {
  return overlap.endpointId ?? overlap.itemId ?? '';
}

function compareOverlaps(left: ImportOverlap, right: ImportOverlap): number {
  return compareCodeUnits(overlapSortKey(left), overlapSortKey(right));
}

function groupMembers(parsed: ParsedImportSource): ImportGroup[] {
  const groups = new Map<string, ImportGroup>();
  for (const member of parsed.members) {
    if (member.canonicalRequest === undefined) continue;
    const request = {
      baseUrl: normalizeHttpOrigin(member.canonicalRequest.baseUrl).origin,
      matcher: normalizedCompleteMatcher(member.canonicalRequest.matcher),
    };
    const requestIdentity = matcherIdentity(request);
    const existing = groups.get(requestIdentity);
    if (existing) existing.members.push(member);
    else groups.set(requestIdentity, { requestIdentity, request, members: [member] });
  }
  return [...groups.values()];
}

function planGroup(
  snapshot: ValidatedProjectSnapshot,
  parsed: ParsedImportSource,
  group: ImportGroup,
): PlannedGroup {
  const flattenedResponses = group.members.flatMap(member => member.responses);
  const exactEndpoints = [...snapshot.endpoints.values()]
    .filter(endpoint => canonicalEndpointIdentity(endpoint) === canonicalEndpointIdentity(group.request))
    .sort((left, right) => compareCodeUnits(left.id, right.id));
  const valid = isValidGroup(group);
  const createAllowed = exactEndpoints.length === 0 && valid;
  const sourceResponses = flattenedResponses.length === 0 && createAllowed
    ? [defaultResponse()]
    : namedCreateResponses(flattenedResponses);
  const createResponses = createAllowed
    ? sourceResponses
    : [];
  const mergeResponsesByEndpointId = new Map<string, PlannedImportResponse[]>();
  const exactTargets = exactEndpoints.map(endpoint => {
    const candidates = mergeCandidates(endpoint, flattenedResponses);
    mergeResponsesByEndpointId.set(endpoint.id, candidates);
    return exactTarget(endpoint, candidates);
  });
  const hasMergeEffect = exactTargets.some(target => target.newVariantCount > 0);
  const proposedAction = !valid
    ? 'skip' as const
    : exactEndpoints.length === 0
      ? 'create' as const
      : hasMergeEffect
        ? 'merge' as const
        : 'skip' as const;
  const first = group.members[0];
  const locations = group.members.map(member => structuredClone(member.location));
  const id = sha256Identity('import-item-v1', {
    sourceType: parsed.sourceType,
    requestIdentity: group.requestIdentity,
    locations,
  });
  const preview: ImportPreviewItem = {
    id,
    memberIds: group.members.map(member => member.provisionalId),
    locations,
    breadcrumbs: group.members.map(member => [...member.breadcrumb]),
    name: first.name,
    ...(first.description === undefined ? {} : { description: first.description }),
    baseUrl: group.request.baseUrl,
    matcher: redactImportMatcher(group.request.matcher),
    requests: group.members.map(member => structuredClone(member.request)),
    responses: sourceResponses.map(response => response.summary),
    proposedAction,
    allowedActions: !valid
      ? ['skip']
      : exactEndpoints.length === 0
        ? ['create', 'skip']
        : ['merge', 'skip'],
    exactTargets,
    overlaps: [],
    warnings: collectMessages(group.members, 'warnings'),
    errors: collectMessages(group.members, 'errors'),
    selectedByDefault: proposedAction !== 'skip',
    createEffect: createAllowed
      ? { createsEndpoint: true, createsVariants: createResponses.length }
      : { createsEndpoint: false, createsVariants: 0 },
  };
  return { group, item: preview, createResponses, mergeResponsesByEndpointId };
}

function addExistingOverlaps(
  snapshot: ValidatedProjectSnapshot,
  planned: PlannedGroup,
): void {
  for (const endpoint of snapshot.endpoints.values()) {
    if (
      canonicalEndpointIdentity(endpoint) === canonicalEndpointIdentity(planned.group.request)
      || !matchersMayOverlap(planned.group.request, endpoint)
    ) continue;
    const relative = relativeSpecificity(
      planned.group.request.matcher,
      endpoint.matcher,
      specificityExtras(endpoint.matcher),
    );
    planned.item.overlaps.push({
      endpointId: endpoint.id,
      baseUrl: endpoint.baseUrl,
      matcher: redactImportMatcher(normalizeCanonicalMatcher(endpoint.matcher)),
      relativeSpecificity: relative,
      confirmationRequired: relative === 'equal',
    });
  }
}

function addImportedOverlaps(planned: PlannedGroup[]): void {
  for (let leftIndex = 0; leftIndex < planned.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < planned.length; rightIndex += 1) {
      const left = planned[leftIndex];
      const right = planned[rightIndex];
      if (!matchersMayOverlap(left.group.request, right.group.request)) continue;
      const leftRelative = relativeSpecificity(left.group.request.matcher, right.group.request.matcher);
      const rightRelative = relativeSpecificity(right.group.request.matcher, left.group.request.matcher);
      left.item.overlaps.push({
        itemId: right.item.id,
        baseUrl: right.group.request.baseUrl,
        matcher: redactImportMatcher(right.group.request.matcher),
        relativeSpecificity: leftRelative,
        confirmationRequired: leftRelative === 'equal',
      });
      right.item.overlaps.push({
        itemId: left.item.id,
        baseUrl: left.group.request.baseUrl,
        matcher: redactImportMatcher(left.group.request.matcher),
        relativeSpecificity: rightRelative,
        confirmationRequired: rightRelative === 'equal',
      });
    }
  }
}

export function buildImportPlan(
  snapshot: ValidatedProjectSnapshot,
  parsed: ParsedImportSource,
  variablesDigest: string,
): ImportPlan {
  void variablesDigest;
  const planned = groupMembers(parsed).map(group => planGroup(snapshot, parsed, group));
  for (const item of planned) addExistingOverlaps(snapshot, item);
  addImportedOverlaps(planned);
  for (const item of planned) item.item.overlaps.sort(compareOverlaps);

  const unresolved = parsed.members.filter(member => member.canonicalRequest === undefined);
  const variableMembers = new Map<string, string[]>();
  for (const member of unresolved) {
    for (const variable of member.unresolvedVariables) {
      const memberIds = variableMembers.get(variable);
      if (memberIds) {
        if (!memberIds.includes(member.provisionalId)) memberIds.push(member.provisionalId);
      } else variableMembers.set(variable, [member.provisionalId]);
    }
  }
  const proposedCreate = planned.some(value => value.item.proposedAction === 'create');
  const affectedStates = proposedCreate
    ? [...snapshot.states.values()]
        .sort((left, right) => compareCodeUnits(left.id, right.id))
        .map(state => ({ id: state.id, name: state.name }))
    : [];
  const discoveredOrigins = [...new Set(planned.map(value => value.group.request.baseUrl))]
    .sort(compareCodeUnits);
  const items = planned.map(value => value.item);
  const valid = planned.filter(value => isValidGroup(value.group)).length;
  const preview: ImportPreviewData = {
    sourceType: parsed.sourceType,
    items,
    unresolvedMembers: unresolved.map(member => ({
      id: member.provisionalId,
      location: structuredClone(member.location),
      breadcrumb: [...member.breadcrumb],
      name: member.name,
      warnings: member.warnings.map(message => ({ ...message })),
      errors: member.errors.map(message => ({ ...message })),
    })),
    unresolvedVariables: [...variableMembers]
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([name, memberIds]) => ({ name, memberIds })),
    warnings: parsed.warnings.map(message => ({ ...message })),
    discoveredOrigins,
    affectedStates,
    summary: {
      valid,
      invalid: planned.length - valid + unresolved.length,
      create: items.filter(item => item.proposedAction === 'create').length,
      merge: items.filter(item => item.proposedAction === 'merge').length,
      skip: items.filter(item => item.proposedAction === 'skip').length,
    },
  };
  return {
    preview,
    items: planned.map(value => ({
      preview: value.item,
      canonicalRequest: value.group.request,
      createResponses: value.createResponses,
      mergeResponsesByEndpointId: value.mergeResponsesByEndpointId,
    })),
  };
}

export function canonicalImportDigest(snapshot: ValidatedProjectSnapshot): string {
  const endpoints = [...snapshot.endpoints.values()]
    .sort((left, right) => compareCodeUnits(left.id, right.id))
    .map(endpoint => ({
      id: endpoint.id,
      revision: endpoint.revision,
      baseUrl: normalizeHttpOrigin(endpoint.baseUrl).origin,
      matcher: normalizedCompleteMatcher(endpoint.matcher),
      defaultVariantId: endpoint.defaultVariantId,
      variants: endpoint.variants.map(variant => ({
        id: variant.id,
        revision: variant.revision,
        name: variant.name,
        status: variant.status,
        responseHeaders: identityHeaders(variant.responseHeaders),
        ...(variant.bodyAssetId === undefined ? {} : { bodyAssetId: variant.bodyAssetId }),
        delayMs: variant.delayMs ?? 0,
      })),
    }));
  const referencedBodyIds = new Set(endpoints.flatMap(endpoint => endpoint.variants.flatMap(variant => (
    variant.bodyAssetId === undefined ? [] : [variant.bodyAssetId]
  ))));
  const bodyAssets = [...referencedBodyIds]
    .sort(compareCodeUnits)
    .map(id => {
      const asset = snapshot.bodyAssets.get(id);
      return asset === undefined ? { id, missing: true } : {
        schemaVersion: asset.schemaVersion,
        id: asset.id,
        mediaType: asset.mediaType,
        size: asset.size,
        ...(asset.encoding === undefined ? {} : { encoding: asset.encoding }),
        createdAt: asset.createdAt,
      };
    });
  return sha256Identity('import-canonical-v1', { endpoints, bodyAssets });
}

export function importPlanDigest(plan: ImportPlan, variablesDigest: string): string {
  const preview = plan.preview;
  return sha256Identity('import-plan-v1', {
    sourceType: preview.sourceType,
    variablesDigest,
    items: plan.items.map(item => ({
      canonicalRequest: item.canonicalRequest,
      id: item.preview.id,
      locations: item.preview.locations,
      name: item.preview.name,
      description: item.preview.description,
      baseUrl: item.preview.baseUrl,
      matcher: item.preview.matcher,
      responses: item.preview.responses,
      exactTargets: item.preview.exactTargets,
      overlaps: item.preview.overlaps,
      warnings: item.preview.warnings,
      errors: item.preview.errors,
    })),
    unresolvedMembers: preview.unresolvedMembers,
    unresolvedVariables: preview.unresolvedVariables,
    warnings: preview.warnings,
  });
}
