import { describe, expect, it } from 'vitest';

import { normalizeHttpOrigin } from '../domain/http-origin';
import type {
  TrafficAppStateContext,
  TrafficBodyDescriptor,
  TrafficRoutingEvidence,
  TrafficTerminalOutcome,
} from '../domain/traffic';
import { TRAFFIC_LIMITS } from '../domain/traffic';
import { createTrafficOutcomeBuilder } from './traffic-outcome';

const availableRequest: TrafficBodyDescriptor = {
  side: 'request',
  state: 'available',
  mediaType: 'application/json',
  observedSize: 2,
  retainedSize: 2,
  sha256: 'a'.repeat(64),
};
const availableResponse: TrafficBodyDescriptor = {
  side: 'response',
  state: 'available',
  mediaType: 'application/json',
  observedSize: 2,
  retainedSize: 2,
  sha256: 'b'.repeat(64),
};
const configuredContext: TrafficAppStateContext = {
  mode: 'enabled',
  activeStateId: 'state_active',
  fallbackReasons: [],
};

function context(overrides: Partial<TrafficAppStateContext> = {}): TrafficAppStateContext {
  return { ...configuredContext, ...overrides };
}

function endpoint(mode: 'mock' | 'passthrough') {
  return {
    id: `endpoint_${mode}`,
    name: `Selected ${mode}`,
    specificity: mode === 'mock' ? 321 : 123,
    mode,
  } as const;
}

function builder(options: {
  queryInvalid?: boolean;
  appStateContext?: TrafficAppStateContext;
  previewBytes?: number;
} = {}) {
  const identifiers = ['traffic_1', 'generation_1'];
  const times = [1_788_220_800_000, 1_788_220_800_025];
  return createTrafficOutcomeBuilder({
    projectId: 'project_1',
    requestId: 'request_1',
    now: () => times.shift() ?? 1_788_220_800_025,
    id: () => identifiers.shift() ?? 'unexpected_id',
    transport: 'https_mitm',
    allowlistPattern: '*.example.test',
    origin: normalizeHttpOrigin('https://api.example.test'),
    method: 'POST',
    path: '/v1/users',
    query: options.queryInvalid
      ? { ok: false, reason: 'query_parse_invalid' }
      : {
        ok: true,
        entries: [
          { name: 'tag', value: 'one' },
          { name: 'tag', value: 'two' },
          { name: 'access_token', value: 'query-credential' },
        ],
      },
    headers: [
      ['authorization', 'Bearer request-credential'],
      ['x-request', 'one'],
      ['x-request', 'two'],
    ],
    appStateContext: options.appStateContext ?? configuredContext,
    previewBytes: options.previewBytes ?? TRAFFIC_LIMITS.previewBytes,
  });
}

function finalize(options: {
  decision: TrafficRoutingEvidence;
  terminal?: TrafficTerminalOutcome;
  queryInvalid?: boolean;
  contentEncoding?: string;
  appStateContext?: TrafficAppStateContext;
}) {
  const outcome = builder({
    queryInvalid: options.queryInvalid,
    appStateContext: options.appStateContext,
  });
  outcome.observeRequestPreview(Buffer.from('{}'));
  outcome.setRequestDescriptor(availableRequest);
  outcome.setDecision(options.decision);
  outcome.setResponse(201, [
    ['content-type', 'application/json'],
    ...(options.contentEncoding === undefined
      ? []
      : [['content-encoding', options.contentEncoding] as const]),
    ['set-cookie', 'session=exact-secret'],
    ['set-cookie', 'theme=dark'],
    ['x-response', 'one'],
  ]);
  outcome.observeResponsePreview(Buffer.from('{}'));
  outcome.setResponseDescriptor({
    ...availableResponse,
    ...(options.contentEncoding === undefined
      ? {}
      : { contentEncoding: options.contentEncoding }),
  });
  return { outcome, detail: outcome.finalize(options.terminal ?? {
    kind: 'response',
    status: 201,
    responseBytes: 2,
  }) };
}

