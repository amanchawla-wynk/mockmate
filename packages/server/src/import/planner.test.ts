import { describe, expect, it } from 'vitest';

import type {
  AppState,
  BodyAsset,
  EndpointDetail,
  Project,
  ProjectRuntimeSettings,
  ResponseVariant,
} from '../domain/model';
import type { ValidatedProjectSnapshot } from '../repository/snapshot';
import {
  endpointRecord,
  projectRecord,
  settingsRecord,
  stateRecord,
} from '../test-support/project-builder';
import type {
  ImportMessage,
  ImportRequestSummary,
  NormalizedImportMember,
  NormalizedImportResponse,
  ParsedImportSource,
} from './contracts';
import { parseCurlSource } from './curl-parser';
import {
  buildImportPlan,
  canonicalImportDigest,
  importPlanDigest,
  matcherIdentity,
  matchersMayOverlap,
} from './planner';
import { sha256Bytes, sha256Identity } from './security';

const EMPTY_REQUEST: ImportRequestSummary = { query: [], headers: [] };

function response(
  name: string,
  status = 200,
  body?: string,
  responseHeaders: Record<string, string | string[]> = {},
): NormalizedImportResponse {
  const bytes = body === undefined ? undefined : Buffer.from(body);
  const headers = Object.fromEntries(Object.entries(responseHeaders)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => [key.toLowerCase(), Array.isArray(value) ? value : [value]]));
  return {
    name,
    status,
    responseHeaders,
    ...(bytes === undefined ? {} : { body: bytes }),
    identity: sha256Identity('import-response-v1', {
      status,
      headers,
      body: bytes === undefined
        ? { kind: 'none' }
        : { kind: 'sha256', value: sha256Bytes(bytes) },
    }),
    warnings: [],
    errors: [],
  };
}

function member(options: {
  index: number;
  name?: string;
  description?: string;
  baseUrl?: string;
  path?: string;
  method?: string;
  breadcrumb?: string[];
  responses?: NormalizedImportResponse[];
  unresolvedVariables?: string[];
  warnings?: ImportMessage[];
  errors?: ImportMessage[];
  matcher?: boolean;
  disabled?: boolean;
  supportedMethod?: boolean;
}): NormalizedImportMember {
  const location = { type: 'postman' as const, itemPath: [options.index] };
  return {
    provisionalId: sha256Identity('import-member-v1', {
      sourceType: 'postman',
      location,
    }),
    location,
    breadcrumb: options.breadcrumb ?? [],
    name: options.name ?? `Request ${options.index + 1}`,
    ...(options.description === undefined ? {} : { description: options.description }),
    disabled: options.disabled ?? false,
    supportedMethod: options.supportedMethod ?? true,
    ...(options.matcher === false ? {} : {
      canonicalRequest: {
        baseUrl: options.baseUrl ?? 'https://api.example.test',
        matcher: {
          method: options.method ?? 'GET',
          path: options.path ?? '/users',
        },
      },
    }),
    request: structuredClone(EMPTY_REQUEST),
    responses: options.responses ?? [],
    unresolvedVariables: options.unresolvedVariables ?? [],
    warnings: options.warnings ?? [],
    errors: options.errors ?? [],
  };
}

function parsed(members: NormalizedImportMember[], warnings: ImportMessage[] = []): ParsedImportSource {
  return { sourceType: 'postman', members, warnings };
}

function variant(options: Partial<ResponseVariant> & Pick<ResponseVariant, 'id' | 'endpointId' | 'name'>): ResponseVariant {
  return {
    status: 200,
    responseHeaders: {},
    revision: 1,
    ...options,
  };
}

function endpoint(options: {
  id: string;
  matcher?: EndpointDetail['matcher'];
  variants?: ResponseVariant[];
  name?: string;
  revision?: number;
  baseUrl?: string;
}): EndpointDetail {
  const variants = options.variants ?? [variant({
    id: `var_${options.id}`,
    endpointId: options.id,
    name: 'Default',
  })];
  return endpointRecord({
    id: options.id,
    name: options.name ?? options.id,
    baseUrl: options.baseUrl ?? 'https://api.example.test',
    matcher: options.matcher ?? { method: 'GET', path: '/users' },
    defaultVariantId: variants[0].id,
    variants,
    revision: options.revision ?? 1,
  });
}

