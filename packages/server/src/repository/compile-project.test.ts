import { describe, expect, it } from 'vitest';

import { normalizeHttpOrigin } from '../domain/http-origin';
import { parseRawQuery } from '../domain/query-matcher';
import type { AppState, EndpointDetail, Project } from '../domain/model';
import {
  endpointRecord,
  projectRecord,
  settingsRecord,
  stateRecord,
} from '../test-support/project-builder';
import {
  calculateStateCoverage,
  canonicalEndpointIdentity,
  CompileProjectError,
  compileProject,
  matchRequest,
  resolveEndpoint,
  type MatchRequest,
} from './compile-project';
import type { ValidatedProjectSnapshot } from './snapshot';

function variant(id: string, endpointId: string, status = 200) {
  return {
    id,
    endpointId,
    name: id,
    status,
    responseHeaders: { 'x-variant': id, 'set-cookie': ['first=1', 'second=2'] },
    revision: 0,
  };
}

function endpoint(
  id: string,
  overrides: Partial<EndpointDetail> = {},
): EndpointDetail {
  const variants = overrides.variants ?? [variant(`var_${id}`, id)];
  return endpointRecord({
    id,
    baseUrl: 'https://api.example.test',
    matcher: { method: 'GET', path: '/profile' },
    mode: 'mock',
    variants,
    defaultVariantId: variants[0]?.id,
    ...overrides,
  });
}

function snapshot(options: {
  project?: Partial<Project>;
  endpoints?: EndpointDetail[];
  states?: AppState[];
} = {}): ValidatedProjectSnapshot {
  const endpoints = options.endpoints ?? [endpoint('ep_1', {
    variants: [
      variant('var_default', 'ep_1'),
      variant('var_base', 'ep_1', 201),
      variant('var_active', 'ep_1', 202),
    ],
    defaultVariantId: 'var_default',
  })];
  const states = options.states ?? [
    stateRecord({ id: 'state_base', bindings: { ep_1: 'var_base' } }),
    stateRecord({ id: 'state_active', bindings: { ep_1: 'var_active' } }),
  ];
  return {
    project: projectRecord(options.project),
    settings: settingsRecord(),
    endpoints: new Map(endpoints.map(value => [value.id, value])),
    states: new Map(states.map(value => [value.id, value])),
    bodyAssets: new Map(),
    generationId: 'gen_current',
  };
}

function request(overrides: Partial<MatchRequest> & { rawQuery?: string } = {}): MatchRequest {
  const { rawQuery = '', ...rest } = overrides;
  return {
    origin: normalizeHttpOrigin('https://api.example.test'),
    method: 'GET',
    path: '/profile',
    query: parseRawQuery(rawQuery),
    headers: {},
    ...rest,
  };
}

describe('canonical Endpoint identity', () => {
  it('normalizes origin, method, path, headers, and query expression order without deduping', () => {
    const left = endpointRecord({
      baseUrl: 'HTTPS://API.EXAMPLE.TEST:443/',
      matcher: {
        method: 'get',
        path: '/users/',
        query: { q: [
          { operator: 'glob', value: 'a*' },
          { operator: 'equals', value: 'alpha' },
          { operator: 'equals', value: 'alpha' },
        ] },
        headers: { 'X-Mode': { operator: 'equals', value: 'preview' } },
      },
    });
    const right = endpointRecord({
      baseUrl: 'https://api.example.test',
      matcher: {
        method: 'GET',
        path: '/users',
        query: { q: [
          { operator: 'equals', value: 'alpha' },
          { operator: 'equals', value: 'alpha' },
          { operator: 'glob', value: 'a*' },
        ] },
        headers: { 'x-mode': { operator: 'equals', value: 'preview' } },
      },
    });
    expect(canonicalEndpointIdentity(left)).toBe(canonicalEndpointIdentity(right));
  });

  it('rejects duplicate canonical identities', () => {
    const endpoints = [
      endpoint('ep_b', { matcher: { method: 'get', path: '/same/' } }),
      endpoint('ep_a', { matcher: { method: 'GET', path: '/same' } }),
    ];
    expect(() => compileProject(snapshot({ endpoints, states: [] }))).toThrowError(
      expect.objectContaining({ code: 'ENDPOINT_IDENTITY_CONFLICT' }),
    );
  });
});

