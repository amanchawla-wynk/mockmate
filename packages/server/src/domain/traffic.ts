import { z } from 'zod';

import type { HeaderTuple } from '../services/upstream-transport';
import type { NormalizedOrigin } from './http-origin';
import type { QueryEntry, QueryParseResult } from './query-matcher';

export type TrafficBodyUnavailableReason =
  | 'raw_capture_disabled'
  | 'sidecar_limit'
  | 'queue_saturated'
  | 'temporary_budget_exceeded'
  | 'retained_budget_exceeded'
  | 'capture_io_failed'
  | 'stream_cancelled'
  | 'body_unobservable';

export type TrafficBodyDescriptor =
  | {
    side: 'request' | 'response';
    state: 'available';
    mediaType?: string;
    contentEncoding?: string;
    observedSize: number;
    retainedSize: number;
    sha256: string;
  }
  | {
    side: 'request' | 'response';
    state: 'truncated';
    mediaType?: string;
    contentEncoding?: string;
    observedSize: number;
    reason: 'body_limit_exceeded';
  }
  | {
    side: 'request' | 'response';
    state: 'evicted';
    mediaType?: string;
    contentEncoding?: string;
    observedSize: number;
    retainedSize: number;
    sha256: string;
    reason: 'retention_evicted';
  }
  | {
    side: 'request' | 'response';
    state: 'unavailable';
    mediaType?: string;
    contentEncoding?: string;
    observedSize: number;
    reason: TrafficBodyUnavailableReason;
  };

export interface TrafficLimits {
  rowsPerProject: number;
  previewBytes: number;
  bodyBytes: number;
  sidecarQueueBytes: number;
  projectActiveSidecars: number;
  projectQueuedBytes: number;
  processActiveSidecars: number;
  processQueuedBytes: number;
  projectTemporaryBytes: number;
  processTemporaryBytes: number;
  projectRetainedBytes: number;
  processRetainedBytes: number;
}

export const TRAFFIC_LIMITS: Readonly<TrafficLimits> = Object.freeze({
  rowsPerProject: 500,
  previewBytes: 16 * 1024,
  bodyBytes: 50 * 1024 * 1024,
  sidecarQueueBytes: 1 * 1024 * 1024,
  projectActiveSidecars: 32,
  projectQueuedBytes: 32 * 1024 * 1024,
  processActiveSidecars: 128,
  processQueuedBytes: 128 * 1024 * 1024,
  projectTemporaryBytes: 1 * 1024 ** 3,
  processTemporaryBytes: 2 * 1024 ** 3,
  projectRetainedBytes: 1 * 1024 ** 3,
  processRetainedBytes: 4 * 1024 ** 3,
});

export const TRAFFIC_CAPTURE_REPRESENTATION =
  'http_entity_bytes_after_transfer_framing_before_content_encoding_decoding' as const;

const safeSize = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const descriptorBase = {
  side: z.enum(['request', 'response']),
  mediaType: z.string().optional(),
  contentEncoding: z.string().optional(),
  observedSize: safeSize,
};

const availableDescriptorSchema = z.strictObject({
  ...descriptorBase,
  state: z.literal('available'),
  retainedSize: safeSize,
  sha256: digest,
}).refine(value => value.observedSize === value.retainedSize, {
  message: 'Available descriptor sizes must match',
  path: ['retainedSize'],
});

const truncatedDescriptorSchema = z.strictObject({
  ...descriptorBase,
  state: z.literal('truncated'),
  observedSize: safeSize.min(1),
  reason: z.literal('body_limit_exceeded'),
});

const evictedDescriptorSchema = z.strictObject({
  ...descriptorBase,
  state: z.literal('evicted'),
  retainedSize: safeSize,
  sha256: digest,
  reason: z.literal('retention_evicted'),
}).refine(value => value.observedSize === value.retainedSize, {
  message: 'Evicted descriptor sizes must match',
  path: ['retainedSize'],
});

