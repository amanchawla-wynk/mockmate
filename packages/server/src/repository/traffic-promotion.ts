import { createHash } from 'node:crypto';

import {
  normalizeContentEncoding,
  normalizeMediaType,
  normalizeResponseHeaders,
} from '../domain/http-metadata';
import type {
  AppState,
  BodyAsset,
  EndpointDetail,
  ResponseHeaders,
  ResponseVariant,
  TrafficVariantProvenance,
} from '../domain/model';
import type {
  TrafficAcceptedSnapshot,
  TrafficPromotionInput,
  TrafficPromotionResult,
} from '../domain/traffic';
import { HttpError } from '../services/api-errors';
import { canonicalEndpointIdentity } from './compile-project';
import { cloneSnapshot, type ValidatedProjectSnapshot } from './snapshot';

export interface TrafficPromotionReceiptKey {
  trafficId: string;
  trafficGeneration: string;
  responseIdentity: string;
  endpointTarget: { action: 'create' } | { action: 'reuse'; endpointId: string };
  stateTarget: { action: 'unbound' } | { action: 'bind'; stateId: string };
}

export type TrafficPromotionReceiptLookup =
  | { state: 'none' }
  | { state: 'exact'; result: TrafficPromotionResult }
  | { state: 'conflict' };

export type PublicationOperation =
  | 'validation'
  | 'bodyStaging'
  | 'candidateCompile'
  | 'generationWrite'
  | 'generationRename'
  | 'bodyPromote'
  | 'pointerWrite'
  | 'pointerPublish'
  | 'memoryPublish'
  | 'resultAttach'
  | 'cleanup';

export interface PublicationFailpoints {
  before(operation: PublicationOperation): Promise<void>;
}

export interface RepositoryPromotionPublication {
  readonly result: TrafficPromotionResult;
  complete(): Promise<void>;
}

const EMPTY_DIGEST = createHash('sha256').update(Buffer.alloc(0)).digest('hex');
const NON_SEMANTIC_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'upgrade',
  'x-powered-by',
  'x-request-id',
]);

function canonicalHeaderTuples(
  headers: readonly (readonly [string, string])[],
): Array<[string, string]> {
  const grouped = new Map<string, string[]>();
  for (const [name, value] of normalizeResponseHeaders(headers)) {
    if (NON_SEMANTIC_RESPONSE_HEADERS.has(name) || name.startsWith('x-mockmate-')) continue;
    const values = grouped.get(name);
    if (values === undefined) grouped.set(name, [value]);
    else values.push(value);
  }
  return [...grouped]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .flatMap(([name, values]) => values.map(value => [name, value] as [string, string]));
}

function canonicalResponseHeaders(
  headers: readonly (readonly [string, string])[],
): ResponseHeaders {
  const grouped = new Map<string, string[]>();
  for (const [name, value] of canonicalHeaderTuples(headers)) {
    const values = grouped.get(name);
    if (values === undefined) grouped.set(name, [value]);
    else values.push(value);
  }
  return Object.fromEntries([...grouped].map(([name, values]) => [
    name,
    values.length === 1 ? values[0] : values,
  ]));
}

function headerValue(
  headers: readonly (readonly [string, string])[],
  name: string,
): string | undefined {
  return headers.find(([candidate]) => candidate.toLowerCase() === name)?.[1];
}

function normalizedBody(body: BodyAsset | undefined, headers: readonly (readonly [string, string])[]) {
  if (body !== undefined) return {
    mediaType: normalizeMediaType(body.mediaType),
    contentEncoding: normalizeContentEncoding(body.encoding) ?? null,
    sha256: body.id,
    byteCount: body.size,
  };
  let mediaType = 'application/octet-stream';
  try {
    const authored = headerValue(headers, 'content-type');
    if (authored !== undefined) mediaType = normalizeMediaType(authored);
  } catch {
    // Bodyless malformed Content-Type retains octet-stream identity fallback.
  }
  return { mediaType, contentEncoding: null, sha256: EMPTY_DIGEST, byteCount: 0 };
}