describe('compiled matching and decisions', () => {
  it('requires exact normalized origin before considering other specificity', () => {
    const compiled = compileProject(snapshot({
      endpoints: [
        endpoint('ep_origin', {
          baseUrl: 'https://other.example.test',
          matcher: { method: 'GET', path: '/profile' },
        }),
        endpoint('ep_specific', {
          matcher: {
            method: 'GET',
            path: '/profile',
            query: { plan: [{ operator: 'equals', value: 'paid' }] },
          },
        }),
      ],
      states: [],
    }));
    expect(matchRequest(compiled, request({ rawQuery: 'plan=paid' }))).toMatchObject({
      endpointId: 'ep_specific',
    });
    expect(matchRequest(compiled, request({
      origin: normalizeHttpOrigin('https://other.example.test'),
      rawQuery: 'plan=paid',
    }))).toMatchObject({ endpointId: 'ep_origin' });
  });

  it('preserves repeated query constraints and applies injective exact/glob matching', () => {
    const compiled = compileProject(snapshot({
      endpoints: [endpoint('ep_multi', {
        matcher: {
          method: 'GET',
          path: '/profile',
          query: { q: [
            { operator: 'equals', value: 'alpha' },
            { operator: 'glob', value: 'a*' },
          ] },
        },
      })],
      states: [],
    }));
    expect(matchRequest(compiled, request({ rawQuery: 'q=alpha&q=amber' })))
      .toMatchObject({ endpointId: 'ep_multi' });
    expect(matchRequest(compiled, request({ rawQuery: 'q=alpha' }))).toBeNull();
    expect(matchRequest(compiled, request({ rawQuery: 'q=amber&q=beta' }))).toBeNull();
    expect(matchRequest(compiled, request({ query: { ok: false, reason: 'query_parse_invalid' } })))
      .toBeNull();
  });

  it('counts every repeated query expression in specificity', () => {
    const compiled = compileProject(snapshot({
      endpoints: [
        endpoint('ep_one', { matcher: {
          method: 'GET', path: '/profile',
          query: { q: [{ operator: 'glob', value: '*' }] },
        } }),
        endpoint('ep_two', { matcher: {
          method: 'GET', path: '/profile',
          query: { q: [
            { operator: 'glob', value: '*' },
            { operator: 'glob', value: '*' },
          ] },
        } }),
      ],
      states: [],
    }));
    expect(matchRequest(compiled, request({ rawQuery: 'q=a&q=b' })))
      .toMatchObject({ endpointId: 'ep_two' });
  });

  it('keeps distinct query/header constraints and stable Endpoint-ID ties', () => {
    const endpoints = [
      endpoint('ep_b', { matcher: {
        method: 'GET', path: '/profile',
        headers: { 'x-mode': { operator: 'equals', value: 'b' } },
      } }),
      endpoint('ep_a', { matcher: {
        method: 'GET', path: '/profile',
        headers: { 'x-mode': { operator: 'equals', value: 'a' } },
      } }),
    ];
    for (const ordered of [endpoints, [...endpoints].reverse()]) {
      const compiled = compileProject(snapshot({ endpoints: ordered, states: [] }));
      expect(matchRequest(compiled, request({ headers: { 'X-Mode': ['a'] } })))
        .toMatchObject({ endpointId: 'ep_a' });
      expect(matchRequest(compiled, request({ headers: { 'X-Mode': ['b'] } })))
        .toMatchObject({ endpointId: 'ep_b' });
    }
  });

  it.each([
    ['broader mock and specific passthrough', 'mock', 'passthrough'],
    ['broader passthrough and specific mock', 'passthrough', 'mock'],
  ] as const)('%s resolves the matching Endpoint mode', (_name, broadMode, specificMode) => {
    const compiled = compileProject(snapshot({
      endpoints: [
        endpoint('ep_broad', { mode: broadMode }),
        endpoint('ep_specific', {
          mode: specificMode,
          matcher: {
            method: 'GET', path: '/profile',
            query: { plan: [{ operator: 'equals', value: 'paid' }] },
          },
        }),
      ],
      states: [],
    }));
    const match = matchRequest(compiled, request({ rawQuery: 'plan=paid' }));
    if (!match) throw new Error('Expected a match');
    expect(resolveEndpoint(compiled, match)).toMatchObject({ kind: specificMode });
  });

  it('supports a passthrough Endpoint with zero Variants', () => {
    const compiled = compileProject(snapshot({
      endpoints: [endpoint('ep_pass', {
        mode: 'passthrough', variants: [], defaultVariantId: undefined,
      })],
      states: [],
    }));
    const match = matchRequest(compiled, request());
    if (!match) throw new Error('Expected a match');
    expect(resolveEndpoint(compiled, match)).toEqual({
      kind: 'passthrough',
      endpointId: 'ep_pass',
      endpointName: 'Get profile',
      specificity: match.specificity,
      endpointMode: 'passthrough',
      fallbackReasons: [],
    });
  });
});

