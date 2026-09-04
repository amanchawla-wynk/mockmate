import {
  projectContentEncoding,
  type ContentEncodingProjection,
} from '../domain/http-metadata';
import { isSensitiveQueryName, redactTrafficHeaders, redactTrafficQuery } from '../domain/traffic-redaction';
import {
  TrafficBodyDescriptorSchema,
  createTrafficPreview,
  type TrafficAppStateContext,
  type TrafficBodyDescriptor,
  type TrafficOutcomeBuilder,
  type TrafficRoutingEvidence,
  type TrafficStoredDetail,
  type TrafficTerminalOutcome,
} from '../domain/traffic';
import type { NormalizedOrigin } from '../domain/http-origin';
import type { QueryParseResult } from '../domain/query-matcher';
import type { HeaderTuple } from './upstream-transport';

interface PreviewAccumulator {
  chunks: Buffer[];
  retainedBytes: number;
}

function appendPreview(accumulator: PreviewAccumulator, bytes: Uint8Array, previewBytes: number): void {
  const remaining = previewBytes + 1 - accumulator.retainedBytes;
  if (remaining <= 0 || bytes.byteLength === 0) return;
  const retained = Buffer.from(bytes).subarray(0, remaining);
  accumulator.chunks.push(retained);
  accumulator.retainedBytes += retained.byteLength;
}

function cloneAppState(context: TrafficAppStateContext): TrafficAppStateContext {
  return { ...context, fallbackReasons: [...context.fallbackReasons] };
}

function publicAppState(decision: TrafficRoutingEvidence): TrafficAppStateContext {
  const appState = cloneAppState(decision.appState);
  if (decision.decision !== 'mock') {
    delete appState.selectedStateId;
    delete appState.resolutionSource;
  }
  return appState;
}

function cloneDecision(decision: TrafficRoutingEvidence): TrafficRoutingEvidence {
  const appState = cloneAppState(decision.appState);
  if (decision.decision === 'mock') {
    return { ...decision, endpoint: { ...decision.endpoint }, appState };
  }
  if (decision.decision === 'endpoint_passthrough'
    || decision.decision === 'direct_passthrough_unavailable') {
    return { ...decision, endpoint: { ...decision.endpoint }, appState };
  }
  return { ...decision, appState };
}

function queryNames(query: QueryParseResult): TrafficStoredDetail['queryNames'] {
  if (!query.ok) return [];
  const counts = new Map<string, number>();
  for (const entry of query.entries) counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1);
  return [...counts].map(([name, occurrenceCount]) => ({
    name,
    occurrenceCount,
    sensitive: isSensitiveQueryName(name),
  }));
}

function publicEntityHeaders(
  headers: readonly HeaderTuple[],
  encoding: ContentEncodingProjection,
): HeaderTuple[] {
  let encodingProjected = false;
  const projected: HeaderTuple[] = [];
  for (const [name, value] of headers) {
    if (name.toLowerCase() !== 'content-encoding') {
      projected.push([name, value]);
      continue;
    }
    if (!encodingProjected && encoding.valid && encoding.value !== undefined) {
      projected.push(['content-encoding', encoding.value]);
    }
    encodingProjected = true;
  }
  return projected;
}

function publicBodyDescriptor(
  descriptor: TrafficBodyDescriptor,
  encoding: ContentEncodingProjection,
): TrafficBodyDescriptor {
  const publicDescriptor = { ...descriptor };
  delete publicDescriptor.contentEncoding;
  if (encoding.valid && encoding.value !== undefined) {
    publicDescriptor.contentEncoding = encoding.value;
  }
  return TrafficBodyDescriptorSchema.parse(publicDescriptor);
}

function promotionState(input: {
  query: QueryParseResult;
  encodingValid: boolean;
  decision: TrafficRoutingEvidence;
  outcome: TrafficTerminalOutcome;
  responseDescriptor?: TrafficBodyDescriptor;
}): TrafficStoredDetail['promotion'] {
  if (!input.query.ok) return { state: 'blocked', reason: 'query_parse_invalid' };
  if (!input.encodingValid) return { state: 'blocked', reason: 'invalid_content_encoding' };
  if (input.decision.decision === 'failure' || input.outcome.kind === 'failure') {
    return { state: 'blocked', reason: 'request_failed' };
  }
  if (input.outcome.kind === 'cancelled') {
    return { state: 'blocked', reason: 'request_cancelled' };
  }
  if (input.responseDescriptor?.state === 'available') return { state: 'eligible' };
  if (input.responseDescriptor?.state === 'truncated') {
    return { state: 'blocked', reason: 'body_truncated' };
  }
  if (input.responseDescriptor?.state === 'evicted') {
    return { state: 'blocked', reason: 'body_evicted' };
  }
  return { state: 'blocked', reason: 'body_unavailable' };
}