function snapshot(options: {
  project?: Project;
  settings?: ProjectRuntimeSettings;
  endpoints?: EndpointDetail[];
  states?: AppState[];
  bodyAssets?: BodyAsset[];
} = {}): ValidatedProjectSnapshot {
  const endpoints = options.endpoints ?? [];
  const states = options.states ?? [];
  const bodyAssets = options.bodyAssets ?? [];
  return {
    project: options.project ?? projectRecord(),
    settings: options.settings ?? settingsRecord(),
    endpoints: new Map(endpoints.map(value => [value.id, value])),
    states: new Map(states.map(value => [value.id, value])),
    bodyAssets: new Map(bodyAssets.map(value => [value.id, value])),
    generationId: 'gen_current',
  };
}

describe('matcher conflict analysis', () => {
  it('includes normalized origin and complete query multisets in matcher identity', () => {
    const request = (baseUrl: string, values: string[]) => ({
      baseUrl,
      matcher: {
        method: 'GET',
        path: '/x',
        query: { a: values.map(value => ({ operator: 'equals' as const, value })) },
      },
    });

    expect(matcherIdentity(request('https://api.test:443', ['2', '1'])))
      .toBe(matcherIdentity(request('https://api.test', ['1', '2'])));
    expect(matcherIdentity(request('http://api.test', ['1', '2'])))
      .not.toBe(matcherIdentity(request('https://api.test', ['1', '2'])));
    expect(matcherIdentity(request('https://api.test:8443', ['1', '2'])))
      .not.toBe(matcherIdentity(request('https://api.test', ['1', '2'])));
    expect(matcherIdentity(request('https://api.test', ['1', '1', '2'])))
      .not.toBe(matcherIdentity(request('https://api.test', ['1', '2'])));
  });

  it('normalizes origin, method, and path for matcher identity', () => {
    expect(matcherIdentity({
      baseUrl: 'HTTPS://API.EXAMPLE.TEST.:443', matcher: { method: ' get ', path: '/users/' },
    })).toBe(matcherIdentity({
      baseUrl: 'https://api.example.test', matcher: { method: 'GET', path: '/users' },
    }));
  });

  it('requires equal origins and methods with conservatively overlapping paths', () => {
    expect(matchersMayOverlap(
      { baseUrl: 'https://api.example.test', matcher: { method: 'GET', path: '/users/*' } },
      { baseUrl: 'https://api.example.test', matcher: { method: 'GET', path: '/users/42' } },
    )).toBe(true);
    expect(matchersMayOverlap(
      { baseUrl: 'https://api.example.test', matcher: { method: 'POST', path: '/users/*' } },
      { baseUrl: 'https://api.example.test', matcher: { method: 'GET', path: '/users/42' } },
    )).toBe(false);
    expect(matchersMayOverlap(
      { baseUrl: 'https://api.example.test', matcher: { method: 'GET', path: '/v1/*' } },
      { baseUrl: 'https://api.other.test', matcher: { method: 'GET', path: '/v1/42' } },
    )).toBe(false);
    expect(matchersMayOverlap(
      { baseUrl: 'https://api.example.test', matcher: { method: 'GET', path: '/v1/42' } },
      { baseUrl: 'https://api.example.test', matcher: { method: 'GET', path: '/v2/42' } },
    )).toBe(false);
  });

  it('does not overlap an imported concrete method with a non-equal wildcard method', () => {
    const plan = buildImportPlan(snapshot({ endpoints: [endpoint({
      id: 'ep_any_method',
      matcher: { method: 'G*', path: '/users' },
    })] }), parsed([
      member({ index: 0, method: 'GET', path: '/users' }),
    ]), 'variables');

    expect(plan.preview.items[0].overlaps).toEqual([]);
    expect(matchersMayOverlap(
      { baseUrl: 'https://api.example.test', matcher: { method: 'GET', path: '/users' } },
      { baseUrl: 'https://api.example.test', matcher: { method: 'POST', path: '/users' } },
    )).toBe(false);
  });

  it.each([
    ['partial wildcard and concrete method', 'G*', 'GET', false],
    ['suffix wildcard and concrete method', '*ET', 'GET', false],
    ['two distinct wildcard methods', 'G*', '*ET', false],
    ['equal wildcard methods', 'G*', 'G*', true],
    ['distinct concrete methods', 'GET', 'POST', false],
  ])('handles %s conservatively', (_name, leftMethod, rightMethod, expected) => {
    expect(matchersMayOverlap(
      { baseUrl: 'https://api.example.test', matcher: { method: leftMethod, path: '/users' } },
      { baseUrl: 'https://api.example.test', matcher: { method: rightMethod, path: '/users' } },
    )).toBe(expected);
  });

  it('reports existing query and header constraints in relative specificity', () => {
    const existing = endpoint({
      id: 'ep_constrained',
      matcher: {
        method: 'GET',
        path: '/users/*',
        query: { plan: [{ operator: 'equals', value: 'paid' }] },
        headers: { 'x-mode': { operator: 'glob', value: '*' } },
      },
    });
    const plan = buildImportPlan(snapshot({ endpoints: [existing] }), parsed([
      member({ index: 0, path: '/users/42' }),
    ]), 'variables');

    expect(plan.preview.items[0].overlaps).toEqual([expect.objectContaining({
      endpointId: 'ep_constrained',
      relativeSpecificity: 'less-specific',
      confirmationRequired: false,
    })]);
  });
});