describe('App State mode and compiled isolation', () => {
  it('uses the active state binding while enabled', () => {
    const compiled = compileProject(snapshot({
      project: { appStateMode: 'enabled', activeStateId: 'state_active' },
    }));
    const match = matchRequest(compiled, request());
    if (!match) throw new Error('Expected a match');
    expect(resolveEndpoint(compiled, match)).toMatchObject({
      kind: 'mock',
      resolved: {
        variantId: 'var_active',
        selectedStateId: 'state_active',
        resolutionSource: 'project_active_state',
        fallbackReasons: [],
      },
    });
  });

  it('ignores dormant selections and bindings while App State mode is disabled', () => {
    const compiled = compileProject(snapshot({
      project: {
        appStateMode: 'disabled',
        activeStateId: 'state_active',
      },
    }));
    const match = matchRequest(compiled, request());
    if (!match) throw new Error('Expected a match');
    expect(resolveEndpoint(compiled, match)).toMatchObject({
      kind: 'mock',
      resolved: {
        variantId: 'var_default',
        resolutionSource: 'endpoint_default',
        fallbackReasons: ['app_state_mode_disabled'],
        selectedStateId: undefined,
      },
    });
  });

  it('calculates coverage from mock-ready Endpoints only', () => {
    const compiled = compileProject(snapshot({
      endpoints: [
        endpoint('ep_mock'),
        endpoint('ep_pass', {
          mode: 'passthrough',
          matcher: { method: 'GET', path: '/pass' },
          variants: [],
          defaultVariantId: undefined,
        }),
      ],
      states: [stateRecord({ id: 'state_partial', bindings: {} })],
    }));
    expect(calculateStateCoverage(compiled, 'state_partial')).toEqual({
      bound: 0,
      total: 1,
    });
  });

  it.each([
    ['no active state', {}, 'active_state_unbound'],
    ['an unbound active state', { activeStateId: 'state_active' }, 'active_state_unbound'],
  ] as const)('passes through a mock Endpoint while enabled with %s', (_name, project, reason) => {
    const compiled = compileProject(snapshot({
      project: { appStateMode: 'enabled', ...project },
      states: [stateRecord({ id: 'state_active', bindings: {} })],
    }));
    const match = matchRequest(compiled, request());
    if (!match) throw new Error('Expected a match');
    expect(resolveEndpoint(compiled, match)).toMatchObject({
      kind: 'passthrough',
      endpointMode: 'mock',
      fallbackReasons: [reason],
    });
  });

  it('isolates repeated response headers from source and result mutations', () => {
    const source = endpoint('ep_headers');
    const compiled = compileProject(snapshot({ endpoints: [source], states: [] }));
    const match = matchRequest(compiled, request());
    if (!match) throw new Error('Expected a match');
    const first = resolveEndpoint(compiled, match);
    if (first.kind !== 'mock') throw new Error('Expected a mock');
    const cookies = first.resolved.responseHeaders['set-cookie'];
    if (!Array.isArray(cookies)) throw new Error('Expected repeated headers');
    cookies[0] = 'mutated=1';
    source.variants[0].responseHeaders['set-cookie'] = ['source=mutated'];
    const second = resolveEndpoint(compiled, match);
    if (second.kind !== 'mock') throw new Error('Expected a mock');
    expect(second.resolved.responseHeaders['set-cookie']).toEqual(['first=1', 'second=2']);
  });

  it('rejects invalid compiled references with stable errors', () => {
    const candidate = snapshot();
    candidate.states.get('state_active')!.bindings.ep_1 = 'var_missing';
    expect(() => compileProject(candidate)).toThrowError(CompileProjectError);
    expect(() => compileProject(candidate)).toThrowError(
      expect.objectContaining({ code: 'MISSING_BOUND_VARIANT' }),
    );
  });
});