export function promotionResponseIdentity(
  status: number,
  headers: readonly (readonly [string, string])[],
  body: BodyAsset | undefined,
  delayMs = 0,
): string {
  return createHash('sha256').update(JSON.stringify({
    status,
    headers: canonicalHeaderTuples(headers),
    delayMs,
    body: normalizedBody(body, headers),
  })).digest('hex');
}

export function promotionBodyMetadata(accepted: TrafficAcceptedSnapshot): {
  mediaType: string;
  encoding?: string;
} {
  let mediaType = 'application/octet-stream';
  try {
    if (accepted.response.body.mediaType !== undefined) {
      mediaType = normalizeMediaType(accepted.response.body.mediaType);
    }
  } catch {
    // Captured missing or malformed media types use the canonical fallback.
  }
  const encoding = normalizeContentEncoding(accepted.response.contentEncoding.value);
  return { mediaType, ...(encoding === undefined ? {} : { encoding }) };
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

function variantHeaders(variant: ResponseVariant, body: BodyAsset | undefined): Array<[string, string]> {
  const headers = Object.entries(variant.responseHeaders).flatMap(([name, value]) => (
    (Array.isArray(value) ? value : [value]).map(item => [name, item] as [string, string])
  ));
  if (body !== undefined && headerValue(headers, 'content-type') === undefined) {
    headers.push(['content-type', body.mediaType]);
  }
  return headers;
}

function variantMatches(
  variant: ResponseVariant,
  accepted: TrafficAcceptedSnapshot,
  bodyAssets: ReadonlyMap<string, BodyAsset>,
): boolean {
  const body = variant.bodyAssetId === undefined ? undefined : bodyAssets.get(variant.bodyAssetId);
  if (variant.bodyAssetId !== undefined && body === undefined) return false;
  if (body === undefined && accepted.response.body.retainedSize !== 0) return false;
  return promotionResponseIdentity(
    variant.status,
    variantHeaders(variant, body),
    body,
    variant.delayMs ?? 0,
  ) === accepted.response.identity;
}

function stalePromotion(): HttpError {
  return new HttpError(409, 'TRAFFIC_PROMOTION_STALE', 'Traffic promotion review is stale');
}

function revisionConflict(expectedRevision: number, currentRevision: number): HttpError {
  return new HttpError(409, 'REVISION_CONFLICT', 'Revision does not match current state', {
    details: { expectedRevision, currentRevision },
  });
}

export interface ApplyTrafficPromotionInput {
  current: ValidatedProjectSnapshot;
  accepted: TrafficAcceptedSnapshot;
  input: TrafficPromotionInput;
  body: BodyAsset;
  endpointId?: string;
  variantId?: string;
}

export interface TrafficPromotionTargets {
  currentEndpoint?: EndpointDetail;
  currentVariant?: ResponseVariant;
  selectedState?: AppState;
}

export function resolveTrafficPromotionTargets(
  current: ValidatedProjectSnapshot,
  accepted: TrafficAcceptedSnapshot,
  input: TrafficPromotionInput,
  body: BodyAsset,
): TrafficPromotionTargets {
  if (accepted.projectId !== current.project.id
    || accepted.generation !== input.expectedTrafficGeneration
    || accepted.response.identity !== input.expectedResponseIdentity
    || accepted.response.body.sha256 !== body.id
    || accepted.response.body.retainedSize !== body.size
    || promotionResponseIdentity(accepted.response.status, accepted.response.headers, body)
      !== accepted.response.identity) throw stalePromotion();

  const requestedEndpoint = input.endpoint.action === 'reuse'
    ? current.endpoints.get(input.endpoint.endpointId)
    : undefined;
  if (input.endpoint.action === 'reuse') {
    if (requestedEndpoint === undefined) throw stalePromotion();
    if (requestedEndpoint.revision !== input.endpoint.expectedRevision) {
      throw revisionConflict(input.endpoint.expectedRevision, requestedEndpoint.revision);
    }
  }
  const exactEndpoint = [...current.endpoints.values()].find(endpoint => (
    canonicalEndpointIdentity(endpoint) === endpointIdentity(accepted)
  ));
  if ((input.endpoint.action === 'create' && exactEndpoint !== undefined)
    || (input.endpoint.action === 'reuse' && exactEndpoint?.id !== input.endpoint.endpointId)) {
    throw stalePromotion();
  }

  const selectedState = input.state.action === 'bind'
    ? current.states.get(input.state.stateId)
    : undefined;
  if (input.state.action === 'bind') {
    if (selectedState === undefined) throw stalePromotion();
    if (selectedState.revision !== input.state.expectedRevision) {
      throw revisionConflict(input.state.expectedRevision, selectedState.revision);
    }
  }
  const currentEndpoint = input.endpoint.action === 'reuse' ? requestedEndpoint! : undefined;
  const currentVariant = currentEndpoint?.variants.find(variant => (
    variantMatches(variant, accepted, current.bodyAssets)
  ));
  return { currentEndpoint, currentVariant, selectedState };
}

export function applyTrafficPromotion(input: ApplyTrafficPromotionInput): {
  candidate: ValidatedProjectSnapshot;
  result: TrafficPromotionResult;
} {
  const { current, accepted, body } = input;
  const resolved = resolveTrafficPromotionTargets(current, accepted, input.input, body);
  const { currentEndpoint, currentVariant } = resolved;
  let { selectedState } = resolved;
  if (currentEndpoint === undefined && input.endpointId === undefined) throw new Error('Endpoint ID is required');
  if (currentVariant === undefined && input.variantId === undefined) throw new Error('Variant ID is required');

  const candidate = cloneSnapshot(current);
  (candidate.bodyAssets as Map<string, BodyAsset>).set(body.id, structuredClone(body));
  const endpointId = currentEndpoint?.id ?? input.endpointId!;
  const variantId = currentVariant?.id ?? input.variantId!;
  let endpointCreated = false;
  let variantCreated = false;
  let endpointModeChanged = false;
  let endpoint: EndpointDetail;
  if (currentEndpoint === undefined) {
    endpointCreated = true;
    variantCreated = true;
    const query = new Map<string, Array<{ operator: 'equals'; value: string }>>();
    for (const entry of accepted.request.query) {
      const expressions = query.get(entry.name);
      if (expressions === undefined) query.set(entry.name, [{ operator: 'equals', value: entry.value }]);
      else expressions.push({ operator: 'equals', value: entry.value });
    }
    endpoint = {
      schemaVersion: 4,
      id: endpointId,
      projectId: current.project.id,
      name: `${accepted.request.method} ${accepted.request.path}`,
      baseUrl: accepted.request.origin,
      matcher: {
        method: accepted.request.method,
        path: accepted.request.path,
        ...(query.size === 0 ? {} : { query: Object.fromEntries(query) }),
      },
      mode: 'mock',
      defaultVariantId: variantId,
      variants: [],
      revision: 0,
    };
    (candidate.endpoints as Map<string, EndpointDetail>).set(endpointId, endpoint);
  } else {
    endpoint = (candidate.endpoints as Map<string, EndpointDetail>).get(endpointId)!;
    if (endpoint.mode !== 'mock') {
      endpoint.mode = 'mock';
      endpointModeChanged = true;
    }
  }

  let variant = endpoint.variants.find(value => value.id === variantId);
  if (variant === undefined) {
    variantCreated = true;
    variant = {
      id: variantId,
      endpointId,
      name: `Captured ${accepted.response.status}`,
      status: accepted.response.status,
      responseHeaders: canonicalResponseHeaders(accepted.response.headers),
      bodyAssetId: body.id,
      revision: 0,
    };
    endpoint.variants.push(variant);
    if (endpoint.defaultVariantId === undefined) endpoint.defaultVariantId = variantId;
  }
  if (!endpointCreated && (variantCreated || endpointModeChanged)) endpoint.revision += 1;

  let bindingChanged = false;
  if (selectedState !== undefined) {
    selectedState = (candidate.states as Map<string, typeof selectedState>).get(selectedState.id)!;
    if (selectedState.bindings[endpointId] !== variantId) {
      selectedState.bindings[endpointId] = variantId;
      selectedState.revision += 1;
      bindingChanged = true;
    }
  }
  const result: TrafficPromotionResult = {
    endpointId,
    endpointCreated,
    variantId,
    variantCreated,
    endpointModeChanged,
    ...(selectedState === undefined ? {} : { stateId: selectedState.id }),
    bindingChanged,
  };
  const provenance: TrafficVariantProvenance = {
    type: 'traffic',
    trafficId: accepted.trafficId,
    trafficGeneration: accepted.generation,
    capturedAt: accepted.capturedAt,
    requestOrigin: accepted.request.origin,
    responseIdentity: accepted.response.identity,
    endpointTarget: input.input.endpoint.action,
    endpointId,
    endpointCreated,
    variantId,
    variantCreated,
    endpointModeChanged,
    stateTarget: selectedState === undefined ? 'unbound' : 'bound',
    ...(selectedState === undefined ? {} : { stateId: selectedState.id }),
    bindingChanged,
  };
  variant.trafficProvenance = [...(variant.trafficProvenance ?? []), provenance];
  if (!variantCreated) variant.revision += 1;
  return { candidate, result };
}

export function trafficPromotionReceiptKey(
  trafficId: string,
  input: TrafficPromotionInput,
): TrafficPromotionReceiptKey {
  return {
    trafficId,
    trafficGeneration: input.expectedTrafficGeneration,
    responseIdentity: input.expectedResponseIdentity,
    endpointTarget: input.endpoint.action === 'create'
      ? { action: 'create' }
      : { action: 'reuse', endpointId: input.endpoint.endpointId },
    stateTarget: input.state.action === 'unbound'
      ? { action: 'unbound' }
      : { action: 'bind', stateId: input.state.stateId },
  };
}

function provenanceKey(provenance: TrafficVariantProvenance): TrafficPromotionReceiptKey | undefined {
  const stateTarget = provenance.stateTarget === 'unbound'
    ? { action: 'unbound' as const }
    : provenance.stateId === undefined
      ? undefined
      : { action: 'bind' as const, stateId: provenance.stateId };
  if (stateTarget === undefined) return undefined;
  return {
    trafficId: provenance.trafficId,
    trafficGeneration: provenance.trafficGeneration,
    responseIdentity: provenance.responseIdentity,
    endpointTarget: provenance.endpointTarget === 'create'
      ? { action: 'create' }
      : { action: 'reuse', endpointId: provenance.endpointId },
    stateTarget,
  };
}

function sameKey(left: TrafficPromotionReceiptKey, right: TrafficPromotionReceiptKey): boolean {
  return left.trafficId === right.trafficId
    && left.trafficGeneration === right.trafficGeneration
    && left.responseIdentity === right.responseIdentity
    && left.endpointTarget.action === right.endpointTarget.action
    && (left.endpointTarget.action === 'create'
      || (right.endpointTarget.action === 'reuse'
        && left.endpointTarget.endpointId === right.endpointTarget.endpointId))
    && left.stateTarget.action === right.stateTarget.action
    && (left.stateTarget.action === 'unbound'
      || (right.stateTarget.action === 'bind'
        && left.stateTarget.stateId === right.stateTarget.stateId));
}

function resultFrom(provenance: TrafficVariantProvenance): TrafficPromotionResult {
  return {
    endpointId: provenance.endpointId,
    endpointCreated: provenance.endpointCreated,
    variantId: provenance.variantId,
    variantCreated: provenance.variantCreated,
    endpointModeChanged: provenance.endpointModeChanged,
    ...(provenance.stateId === undefined ? {} : { stateId: provenance.stateId }),
    bindingChanged: provenance.bindingChanged,
  };
}

export function lookupTrafficPromotionReceipt(
  endpoints: Iterable<EndpointDetail>,
  trafficId: string,
  input: TrafficPromotionInput,
): TrafficPromotionReceiptLookup {
  const requested = trafficPromotionReceiptKey(trafficId, input);
  let exact: TrafficPromotionResult | undefined;
  for (const endpoint of endpoints) {
    for (const variant of endpoint.variants) {
      for (const provenance of variant.trafficProvenance ?? []) {
        if (provenance.trafficId !== trafficId) continue;
        const stored = provenanceKey(provenance);
        if (stored === undefined || !sameKey(stored, requested)) return { state: 'conflict' };
        exact ??= resultFrom(provenance);
      }
    }
  }
  return exact === undefined
    ? { state: 'none' }
    : { state: 'exact', result: structuredClone(exact) };
}

interface PromotionAcceptor {
  accept(projectId: string, trafficId: string, expected: {
    generation: string;
    responseIdentity: string;
  }): Promise<{
    readonly snapshot: import('../domain/traffic').TrafficRowLeaseSnapshot;
    readonly lease: import('../services/traffic-body-cache').TrafficBodyLease;
    attachResult(result: TrafficPromotionResult): Promise<boolean>;
    settle(): Promise<void>;
  }>;
}

interface PromotionRepository {
  lookupTrafficPromotionReceipt(
    projectId: string,
    trafficId: string,
    input: TrafficPromotionInput,
  ): Promise<TrafficPromotionReceiptLookup>;
  promoteTraffic(
    snapshot: import('../domain/traffic').TrafficRowLeaseSnapshot,
    lease: import('../services/traffic-body-cache').TrafficBodyLease,
    input: TrafficPromotionInput,
  ): Promise<RepositoryPromotionPublication>;
}

export function createTrafficPromoter(dependencies: {
  repository: PromotionRepository;
  promotionAcceptor: PromotionAcceptor;
  publicationFailpoints: PublicationFailpoints;
}): {
  promote(
    projectId: string,
    trafficId: string,
    input: TrafficPromotionInput,
  ): Promise<TrafficPromotionResult>;
} {
  return {
    async promote(projectId, trafficId, input) {
      const receipt = await dependencies.repository.lookupTrafficPromotionReceipt(
        projectId,
        trafficId,
        input,
      );
      if (receipt.state === 'exact') return structuredClone(receipt.result);
      if (receipt.state === 'conflict') {
        throw new HttpError(
          409,
          'TRAFFIC_PROMOTION_CONFLICT',
          'Traffic was already promoted with a different command',
        );
      }

      const accepted = await dependencies.promotionAcceptor.accept(projectId, trafficId, {
        generation: input.expectedTrafficGeneration,
        responseIdentity: input.expectedResponseIdentity,
      });
      let publication: RepositoryPromotionPublication | undefined;
      let result: TrafficPromotionResult | undefined;
      let operationError: unknown;
      try {
        publication = await dependencies.repository.promoteTraffic(
          accepted.snapshot,
          accepted.lease,
          input,
        );
        await dependencies.publicationFailpoints.before('resultAttach');
        await accepted.attachResult(publication.result);
        result = structuredClone(publication.result);
      } catch (error) {
        operationError = error;
      }

      let cleanupError: unknown;
      try {
        await dependencies.publicationFailpoints.before('cleanup');
      } catch (error) {
        cleanupError = error;
      }
      if (publication !== undefined) {
        try {
          await publication.complete();
        } catch (error) {
          cleanupError ??= error;
        }
      }
      try {
        await accepted.settle();
      } catch (error) {
        cleanupError ??= error;
      }
      if (operationError !== undefined) throw operationError;
      if (cleanupError !== undefined) throw cleanupError;
      return result!;
    },
  };
}