describe('deterministic import planning', () => {
  it('groups percent-equivalent reordered query multisets while separating origin and multiplicity', () => {
    const source = [
      "curl 'https://api.test/x?a=%E2%82%AC&a=1'",
      "curl 'https://api.test:443/x?a=1&a=%e2%82%ac'",
      "curl 'http://api.test/x?a=1&a=%E2%82%AC'",
      "curl 'https://api.test:8443/x?a=1&a=%E2%82%AC'",
      "curl 'https://api.test/x?a=1&a=1&a=%E2%82%AC'",
    ].join(';');

    const plan = buildImportPlan(snapshot(), parseCurlSource(source), 'variables');

    expect(plan.preview.items).toHaveLength(4);
    expect(plan.preview.items.map(item => item.memberIds.length).sort()).toEqual([1, 1, 1, 2]);
    expect(plan.preview.discoveredOrigins).toEqual([
      'http://api.test',
      'https://api.test',
      'https://api.test:8443',
    ]);
    expect(new Set(plan.preview.items.map(item => item.id)).size).toBe(4);
  });

  it('groups equal requests by complete ordered locations and keeps first display data', () => {
    const members = [
      member({
        index: 0,
        name: 'First',
        description: 'First description',
        breadcrumb: ['Folder A'],
        responses: [response('OK', 200, 'one')],
      }),
      member({
        index: 1,
        name: 'Second',
        description: 'Second description',
        breadcrumb: ['Folder B'],
        responses: [response('OK', 201, 'two')],
      }),
    ];
    const plan = buildImportPlan(snapshot(), parsed(members), 'variables');
    const requestIdentity = matcherIdentity(members[0].canonicalRequest!);
    const expectedId = sha256Identity('import-item-v1', {
      sourceType: 'postman',
      requestIdentity,
      locations: members.map(value => value.location),
    });

    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].preview).toMatchObject({
      id: expectedId,
      memberIds: members.map(value => value.provisionalId),
      locations: [
        { type: 'postman', itemPath: [0] },
        { type: 'postman', itemPath: [1] },
      ],
      breadcrumbs: [['Folder A'], ['Folder B']],
      name: 'First',
      description: 'First description',
      proposedAction: 'create',
      allowedActions: ['create', 'skip'],
      selectedByDefault: true,
      createEffect: { createsEndpoint: true, createsVariants: 2 },
    });
    expect(plan.items[0].createResponses.map(value => value.summary.name))
      .toEqual(['OK', 'OK (2)']);
    expect(plan.items[0].createResponses.map(value => value.body?.toString()))
      .toEqual(['one', 'two']);
  });

  it('uses structural locations rather than breadcrumbs in grouped IDs', () => {
    const first = buildImportPlan(snapshot(), parsed([
      member({ index: 0, breadcrumb: ['Old folder'] }),
    ]), 'variables');
    const renamed = buildImportPlan(snapshot(), parsed([
      member({ index: 0, breadcrumb: ['Renamed folder'] }),
    ]), 'variables');
    expect(first.preview.items[0].id).toBe(renamed.preview.items[0].id);
  });

  it('keeps unresolved provisional members out of items until resolution creates a grouped ID', () => {
    const unresolved = member({
      index: 0,
      matcher: false,
      unresolvedVariables: ['host'],
      errors: [{ code: 'IMPORT_URL_INVALID', message: 'URL unresolved' }],
    });
    const before = buildImportPlan(snapshot(), parsed([unresolved]), 'variables-a');
    expect(before.preview.items).toEqual([]);
    expect(before.preview.unresolvedMembers[0].id).toBe(unresolved.provisionalId);
    expect(before.preview.unresolvedVariables).toEqual([{
      name: 'host', memberIds: [unresolved.provisionalId],
    }]);

    const resolved = member({ index: 0 });
    const after = buildImportPlan(snapshot(), parsed([resolved]), 'variables-b');
    expect(after.preview.unresolvedMembers).toEqual([]);
    expect(after.preview.items[0].id).not.toBe(unresolved.provisionalId);
  });

  it('preserves duplicate create response content while suffixing names case-insensitively', () => {
    const duplicate = response('Result', 200, 'same');
    const plan = buildImportPlan(snapshot(), parsed([
      member({
        index: 0,
        responses: [duplicate, { ...duplicate, name: 'result' }, { ...duplicate, name: '' }],
      }),
    ]), 'variables');

    expect(plan.items[0].createResponses).toHaveLength(3);
    expect(plan.items[0].createResponses.map(value => value.summary.name))
      .toEqual(['Result', 'result (2)', 'Response 3']);
  });

  it('previews one empty Default response only for example-free creates', () => {
    const create = buildImportPlan(snapshot(), parseCurlSource(
      'curl https://api.example.test/users',
    ), 'variables');
    expect(create.preview.items[0]).toMatchObject({
      responses: [{
        name: 'Default',
        status: 200,
        responseHeaders: {},
        body: { kind: 'none' },
      }],
      createEffect: { createsEndpoint: true, createsVariants: 1 },
      proposedAction: 'create',
    });
    expect(create.items[0].createResponses).toHaveLength(1);

    const exact = buildImportPlan(snapshot({ endpoints: [endpoint({
      id: 'ep_exact',
      matcher: { method: 'GET', path: '/users' },
    })] }), parseCurlSource('curl https://api.example.test/users'), 'variables');
    expect(exact.preview.items[0]).toMatchObject({
      responses: [],
      proposedAction: 'skip',
      allowedActions: ['merge', 'skip'],
      createEffect: { createsEndpoint: false, createsVariants: 0 },
    });
    expect(exact.items[0].createResponses).toEqual([]);
    expect([...exact.items[0].mergeResponsesByEndpointId.values()]).toEqual([[]]);
  });

  it('does not synthesize a create response for invalid or disabled rows', () => {
    const invalid = buildImportPlan(snapshot(), parsed([
      member({
        index: 0,
        errors: [{ code: 'IMPORT_REQUEST_INVALID', message: 'Invalid request' }],
      }),
      member({ index: 1, path: '/disabled', disabled: true }),
    ]), 'variables');

    for (const item of invalid.items) {
      expect(item.preview).toMatchObject({
        responses: [],
        proposedAction: 'skip',
        allowedActions: ['skip'],
        createEffect: { createsEndpoint: false, createsVariants: 0 },
      });
      expect(item.createResponses).toEqual([]);
    }
  });

  it('returns every exact legacy target with target-specific dedupe and names', () => {
    const first = endpoint({
      id: 'ep_a',
      revision: 4,
      variants: [
        variant({ id: 'var_a1', endpointId: 'ep_a', name: 'OK', status: 200 }),
        variant({ id: 'var_a2', endpointId: 'ep_a', name: 'Created', status: 201 }),
      ],
    });
    const second = endpoint({
      id: 'ep_b',
      revision: 7,
      variants: [variant({ id: 'var_b1', endpointId: 'ep_b', name: 'ok', status: 200 })],
    });
    const plan = buildImportPlan(snapshot({ endpoints: [second, first] }), parsed([
      member({
        index: 0,
        responses: [
          response('OK', 200),
          response('Created', 201),
          response('OK', 202),
          response('Ignored duplicate identity', 202),
        ],
      }),
    ]), 'variables');

    expect(plan.preview.items[0].allowedActions).toEqual(['merge', 'skip']);
    expect(plan.preview.items[0].allowedActions).not.toContain('create');
    expect(plan.preview.items[0].exactTargets).toEqual([
      expect.objectContaining({
        endpointId: 'ep_a',
        endpointRevision: 4,
        newVariantCount: 1,
        candidateResponses: [expect.objectContaining({ name: 'OK (2)', status: 202 })],
      }),
      expect.objectContaining({
        endpointId: 'ep_b',
        endpointRevision: 7,
        newVariantCount: 2,
        candidateResponses: [
          expect.objectContaining({ name: 'Created', status: 201 }),
          expect.objectContaining({ name: 'OK (2)', status: 202 }),
        ],
      }),
    ]);
    expect(plan.items[0].mergeResponsesByEndpointId.get('ep_a')).toHaveLength(1);
    expect(plan.items[0].mergeResponsesByEndpointId.get('ep_b')).toHaveLength(2);
  });

  it('proposes skip when every exact merge candidate is identical', () => {
    const existing = endpoint({
      id: 'ep_exact',
      variants: [variant({ id: 'var_1', endpointId: 'ep_exact', name: 'Existing' })],
    });
    const plan = buildImportPlan(snapshot({ endpoints: [existing] }), parsed([
      member({ index: 0, responses: [response('Different name', 200)] }),
    ]), 'variables');
    expect(plan.preview.items[0]).toMatchObject({
      proposedAction: 'skip',
      selectedByDefault: false,
      exactTargets: [{ newVariantCount: 0, candidateResponses: [] }],
    });
  });

  it('keeps equal-specificity overlaps selected but requiring confirmation', () => {
    const plan = buildImportPlan(snapshot({ endpoints: [endpoint({
      id: 'ep_existing',
      matcher: { method: 'GET', path: '/users/*a' },
    })] }), parsed([
      member({ index: 0, path: '/users/a*' }),
    ]), 'variables');
    expect(plan.preview.items[0]).toMatchObject({
      proposedAction: 'create',
      selectedByDefault: true,
      overlaps: [{
        endpointId: 'ep_existing',
        relativeSpecificity: 'equal',
        confirmationRequired: true,
      }],
    });
  });

  it('allows a more-constrained concrete path beside a wildcard path', () => {
    const plan = buildImportPlan(snapshot({ endpoints: [endpoint({
      id: 'ep_broad', matcher: { method: 'GET', path: '/users/*' },
    })] }), parsed([
      member({ index: 0, path: '/users/42' }),
    ]), 'variables');
    expect(plan.preview.items[0].overlaps).toEqual([expect.objectContaining({
      endpointId: 'ep_broad',
      relativeSpecificity: 'more-specific',
      confirmationRequired: false,
    })]);
  });

  it('sorts IDs and origins by code units and lists all states only for proposed creates', () => {
    const plan = buildImportPlan(snapshot({
      endpoints: [
        endpoint({ id: 'ep_ä', baseUrl: 'https://ä.example.test', matcher: { method: 'GET', path: '/users/*' } }),
        endpoint({ id: 'ep_z', baseUrl: 'https://ä.example.test', matcher: { method: 'GET', path: '/users/*' } }),
      ],
      states: [
        stateRecord({ id: 'state_ä', name: 'Umlaut', bindings: {} }),
        stateRecord({ id: 'state_z', name: 'Zed', bindings: {} }),
      ],
    }), parsed([
      member({ index: 0, baseUrl: 'https://ä.example.test', path: '/users/42' }),
      member({ index: 1, baseUrl: 'https://z.example.test', path: '/other' }),
    ]), 'variables');

    expect(plan.preview.discoveredOrigins).toEqual([
      'https://xn--4ca.example.test',
      'https://z.example.test',
    ]);
    expect(plan.preview.items[0].overlaps.map(value => value.endpointId))
      .toEqual(['ep_z', 'ep_ä']);
    expect(plan.preview.affectedStates).toEqual([
      { id: 'state_z', name: 'Zed' },
      { id: 'state_ä', name: 'Umlaut' },
    ]);

    const exactOnly = buildImportPlan(snapshot({
      endpoints: [endpoint({ id: 'ep_exact' })],
      states: [stateRecord({ id: 'state_1', bindings: {} })],
    }), parsed([member({ index: 0 })]), 'variables');
    expect(exactOnly.preview.affectedStates).toEqual([]);
  });

  it('copies source and member messages without retaining raw source', () => {
    const sourceWarning = { code: 'SOURCE_WARNING', message: 'Source warning' };
    const memberWarning = { code: 'MEMBER_WARNING', message: 'Member warning' };
    const plan = buildImportPlan(snapshot(), parsed([
      member({ index: 0, warnings: [memberWarning] }),
    ], [sourceWarning]), 'variables');
    expect(plan.preview.warnings).toEqual([sourceWarning]);
    expect(plan.preview.items[0].warnings).toEqual([memberWarning]);
    expect(JSON.stringify(plan.preview)).not.toContain('raw source');
  });
});