describe('Traffic outcome builder', () => {
  it('uses the injected exact and +1 preview boundaries for request and response projections', () => {
    const exact = builder({ previewBytes: 3 });
    exact.observeRequestPreview(Buffer.from('abc'));
    exact.setRequestDescriptor({
      side: 'request', state: 'available', mediaType: 'text/plain', observedSize: 3,
      retainedSize: 3, sha256: 'c'.repeat(64),
    });
    exact.setDecision({ decision: 'no_match_passthrough', appState: configuredContext });
    exact.setResponse(200, [['content-type', 'text/plain']]);
    exact.observeResponsePreview(Buffer.from('abc'));
    exact.setResponseDescriptor({
      side: 'response', state: 'available', mediaType: 'text/plain', observedSize: 3,
      retainedSize: 3, sha256: 'd'.repeat(64),
    });
    const exactDetail = exact.finalize({ kind: 'response', status: 200, responseBytes: 3 });
    expect(exactDetail.request.preview).toEqual({
      encoding: 'utf8', value: 'abc', truncated: false,
    });
    expect(exactDetail.response.preview).toEqual({
      encoding: 'utf8', value: 'abc', truncated: false,
    });

    const outcome = builder({ previewBytes: 3 });
    outcome.observeRequestPreview(Buffer.from('abc'));
    outcome.observeRequestPreview(Buffer.from('d'));
    outcome.setRequestDescriptor({
      side: 'request',
      state: 'available',
      mediaType: 'text/plain',
      observedSize: 4,
      retainedSize: 4,
      sha256: 'a'.repeat(64),
    });
    outcome.setDecision({ decision: 'no_match_passthrough', appState: configuredContext });
    outcome.setResponse(200, [['content-type', 'text/plain']]);
    outcome.observeResponsePreview(Buffer.from('abc'));
    outcome.observeResponsePreview(Buffer.from('d'));
    outcome.setResponseDescriptor({
      side: 'response',
      state: 'available',
      mediaType: 'text/plain',
      observedSize: 4,
      retainedSize: 4,
      sha256: 'b'.repeat(64),
    });

    const detail = outcome.finalize({ kind: 'response', status: 200, responseBytes: 4 });

    expect(detail.request.preview).toEqual({ encoding: 'utf8', value: 'abc', truncated: true });
    expect(detail.response.preview).toEqual({ encoding: 'utf8', value: 'abc', truncated: true });
  });

  it('uses the injected UTF-8 boundary without exposing a partial multibyte code point', () => {
    const exact = builder({ previewBytes: 3 });
    const exactBytes = Buffer.from('a¢');
    exact.observeRequestPreview(exactBytes);
    exact.setRequestDescriptor({
      side: 'request', state: 'available', mediaType: 'text/plain', observedSize: 3,
      retainedSize: 3, sha256: 'a'.repeat(64),
    });
    exact.setResponse(200, [['content-type', 'text/plain']]);
    exact.observeResponsePreview(exactBytes);
    exact.setResponseDescriptor({
      side: 'response', state: 'available', mediaType: 'text/plain', observedSize: 3,
      retainedSize: 3, sha256: 'b'.repeat(64),
    });
    const exactDetail = exact.finalize({ kind: 'response', status: 200, responseBytes: 3 });
    expect(exactDetail.request.preview).toEqual({ encoding: 'utf8', value: 'a¢', truncated: false });
    expect(exactDetail.response.preview).toEqual({ encoding: 'utf8', value: 'a¢', truncated: false });

    const crossed = builder({ previewBytes: 3 });
    const crossedBytes = Buffer.from('ab¢');
    crossed.observeRequestPreview(crossedBytes);
    crossed.setRequestDescriptor({
      side: 'request', state: 'available', mediaType: 'text/plain', observedSize: 4,
      retainedSize: 4, sha256: 'c'.repeat(64),
    });
    crossed.setResponse(200, [['content-type', 'text/plain']]);
    crossed.observeResponsePreview(crossedBytes);
    crossed.setResponseDescriptor({
      side: 'response', state: 'available', mediaType: 'text/plain', observedSize: 4,
      retainedSize: 4, sha256: 'd'.repeat(64),
    });
    const crossedDetail = crossed.finalize({ kind: 'response', status: 200, responseBytes: 4 });
    expect(crossedDetail.request.preview).toEqual({ encoding: 'utf8', value: 'ab', truncated: true });
    expect(crossedDetail.response.preview).toEqual({ encoding: 'utf8', value: 'ab', truncated: true });
  });

  it.each([
    {
      name: 'mock active state',
      appState: context({ selectedStateId: 'state_active', resolutionSource: 'project_active_state' }),
      decision: 'mock' as const,
      selectedStateId: 'state_active',
    },
    {
      name: 'mock while app state is disabled',
      appState: context({
        mode: 'disabled',
        selectedStateId: undefined,
        resolutionSource: 'endpoint_default',
        fallbackReasons: ['app_state_mode_disabled'],
      }),
      decision: 'mock' as const,
      selectedStateId: undefined,
    },
  ])('preserves Task 4 evidence for $name', ({ appState, decision, selectedStateId }) => {
    const selectedEndpoint = endpoint('mock');
    const { detail } = finalize({
      decision: {
        decision,
        endpoint: selectedEndpoint,
        variantId: 'variant_1',
        bodyAssetId: 'asset_1',
        appState,
      },
    });

    expect(detail.endpoint).toEqual(selectedEndpoint);
    expect(detail.appState).toEqual(appState);
    expect(detail.appState.selectedStateId).toBe(selectedStateId);
    expect(detail.variantId).toBe('variant_1');
    expect(detail.bodyAssetId).toBe('asset_1');
  });

  it.each([
    {
      name: 'endpoint passthrough',
      decision: {
        decision: 'endpoint_passthrough' as const,
        endpoint: endpoint('passthrough'),
        appState: configuredContext,
      },
      expectedDecision: 'endpoint_passthrough',
      endpointExpected: true,
    },
    {
      name: 'no-match passthrough',
      decision: {
        decision: 'no_match_passthrough' as const,
        appState: configuredContext,
      },
      expectedDecision: 'no_match_passthrough',
      endpointExpected: false,
    },
    {
      name: 'direct miss',
      decision: { decision: 'direct_miss' as const, appState: configuredContext },
      expectedDecision: 'direct_miss',
      endpointExpected: false,
    },
    {
      name: 'matched direct passthrough unavailable',
      decision: {
        decision: 'direct_passthrough_unavailable' as const,
        endpoint: endpoint('passthrough'),
        appState: configuredContext,
      },
      expectedDecision: 'direct_passthrough_unavailable',
      endpointExpected: true,
    },
  ])('records $name without selecting an App State', ({ decision, expectedDecision, endpointExpected }) => {
    const { detail } = finalize({ decision });

    expect(detail.decision).toBe(expectedDecision);
    expect(detail.appState).toEqual(configuredContext);
    expect(detail.appState).not.toHaveProperty('selectedStateId');
    expect(detail.endpoint).toEqual(endpointExpected && 'endpoint' in decision
      ? decision.endpoint
      : undefined);
  });

  it('redacts public query/header evidence while retaining order and repeated headers', () => {
    const { detail } = finalize({
      decision: { decision: 'no_match_passthrough', appState: configuredContext },
    });
    const serialized = JSON.stringify(detail);

    expect(detail.request.query).toEqual([
      { name: 'tag', value: 'one' },
      { name: 'tag', value: 'two' },
      { name: 'access_token', value: '[REDACTED]' },
    ]);
    expect(detail.queryNames).toEqual([
      { name: 'tag', occurrenceCount: 2, sensitive: false },
      { name: 'access_token', occurrenceCount: 1, sensitive: true },
    ]);
    expect(detail.request.headers).toEqual([
      ['authorization', '[REDACTED]'],
      ['x-request', 'one'],
      ['x-request', 'two'],
    ]);
    expect(detail.response.headers).toEqual([
      ['content-type', 'application/json'],
      ['set-cookie', '[REDACTED]'],
      ['set-cookie', '[REDACTED]'],
      ['x-response', 'one'],
    ]);
    expect(serialized).not.toContain('query-credential');
    expect(serialized).not.toContain('request-credential');
    expect(serialized).not.toContain('exact-secret');
    expect(detail.path).toBe('/v1/users');
    expect(detail.origin).toBe('https://api.example.test');
  });

  it('snapshots the accepted routing evidence when the decision is set', () => {
    const outcome = builder();
    const selectedEndpoint = { ...endpoint('mock') };
    const appState = context({
      selectedStateId: 'state_active',
      resolutionSource: 'project_active_state',
    });
    const decision: TrafficRoutingEvidence = {
      decision: 'mock',
      endpoint: selectedEndpoint,
      variantId: 'variant_accepted',
      appState,
    };
    outcome.setRequestDescriptor(availableRequest);
    outcome.setDecision(decision);
    outcome.setResponse(200, []);
    outcome.setResponseDescriptor(availableResponse);

    selectedEndpoint.name = 'mutated after acceptance';
    appState.selectedStateId = 'state_mutated';
    appState.fallbackReasons.push('active_state_unbound');
    const detail = outcome.finalize({ kind: 'response', status: 200, responseBytes: 2 });

    expect(detail.endpoint?.name).toBe('Selected mock');
    expect(detail.appState.selectedStateId).toBe('state_active');
    expect(detail.appState.fallbackReasons).toEqual([]);
  });

  it('snapshots normalized request evidence when the builder begins', () => {
    const queryEntries = [{ name: 'tag', value: 'accepted' }];
    const headers: Array<readonly [string, string]> = [['x-request', 'accepted']];
    const identifiers = ['traffic_snapshot', 'generation_snapshot'];
    const times = [1_788_220_800_000, 1_788_220_800_001];
    const outcome = createTrafficOutcomeBuilder({
      projectId: 'project_1',
      requestId: 'request_1',
      now: () => times.shift() ?? 1_788_220_800_001,
      id: () => identifiers.shift() ?? 'unexpected_id',
      transport: 'direct',
      allowlistPattern: 'direct',
      origin: normalizeHttpOrigin('https://api.example.test'),
      method: 'GET',
      path: '/accepted',
      query: { ok: true, entries: queryEntries },
      headers,
      appStateContext: configuredContext,
      previewBytes: TRAFFIC_LIMITS.previewBytes,
    });
    queryEntries[0].value = 'mutated';
    headers[0] = ['x-request', 'mutated'];
    outcome.setDecision({ decision: 'direct_miss', appState: configuredContext });
    outcome.setResponse(404, []);

    const detail = outcome.finalize({ kind: 'response', status: 404, responseBytes: 0 });

    expect(detail.request.query).toEqual([{ name: 'tag', value: 'accepted' }]);
    expect(detail.request.headers).toEqual([['x-request', 'accepted']]);
  });

  it('blocks malformed query evidence even with an available exact response', () => {
    const { detail } = finalize({
      queryInvalid: true,
      decision: {
        decision: 'no_match_passthrough',
        reason: 'query_parse_invalid',
        appState: configuredContext,
      },
    });

    expect(detail.routingReason).toBe('query_parse_invalid');
    expect(detail.request.query).toEqual([]);
    expect(detail.promotion).toEqual({ state: 'blocked', reason: 'query_parse_invalid' });
    expect(detail).not.toHaveProperty('review');
    expect(detail).not.toHaveProperty('captured');
    expect(detail).not.toHaveProperty('accepted');
  });

  it('publishes invalid query provenance when the routing decision omits its optional reason', () => {
    const { detail } = finalize({
      queryInvalid: true,
      decision: {
        decision: 'no_match_passthrough',
        appState: configuredContext,
      },
    });

    expect(detail.routingReason).toBe('query_parse_invalid');
    expect(detail.promotion).toEqual({ state: 'blocked', reason: 'query_parse_invalid' });
  });

  it('blocks malformed Content-Encoding without projecting the unsafe normalization', () => {
    const unsafeEncoding = 'gzip; credential=/Users/alice/private.key';
    const { detail } = finalize({
      contentEncoding: unsafeEncoding,
      decision: { decision: 'no_match_passthrough', appState: configuredContext },
    });

    expect(detail.promotion).toEqual({ state: 'blocked', reason: 'invalid_content_encoding' });
    expect(detail.response.body).not.toHaveProperty('contentEncoding');
    expect(detail.response.headers).not.toContainEqual(['content-encoding', unsafeEncoding]);
    expect(JSON.stringify(detail)).not.toContain(unsafeEncoding);
    expect(detail).not.toHaveProperty('review');
    expect(detail).not.toHaveProperty('accepted');
  });

  it('projects valid Content-Encoding headers only in normalized form', () => {
    const rawEncoding = 'GZip, identity';
    const { detail } = finalize({
      contentEncoding: rawEncoding,
      decision: { decision: 'no_match_passthrough', appState: configuredContext },
    });

    expect(detail.response.headers).toContainEqual(['content-encoding', 'gzip']);
    expect(detail.response.body).toMatchObject({ contentEncoding: 'gzip' });
    expect(JSON.stringify(detail)).not.toContain(rawEncoding);
  });

  it.each([
    {
      name: 'routing failure',
      decision: { decision: 'failure', reason: 'Authority rejected', appState: configuredContext } as const,
      terminal: { kind: 'response', status: 400, responseBytes: 2 } as const,
      reason: 'request_failed',
    },
    {
      name: 'terminal failure',
      decision: { decision: 'no_match_passthrough', appState: configuredContext } as const,
      terminal: {
        kind: 'failure', status: 502, responseBytes: 2,
        failure: { code: 'UPSTREAM_FAILURE', message: 'Upstream request failed' },
      } as const,
      reason: 'request_failed',
    },
    {
      name: 'terminal cancellation',
      decision: { decision: 'no_match_passthrough', appState: configuredContext } as const,
      terminal: { kind: 'cancelled', status: 499, responseBytes: 2 } as const,
      reason: 'request_cancelled',
    },
  ])('blocks $name even when exact response evidence is available', ({ decision, terminal, reason }) => {
    const { detail } = finalize({ decision, terminal });

    expect(detail.response.body.state).toBe('available');
    expect(detail.promotion).toEqual({ state: 'blocked', reason });
  });

  it.each([
    {
      name: 'redaction-only response evidence',
      descriptor: {
        side: 'response', state: 'unavailable', observedSize: 2,
        reason: 'raw_capture_disabled',
      } as const,
      reason: 'body_unavailable',
    },
    {
      name: 'truncated response evidence',
      descriptor: {
        side: 'response', state: 'truncated', observedSize: 3,
        reason: 'body_limit_exceeded',
      } as const,
      reason: 'body_truncated',
    },
  ])('blocks $name', ({ descriptor, reason }) => {
    const outcome = builder();
    outcome.setRequestDescriptor(availableRequest);
    outcome.setDecision({ decision: 'no_match_passthrough', appState: configuredContext });
    outcome.setResponse(200, [['content-type', 'application/json']]);
    outcome.setResponseDescriptor(descriptor);

    const detail = outcome.finalize({ kind: 'response', status: 200, responseBytes: 2 });

    expect(detail.promotion).toEqual({ state: 'blocked', reason });
  });

  it('records authority failure and sanitizes upstream failure credentials and paths', () => {
    const terminal: TrafficTerminalOutcome = {
      kind: 'failure',
      status: 502,
      responseBytes: 0,
      failure: {
        code: 'UPSTREAM_CONNECT_FAILED',
        message: 'connect https://admin:password@api.example.test via /Users/alice/client.pem',
      },
    };
    const { detail } = finalize({
      decision: {
        decision: 'failure',
        reason: 'Proxy authority https://admin:password@api.example.test/private is invalid',
        appState: configuredContext,
      },
      terminal,
    });
    const serialized = JSON.stringify(detail);

    expect(detail.decision).toBe('failure');
    expect(detail.status).toBe(502);
    expect(detail.upstream?.failure?.code).toBe('UPSTREAM_CONNECT_FAILED');
    expect(serialized).not.toContain('admin');
    expect(serialized).not.toContain('password');
    expect(serialized).not.toContain('/Users/alice');
  });

  it.each([
    ['open /etc/ssl/private/key.pem failed', 'open [path] failed'],
    ['write /tmp/mockmate-secret failed', 'write [path] failed'],
    ['read /var/run/mockmate.sock failed', 'read [path] failed'],
    ["open '/etc/ssl/private/key.pem' failed", "open '[path]' failed"],
    ['write "/tmp/mockmate-secret" failed', 'write "[path]" failed'],
    ['read [/var/run/mockmate.sock] failed', 'read [path] failed'],
    [
      'GET https://api.example.test/users?token=secret&retry=1 failed',
      'GET https://api.example.test/users?token=[REDACTED]&retry=1 failed',
    ],
    [
      'GET https://api.example.test/token?refresh_token=secret&retry=1 failed',
      'GET https://api.example.test/token?refresh_token=[REDACTED]&retry=1 failed',
    ],
    [
      'GET https://api.example.test/client?clientCredentialId=secret&retry=1 failed',
      'GET https://api.example.test/client?clientCredentialId=[REDACTED]&retry=1 failed',
    ],
    [
      'GET https://api.example.test/key?privateKey=secret&retry=1 failed',
      'GET https://api.example.test/key?privateKey=[REDACTED]&retry=1 failed',
    ],
    [
      'GET https://api.example.test/session?sessionAuthCode=secret&traceId=safe failed',
      'GET https://api.example.test/session?sessionAuthCode=[REDACTED]&traceId=safe failed',
    ],
    ['upstream reset by peer', 'upstream reset by peer'],
  ])('sanitizes failure message %s without discarding safe context', (message, expected) => {
    const { detail } = finalize({
      decision: { decision: 'no_match_passthrough', appState: configuredContext },
      terminal: {
        kind: 'failure',
        status: 502,
        responseBytes: 0,
        failure: { code: 'UPSTREAM_FAILED', message },
      },
    });

    expect(detail.upstream?.failure?.message).toBe(expected);
  });

  it('finalizes exactly once with deterministic timing and bounded evidence', () => {
    const { outcome, detail } = finalize({
      decision: { decision: 'no_match_passthrough', appState: configuredContext },
      terminal: { kind: 'response', status: 202, responseBytes: 2, upstreamStatus: 204 },
    });

    expect(detail).toMatchObject({
      id: 'traffic_1',
      generation: 'generation_1',
      projectId: 'project_1',
      requestId: 'request_1',
      startedAt: '2026-09-01T00:00:00.000Z',
      completedAt: '2026-09-01T00:00:00.025Z',
      durationMs: 25,
      status: 202,
      responseBytes: 2,
      upstream: { status: 204 },
      captureState: 'complete',
      promotion: { state: 'eligible' },
      requestBodyState: 'available',
      responseBodyState: 'available',
    });
    expect(detail.promotion).not.toHaveProperty('review');
    expect(() => outcome.finalize({ kind: 'cancelled', status: 499, responseBytes: 0 }))
      .toThrow('Traffic outcome already finalized');
  });
});