const unavailableDescriptorSchema = z.strictObject({
  ...descriptorBase,
  state: z.literal('unavailable'),
  reason: z.enum([
    'raw_capture_disabled',
    'sidecar_limit',
    'queue_saturated',
    'temporary_budget_exceeded',
    'retained_budget_exceeded',
    'capture_io_failed',
    'stream_cancelled',
    'body_unobservable',
  ]),
});

export const TrafficBodyDescriptorSchema: z.ZodType<TrafficBodyDescriptor> = z.union([
  availableDescriptorSchema,
  truncatedDescriptorSchema,
  evictedDescriptorSchema,
  unavailableDescriptorSchema,
]);

export type TrafficTransport = 'direct' | 'plain_http_proxy' | 'https_mitm';

export type TrafficRoutingDecisionName =
  | 'mock'
  | 'endpoint_passthrough'
  | 'no_match_passthrough'
  | 'direct_miss'
  | 'direct_passthrough_unavailable'
  | 'failure';

export interface TrafficPreview {
  encoding: 'utf8' | 'base64';
  value: string;
  truncated: boolean;
}

function isTextMediaType(mediaType: string | undefined): boolean {
  const normalized = mediaType?.toLowerCase() ?? '';
  return normalized.startsWith('text/')
    || normalized.includes('json')
    || normalized.includes('xml')
    || normalized.includes('x-www-form-urlencoded');
}

export function createTrafficPreview(
  bytes: Uint8Array,
  descriptor: TrafficBodyDescriptor,
  mediaType?: string,
  previewBytes: number = TRAFFIC_LIMITS.previewBytes,
): TrafficPreview {
  const bounded = Buffer.from(bytes).subarray(0, previewBytes);
  if (!isTextMediaType(mediaType ?? descriptor.mediaType)) {
    return {
      encoding: 'base64',
      value: bounded.toString('base64'),
      truncated: bytes.byteLength > bounded.byteLength,
    };
  }

  try {
    const value = new TextDecoder('utf-8', { fatal: true }).decode(bounded, {
      stream: bytes.byteLength > previewBytes,
    });
    return {
      encoding: 'utf8',
      value,
      truncated: bytes.byteLength > Buffer.byteLength(value, 'utf8'),
    };
  } catch {
    return {
      encoding: 'base64',
      value: bounded.toString('base64'),
      truncated: bytes.byteLength > bounded.byteLength,
    };
  }
}

export interface TrafficEndpointEvidence {
  id: string;
  name: string;
  specificity: number;
  mode: 'mock' | 'passthrough';
}

export interface TrafficAppStateContext {
  mode: 'enabled' | 'disabled';
  activeStateId?: string;
  baseStateId?: string;
  selectedStateId?: string;
  resolutionSource?: 'project_active_state' | 'project_base_state' | 'endpoint_default';
  fallbackReasons: Array<
    | 'app_state_mode_disabled'
    | 'active_state_not_set'
    | 'active_state_unbound'
    | 'base_state_not_set'
    | 'base_state_unbound'
  >;
}

export type TrafficRoutingEvidence =
  | {
    decision: 'mock';
    endpoint: TrafficEndpointEvidence;
    variantId: string;
    bodyAssetId?: string;
    appState: TrafficAppStateContext;
  }
  | {
    decision: 'endpoint_passthrough';
    endpoint: TrafficEndpointEvidence;
    appState: TrafficAppStateContext;
  }
  | {
    decision: 'direct_passthrough_unavailable';
    endpoint: TrafficEndpointEvidence;
    appState: TrafficAppStateContext;
  }
  | {
    decision: 'no_match_passthrough' | 'direct_miss';
    reason?: 'query_parse_invalid';
    appState: TrafficAppStateContext;
  }
  | { decision: 'failure'; reason: string; appState: TrafficAppStateContext };

export type TrafficTerminalOutcome =
  | { kind: 'response'; status: number; responseBytes: number; upstreamStatus?: number }
  | {
    kind: 'failure';
    status: number;
    responseBytes: number;
    responseBodyComplete?: boolean;
    failure: { code: string; message: string };
  }
  | { kind: 'cancelled'; status: number; responseBytes: number };