describe('import digests', () => {
  it('changes canonical and plan digests when endpoint origin or repeated query changes', () => {
    const baseline = snapshot({ endpoints: [endpoint({
      id: 'ep_origin_query',
      matcher: {
        method: 'GET',
        path: '/x',
        query: { a: [{ operator: 'equals', value: '1' }] },
      },
    })] });
    const changedOrigin = structuredClone(baseline);
    changedOrigin.endpoints.get('ep_origin_query')!.baseUrl = 'https://api.example.test:8443';
    const changedQuery = structuredClone(baseline);
    changedQuery.endpoints.get('ep_origin_query')!.matcher.query!.a.push({
      operator: 'equals',
      value: '1',
    });

    expect(canonicalImportDigest(changedOrigin)).not.toBe(canonicalImportDigest(baseline));
    expect(canonicalImportDigest(changedQuery)).not.toBe(canonicalImportDigest(baseline));

    const first = buildImportPlan(snapshot(), parseCurlSource(
      "curl 'https://api.test/x?a=1&a=2'",
    ), 'variables');
    const changed = buildImportPlan(snapshot(), parseCurlSource(
      "curl 'https://api.test/x?a=1&a=1&a=2'",
    ), 'variables');
    expect(importPlanDigest(changed, 'variables'))
      .not.toBe(importPlanDigest(first, 'variables'));
  });

  function canonicalFixture(): ValidatedProjectSnapshot {
    const asset: BodyAsset = {
      schemaVersion: 4,
      id: 'body-sha',
      mediaType: 'application/octet-stream',
      size: 4,
      encoding: 'identity',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    return snapshot({
      project: projectRecord({ activeStateId: 'state_1', revision: 4 }),
      settings: settingsRecord({ revision: 3 }),
      endpoints: [endpoint({
        id: 'ep_1',
        revision: 2,
        name: 'Ignored Endpoint Name',
        matcher: {
          method: 'get',
          path: '/users/',
          query: { plan: [{ operator: 'equals', value: 'paid' }] },
          headers: { 'X-Mode': { operator: 'glob', value: 'pre*' } },
        },
        variants: [variant({
          id: 'var_1',
          endpointId: 'ep_1',
          name: 'Default',
          status: 201,
          responseHeaders: { 'X-Test': 'one' },
          bodyAssetId: asset.id,
          delayMs: 5,
          revision: 6,
        })],
      })],
      states: [stateRecord({ id: 'state_1', bindings: { ep_1: 'var_1' }, revision: 8 })],
      bodyAssets: [asset],
    });
  }

  it.each([
    ['Endpoint ID', (value: ValidatedProjectSnapshot) => {
      const source = value.endpoints.get('ep_1')!;
      source.id = 'ep_changed';
      value.endpoints = new Map([['ep_changed', source]]);
    }],
    ['Endpoint revision', (value: ValidatedProjectSnapshot) => { value.endpoints.get('ep_1')!.revision += 1; }],
    ['matcher', (value: ValidatedProjectSnapshot) => { value.endpoints.get('ep_1')!.matcher.path = '/changed'; }],
    ['fallback', (value: ValidatedProjectSnapshot) => { value.endpoints.get('ep_1')!.defaultVariantId = 'var_changed'; }],
    ['Variant ID', (value: ValidatedProjectSnapshot) => { value.endpoints.get('ep_1')!.variants[0].id = 'var_changed'; }],
    ['Variant revision', (value: ValidatedProjectSnapshot) => { value.endpoints.get('ep_1')!.variants[0].revision += 1; }],
    ['Variant name', (value: ValidatedProjectSnapshot) => { value.endpoints.get('ep_1')!.variants[0].name = 'Changed'; }],
    ['Variant status', (value: ValidatedProjectSnapshot) => { value.endpoints.get('ep_1')!.variants[0].status = 202; }],
    ['Variant headers', (value: ValidatedProjectSnapshot) => { value.endpoints.get('ep_1')!.variants[0].responseHeaders = { other: 'two' }; }],
    ['Variant body ID', (value: ValidatedProjectSnapshot) => { value.endpoints.get('ep_1')!.variants[0].bodyAssetId = 'other-sha'; }],
    ['Variant delay', (value: ValidatedProjectSnapshot) => { value.endpoints.get('ep_1')!.variants[0].delayMs = 9; }],
    ['Body Asset metadata', (value: ValidatedProjectSnapshot) => { value.bodyAssets.get('body-sha')!.mediaType = 'text/plain'; }],
  ])('changes the canonical digest for %s', (_name, mutate) => {
    const baseline = canonicalFixture();
    const changed = structuredClone(baseline);
    mutate(changed);
    expect(canonicalImportDigest(changed)).not.toBe(canonicalImportDigest(baseline));
  });

  it.each([
    ['App State bindings', (value: ValidatedProjectSnapshot) => { value.states.get('state_1')!.bindings = {}; }],
    ['Project display and revision', (value: ValidatedProjectSnapshot) => {
      value.project.name = 'Changed';
      value.project.revision += 1;
    }],
    ['runtime settings', (value: ValidatedProjectSnapshot) => { value.settings.captureRawTraffic = true; }],
    ['generation/workspace pointer', (value: ValidatedProjectSnapshot) => { value.generationId = 'gen_other'; }],
    ['Endpoint display name', (value: ValidatedProjectSnapshot) => { value.endpoints.get('ep_1')!.name = 'Changed'; }],
  ])('ignores %s in the canonical digest', (_name, mutate) => {
    const baseline = canonicalFixture();
    const changed = structuredClone(baseline);
    mutate(changed);
    expect(canonicalImportDigest(changed)).toBe(canonicalImportDigest(baseline));
  });

  it('changes plan digest for preview semantics or variable digest, not source formatting', () => {
    const first = buildImportPlan(snapshot(), parseCurlSource(
      "curl -X GET 'https://api.example.test/users'",
    ), 'variables-a');
    const reformatted = buildImportPlan(snapshot(), parseCurlSource(
      'curl --request GET https://api.example.test/users',
    ), 'variables-a');
    expect(importPlanDigest(first, 'variables-a'))
      .toBe(importPlanDigest(reformatted, 'variables-a'));
    expect(importPlanDigest(first, 'variables-a'))
      .not.toBe(importPlanDigest(first, 'variables-b'));

    for (const mutate of [
      (value: typeof first) => { value.preview.items[0].locations = [{ type: 'curl', commandIndex: 9 }]; },
      (value: typeof first) => { value.preview.items[0].matcher.path = '/changed'; },
      (value: typeof first) => { value.preview.items[0].name = 'Changed'; },
      (value: typeof first) => { value.preview.items[0].description = 'Changed'; },
      (value: typeof first) => { value.preview.items[0].responses[0].status = 201; },
      (value: typeof first) => { value.preview.items[0].warnings.push({ code: 'W', message: 'warning' }); },
      (value: typeof first) => { value.preview.items[0].errors.push({ code: 'E', message: 'error' }); },
    ]) {
      const changed = structuredClone(first);
      mutate(changed);
      expect(importPlanDigest(changed, 'variables-a'))
        .not.toBe(importPlanDigest(first, 'variables-a'));
    }
  });

  it('uses private canonical query values in the plan digest while public matchers stay redacted', () => {
    const plan = buildImportPlan(snapshot(), parseCurlSource(
      "curl 'https://api.example.test/users?apiToken=private-digest-secret'",
    ), 'variables');
    const changed = structuredClone(plan);
    changed.items[0].canonicalRequest.matcher.query!.apiToken[0].value = 'different-private-secret';

    expect(JSON.stringify(plan.preview)).not.toContain('private-digest-secret');
    expect(plan.preview.items[0].matcher.query!.apiToken[0].value).toBe('[REDACTED]');
    expect(importPlanDigest(changed, 'variables')).not.toBe(importPlanDigest(plan, 'variables'));
  });
});