function sanitizeFailureMessage(message: string): string {
  return message
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, '$1')
    .replace(/\b(Bearer|Basic)\s+\S+/gi, '$1 [REDACTED]')
    .replace(/([?&])([^=&#\s]+)=([^&#\s]*)/g, (field, separator, rawName) => {
      let name = rawName;
      try {
        name = decodeURIComponent(rawName.replaceAll('+', ' '));
      } catch {
        // Classify malformed names conservatively from their original spelling.
      }
      return isSensitiveQueryName(name)
        ? `${separator}${rawName}=[REDACTED]`
        : field;
    })
    .replace(/\[\/(?!\/)[^\]\r\n]*\]/g, '[path]')
    .replace(/(['"])\/(?!\/)[^'"\r\n]*\1/g, (_path, quote) => `${quote}[path]${quote}`)
    .replace(/[A-Za-z]:\\[^\s,;)]*/g, '[path]')
    .replace(/(^|[\s(=:])\/(?!\/)[^\s,;)]*/g, '$1[path]');
}

function unavailableDescriptor(
  side: 'request' | 'response',
  observedSize: number,
): TrafficBodyDescriptor {
  return {
    side,
    state: 'unavailable',
    observedSize,
    reason: 'body_unobservable',
  };
}

export function createTrafficOutcomeBuilder(input: {
  projectId: string;
  requestId: string;
  now(): number;
  id(): string;
  transport: 'direct' | 'plain_http_proxy' | 'https_mitm';
  allowlistPattern: string;
  origin: NormalizedOrigin;
  method: string;
  path: string;
  query: QueryParseResult;
  headers: readonly HeaderTuple[];
  appStateContext: TrafficAppStateContext;
  previewBytes: number;
}): TrafficOutcomeBuilder {
  const trafficId = input.id();
  const generation = input.id();
  const startedAtMs = input.now();
  const origin = input.origin.origin;
  const requestQuery: QueryParseResult = input.query.ok
    ? { ok: true, entries: input.query.entries.map(entry => ({ ...entry })) }
    : { ...input.query };
  const requestHeaders: HeaderTuple[] = input.headers.map(([name, value]) => [name, value]);
  const requestEncoding = projectContentEncoding(requestHeaders);
  const appStateContext = cloneAppState(input.appStateContext);
  const requestPreview: PreviewAccumulator = { chunks: [], retainedBytes: 0 };
  const responsePreview: PreviewAccumulator = { chunks: [], retainedBytes: 0 };
  let requestPreviewOverride: { bytes: Buffer; truncated: boolean } | undefined;
  let responsePreviewOverride: { bytes: Buffer; truncated: boolean } | undefined;
  let requestDescriptor: TrafficBodyDescriptor | undefined;
  let responseDescriptor: TrafficBodyDescriptor | undefined;
  let decision: TrafficRoutingEvidence | undefined;
  let responseHeaders: HeaderTuple[] = [];
  let responseEncoding: ContentEncodingProjection = { valid: true };
  let finalized = false;

  function buildPreview(
    override: { bytes: Buffer; truncated: boolean } | undefined,
    accumulator: PreviewAccumulator,
    body: TrafficBodyDescriptor,
  ) {
    const source = override?.bytes ?? Buffer.concat(accumulator.chunks);
    if (source.byteLength === 0) return {};
    const preview = createTrafficPreview(
      source, body, body.mediaType, input.previewBytes,
    );
    return {
      preview: override?.truncated ? { ...preview, truncated: true } : preview,
    };
  }

  return {
    trafficId,
    generation,
    observeRequestPreview(bytes) {
      appendPreview(requestPreview, bytes, input.previewBytes);
    },
    setRequestDescriptor(descriptor) {
      if (descriptor.side !== 'request') throw new TypeError('Expected a request body descriptor');
      requestDescriptor = publicBodyDescriptor(descriptor, requestEncoding);
    },
    setDecision(value) {
      if (decision !== undefined) throw new Error('Traffic routing decision already set');
      decision = cloneDecision(value);
    },
    setResponse(_status, headers) {
      responseHeaders = headers.map(([name, value]) => [name, value]);
      responseEncoding = projectContentEncoding(responseHeaders);
    },
    observeResponsePreview(bytes) {
      appendPreview(responsePreview, bytes, input.previewBytes);
    },
    setResponseDescriptor(descriptor) {
      if (descriptor.side !== 'response') throw new TypeError('Expected a response body descriptor');
      responseDescriptor = publicBodyDescriptor(descriptor, responseEncoding);
    },
    setRequestPreviewOverride(bytes, truncated = false) {
      requestPreviewOverride = { bytes: Buffer.from(bytes), truncated };
    },
    setResponsePreviewOverride(bytes, truncated = false) {
      responsePreviewOverride = { bytes: Buffer.from(bytes), truncated };
    },
    finalize(outcome: TrafficTerminalOutcome) {
      if (finalized) throw new Error('Traffic outcome already finalized');
      finalized = true;

      const completedAtMs = input.now();
      const selectedDecision = decision ?? {
        decision: 'failure',
        reason: 'Routing decision unavailable',
        appState: appStateContext,
      };
      const requestBody = requestDescriptor
        ?? unavailableDescriptor('request', requestPreview.retainedBytes);
      const responseBody = responseDescriptor
        ?? unavailableDescriptor('response', responsePreview.retainedBytes);
      const publicRequestQuery = requestQuery.ok ? redactTrafficQuery(requestQuery.entries) : [];
      const detail: TrafficStoredDetail = {
        id: trafficId,
        generation,
        projectId: input.projectId,
        requestId: input.requestId,
        startedAt: new Date(startedAtMs).toISOString(),
        completedAt: new Date(completedAtMs).toISOString(),
        durationMs: Math.max(0, completedAtMs - startedAtMs),
        transport: input.transport,
        allowlistPattern: input.allowlistPattern,
        origin,
        method: input.method,
        path: input.path,
        queryNames: queryNames(requestQuery),
        ...('endpoint' in selectedDecision
          ? { endpoint: { ...selectedDecision.endpoint } }
          : {}),
        decision: selectedDecision.decision,
        ...(!requestQuery.ok
          ? { routingReason: requestQuery.reason }
          : {}),
        status: outcome.status,
        responseBytes: outcome.responseBytes,
        requestBodyState: requestBody.state,
        responseBodyState: responseBody.state,
        request: {
          query: publicRequestQuery,
          headers: redactTrafficHeaders(publicEntityHeaders(requestHeaders, requestEncoding)),
          ...buildPreview(requestPreviewOverride, requestPreview, requestBody),
          body: requestBody,
        },
        response: {
          headers: redactTrafficHeaders(publicEntityHeaders(responseHeaders, responseEncoding)),
          ...buildPreview(responsePreviewOverride, responsePreview, responseBody),
          body: responseBody,
        },
        appState: publicAppState(selectedDecision),
        ...(selectedDecision.decision === 'mock'
          ? {
            variantId: selectedDecision.variantId,
            ...(selectedDecision.bodyAssetId === undefined
              ? {}
              : { bodyAssetId: selectedDecision.bodyAssetId }),
          }
          : {}),
        ...(outcome.kind === 'response' && outcome.upstreamStatus !== undefined
          ? { upstream: { status: outcome.upstreamStatus } }
          : {}),
        ...(outcome.kind === 'failure'
          ? {
            upstream: {
              failure: {
                code: outcome.failure.code,
                message: sanitizeFailureMessage(outcome.failure.message),
              },
            },
          }
          : {}),
        captureState: requestDescriptor !== undefined && responseDescriptor !== undefined
          ? 'complete'
          : 'pending',
        promotion: promotionState({
          query: requestQuery,
          encodingValid: responseEncoding.valid,
          decision: selectedDecision,
          outcome,
          responseDescriptor,
        }),
      };
      return detail;
    },
  };
}