export type TrafficPromotionInput = {
  expectedTrafficGeneration: string;
  expectedResponseIdentity: string;
  endpoint:
    | { action: 'create' }
    | { action: 'reuse'; endpointId: string; expectedRevision: number };
  state:
    | { action: 'unbound' }
    | { action: 'bind'; stateId: string; expectedRevision: number };
};

export type TrafficPromotionResult = {
  endpointId: string;
  endpointCreated: boolean;
  variantId: string;
  variantCreated: boolean;
  endpointModeChanged: boolean;
  stateId?: string;
  bindingChanged: boolean;
};

export interface TrafficPromotionReview {
  expectedTrafficGeneration: string;
  expectedResponseIdentity: string;
  request: {
    origin: string;
    method: string;
    path: string;
    query: QueryEntry[];
    headers: HeaderTuple[];
    sensitiveQueryNames: string[];
  };
  response: {
    status: number;
    headers: HeaderTuple[];
    mediaType: string;
    contentEncoding?: string;
    byteCount: number;
    sha256: string;
    sensitiveHeaderNames: string[];
  };
  endpoint:
    | { action: 'create'; targetMode: 'mock' }
    | {
      action: 'reuse';
      endpointId: string;
      expectedRevision: number;
      currentMode: 'mock' | 'passthrough';
      targetMode: 'mock';
    };
  variant:
    | { action: 'create'; deterministicName: string }
    | { action: 'reuse'; variantId: string };
  state:
    | { action: 'unbound' }
    | { action: 'bind'; stateId: string; expectedRevision: number };
  defaultStateId?: string;
  warnings: Array<
    | 'media_type_defaulted'
    | 'sensitive_query_values_persisted'
    | 'sensitive_response_headers_persisted'
  >;
}

export interface TrafficSummary {
  id: string;
  generation: string;
  projectId: string;
  requestId: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  transport: TrafficTransport;
  allowlistPattern: string;
  origin: string;
  method: string;
  path: string;
  queryNames: Array<{ name: string; occurrenceCount: number; sensitive: boolean }>;
  endpoint?: TrafficEndpointEvidence;
  decision: TrafficRoutingDecisionName;
  routingReason?: 'query_parse_invalid';
  status: number;
  responseBytes: number;
  requestBodyState: TrafficBodyDescriptor['state'];
  responseBodyState: TrafficBodyDescriptor['state'];
}

export interface TrafficDetail extends TrafficSummary {
  request: {
    query: QueryEntry[];
    headers: HeaderTuple[];
    preview?: TrafficPreview;
    body: TrafficBodyDescriptor;
  };
  response: {
    headers: HeaderTuple[];
    preview?: TrafficPreview;
    body: TrafficBodyDescriptor;
  };
  appState: TrafficAppStateContext;
  variantId?: string;
  bodyAssetId?: string;
  upstream?: { status?: number; failure?: { code: string; message: string } };
  captureState: 'pending' | 'complete';
  promotion:
    | {
      state: 'blocked';
      reason:
        | 'body_unavailable'
        | 'body_truncated'
         | 'body_evicted'
         | 'invalid_content_encoding'
         | 'query_parse_invalid'
         | 'request_failed'
         | 'request_cancelled';
    }
    | { state: 'eligible'; review: TrafficPromotionReview }
    | { state: 'promoted'; result: TrafficPromotionResult };
}

export type TrafficStoredDetail = Omit<TrafficDetail, 'promotion'> & {
  promotion:
    | {
      state: 'blocked';
      reason:
        | 'body_unavailable'
        | 'body_truncated'
         | 'body_evicted'
         | 'invalid_content_encoding'
         | 'query_parse_invalid'
         | 'request_failed'
         | 'request_cancelled';
    }
    | { state: 'eligible' }
    | { state: 'promoted'; result: TrafficPromotionResult };
};

export interface TrafficCapturedEvidence {
  projectId: string;
  trafficId: string;
  generation: string;
  capturedAt: string;
  request: {
    origin: string;
    method: string;
    path: string;
    query: QueryParseResult;
  };
  response: {
    identity: string;
    status: number;
    headers: HeaderTuple[];
    contentEncoding:
      | { ok: true; value?: string }
      | { ok: false; reason: 'invalid_content_encoding' };
    body: TrafficBodyDescriptor;
  };
}

export interface TrafficAcceptedSnapshot extends Omit<TrafficCapturedEvidence, 'request' | 'response'> {
  request: Omit<TrafficCapturedEvidence['request'], 'query'> & { query: QueryEntry[] };
  response: Omit<TrafficCapturedEvidence['response'], 'body' | 'contentEncoding'> & {
    contentEncoding: { ok: true; value?: string };
    body: Extract<TrafficBodyDescriptor, { state: 'available' }>;
  };
  acceptedAt: string;
}

export interface TrafficQuery {
  afterId?: string;
  beforeId?: string;
  limit?: number;
}

export interface TrafficPage {
  entries: TrafficSummary[];
  latestId?: string;
  hasMore: boolean;
  reset?: boolean;
}

export interface TrafficBeginInput {
  projectId: string;
  requestId: string;
  transport: TrafficTransport;
  allowlistPattern: string;
  origin: NormalizedOrigin;
  method: string;
  path: string;
  query: QueryParseResult;
  headers: readonly HeaderTuple[];
  appState: TrafficAppStateContext;
}

export interface TrafficExchange {
  readonly trafficId: string;
  readonly generation: string;
  observeRequest(bytes: Uint8Array): void;
  abandonRequest(reason: TrafficBodyUnavailableReason): void;
  completeRequest(): Promise<TrafficBodyDescriptor>;
  setDecision(decision: TrafficRoutingEvidence): void;
  setResponse(status: number, headers: HeaderTuple[]): void;
  observeResponse(bytes: Uint8Array): void;
  completeResponse(): Promise<TrafficBodyDescriptor>;
  finalize(outcome: TrafficTerminalOutcome): Promise<TrafficStoredDetail>;
}

export interface TrafficOutcomeBuilder {
  readonly trafficId: string;
  readonly generation: string;
  observeRequestPreview(bytes: Uint8Array): void;
  setRequestDescriptor(descriptor: TrafficBodyDescriptor): void;
  setDecision(decision: TrafficRoutingEvidence): void;
  setResponse(status: number, headers: readonly HeaderTuple[]): void;
  observeResponsePreview(bytes: Uint8Array): void;
  setResponseDescriptor(descriptor: TrafficBodyDescriptor): void;
  /** Replace request preview bytes used at finalize (decoded display path). */
  setRequestPreviewOverride(bytes: Uint8Array, truncated?: boolean): void;
  /** Replace response preview bytes used at finalize (decoded display path). */
  setResponsePreviewOverride(bytes: Uint8Array, truncated?: boolean): void;
  finalize(outcome: TrafficTerminalOutcome): TrafficStoredDetail;
}

interface TrafficRowCapturedSnapshot {
  projectId: string;
  trafficId: string;
  generation: string;
  detail: Readonly<TrafficStoredDetail>;
  captured: Readonly<TrafficCapturedEvidence>;
}

export interface TrafficRowLeaseSnapshot {
  projectId: string;
  trafficId: string;
  generation: string;
  detail: Readonly<TrafficStoredDetail>;
  accepted: Readonly<TrafficAcceptedSnapshot>;
}

export interface TrafficStore {
  registerGeneration(projectId: string, trafficId: string, generation: string): void;
  append(detail: TrafficStoredDetail, captured: TrafficCapturedEvidence): Promise<boolean>;
  list(projectId: string, query?: TrafficQuery): TrafficPage;
  get(projectId: string, trafficId: string): TrafficStoredDetail | undefined;
  updateBody(
    projectId: string,
    trafficId: string,
    generation: string,
    side: 'request' | 'response',
    descriptor: TrafficBodyDescriptor,
  ): boolean;
  snapshotForAcceptance(
    projectId: string,
    trafficId: string,
    generation: string,
  ): TrafficRowCapturedSnapshot | undefined;
  attachPromotion(
    projectId: string,
    trafficId: string,
    generation: string,
    result: TrafficPromotionResult,
  ): boolean;
  clear(projectId: string): Promise<void>;
}
