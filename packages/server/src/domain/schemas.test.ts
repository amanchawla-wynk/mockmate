import { describe, expect, it } from 'vitest';

import {
  AppStateSchema,
  BodyAssetSchema,
  EndpointSchema,
  GenerationPointerSchema,
  ProjectRuntimeSettingsSchema,
  ProjectSchema,
  ResponseVariantSchema,
  WorkspaceStateSchema,
} from './schemas';
import { parsePersistedRecord } from './validation';

const validProject = {
  schemaVersion: 4,
  id: 'prj_demo',
  name: 'Demo',
  appStateMode: 'enabled',
  revision: 0,
  createdAt: '2026-08-27T00:00:00.000Z',
  updatedAt: '2026-08-27T00:00:00.000Z',
};

const validVariant = {
  id: 'var_1',
  endpointId: 'ep_1',
  name: 'Success',
  status: 200,
  responseHeaders: { 'content-type': 'application/json' },
  revision: 0,
};

const validEndpoint = {
  schemaVersion: 4,
  id: 'ep_1',
  projectId: 'prj_demo',
  name: 'Playback',
  baseUrl: 'https://api.example.test',
  matcher: {
    method: 'GET',
    path: '/playback',
    query: { plan: [{ operator: 'equals', value: 'paid' }] },
    headers: { authorization: { operator: 'glob', value: 'Bearer *' } },
  },
  mode: 'mock',
  defaultVariantId: 'var_1',
  variants: [validVariant],
  revision: 0,
};

const validState = {
  schemaVersion: 4,
  id: 'state_1',
  projectId: 'prj_demo',
  name: 'Signed in',
  tags: ['authenticated'],
  bindings: { ep_1: 'var_1' },
  revision: 0,
};

const validAsset = {
  schemaVersion: 4,
  id: 'a'.repeat(64),
  mediaType: 'application/json',
  size: 2,
  createdAt: '2026-08-27T00:00:00.000Z',
};

const validRuntimeSettings = {
  schemaVersion: 4,
  projectId: 'prj_demo',
  interceptHosts: ['api.example.test'],
  captureRawTraffic: false,
  debugProvenanceHeaders: false,
  revision: 0,
};

function ownEnumerableRecord<T>(entries: Array<[string, T]>): Record<string, T> {
  const record: Record<string, T> = {};
  for (const [key, value] of entries) {
    Object.defineProperty(record, key, {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    });
  }
  return record;
}

describe('canonical persisted schemas', () => {
  it('accepts schema-v4 ownership and rejects removed fields', () => {
    expect(ProjectSchema.parse({
      schemaVersion: 4,
      id: 'prj_1',
      name: 'Project',
      appStateMode: 'enabled',
      revision: 0,
      createdAt: '2026-08-27T00:00:00.000Z',
      updatedAt: '2026-08-27T00:00:00.000Z',
    })).not.toHaveProperty('baseUrl');
    expect(EndpointSchema.safeParse({
      ...validEndpoint,
      schemaVersion: 4,
      baseUrl: 'https://api.example.test',
      mode: 'mock',
      matcher: { ...validEndpoint.matcher, host: 'api.example.test' },
    }).success).toBe(false);
    expect(ProjectRuntimeSettingsSchema.safeParse({
      schemaVersion: 4,
      projectId: 'prj_demo',
      interceptHosts: [],
      captureRawTraffic: false,
      debugProvenanceHeaders: false,
      revision: 0,
      passthroughEnabled: true,
    }).success).toBe(false);
  });

  it('rejects schema-v3 persisted documents', () => {
    expect(ProjectSchema.safeParse({
      schemaVersion: 3,
      id: 'prj_1',
      name: 'Old',
      appStateMode: 'enabled',
      revision: 0,
      createdAt: '2026-08-27T00:00:00.000Z',
      updatedAt: '2026-08-27T00:00:00.000Z',
    }).success).toBe(false);
  });

  it.each([
    ['Project', ProjectSchema, validProject],
    ['Endpoint', EndpointSchema, validEndpoint],
    ['App State', AppStateSchema, validState],
    ['Body Asset', BodyAssetSchema, validAsset],
    ['runtime settings', ProjectRuntimeSettingsSchema, validRuntimeSettings],
    ['workspace state', WorkspaceStateSchema, { schemaVersion: 4, activeProjectId: 'prj_demo', revision: 2 }],
    ['generation pointer', GenerationPointerSchema, { schemaVersion: 4, generationId: 'gen_1' }],
  ])('parses a valid %s record', (_name, schema, value) => {
    expect(schema.parse(value)).toEqual(value);
  });

  it.each([
    ['Project', ProjectSchema, validProject],
    ['Endpoint', EndpointSchema, validEndpoint],
    ['App State', AppStateSchema, validState],
    ['Body Asset', BodyAssetSchema, validAsset],
    ['runtime settings', ProjectRuntimeSettingsSchema, validRuntimeSettings],
    ['workspace state', WorkspaceStateSchema, { schemaVersion: 4, revision: 0 }],
    ['generation pointer', GenerationPointerSchema, { schemaVersion: 4, generationId: 'gen_1' }],
  ])('rejects unknown keys on %s records', (_name, schema, value) => {
    expect(() => schema.parse({ ...value, unknown: true })).toThrow();
  });

  it('rejects unknown keys in nested endpoint records', () => {
    expect(() => EndpointSchema.parse({
      ...validEndpoint,
      matcher: { ...validEndpoint.matcher, unknown: true },
    })).toThrow();
    expect(() => EndpointSchema.parse({
      ...validEndpoint,
      variants: [{ ...validVariant, unknown: true }],
    })).toThrow();
  });

  it.each([200, 599])('accepts response status boundary %s', status => {
    expect(ResponseVariantSchema.parse({ ...validVariant, status }).status).toBe(status);
  });

  it.each([99, 100, 103, 199, 600])('rejects response status %s', status => {
    expect(() => ResponseVariantSchema.parse({ ...validVariant, status })).toThrow();
  });

  it.each([
    ['project revision', ProjectSchema, { ...validProject, revision: -1 }],
    ['asset size', BodyAssetSchema, { ...validAsset, size: -1 }],
    ['variant delay', ResponseVariantSchema, { ...validVariant, delayMs: -1 }],
    ['workspace revision', WorkspaceStateSchema, { schemaVersion: 4, revision: 0.5 }],
  ])('rejects an invalid %s', (_name, schema, value) => {
    expect(() => schema.parse(value)).toThrow();
  });

  it('keeps display punctuation independent from stable IDs', () => {
    expect(EndpointSchema.parse({
      ...validEndpoint,
      name: 'Playback / denied? #1',
    }).id).toBe('ep_1');
  });
});

describe('header normalization', () => {
  it('normalizes matcher and response header names to lowercase', () => {
    const parsed = EndpointSchema.parse({
      ...validEndpoint,
      matcher: {
        ...validEndpoint.matcher,
        headers: { Authorization: { operator: 'equals', value: 'Bearer token' } },
      },
      variants: [{
        ...validVariant,
        responseHeaders: { 'Content-Type': 'application/json' },
      }],
    });

    expect(parsed.matcher.headers).toEqual({
      authorization: { operator: 'equals', value: 'Bearer token' },
    });
    expect(parsed.variants[0].responseHeaders).toEqual({
      'content-type': 'application/json',
    });
  });

  it('preserves ordered repeated response header values', () => {
    const parsed = ResponseVariantSchema.parse({
      ...validVariant,
      responseHeaders: {
        'Content-Type': 'application/json',
        'Set-Cookie': ['session=one; Path=/', 'theme=dark; Path=/'],
      },
    });

    expect(parsed.responseHeaders).toEqual({
      'content-type': 'application/json',
      'set-cookie': ['session=one; Path=/', 'theme=dark; Path=/'],
    });
  });

  it('rejects empty repeated response header arrays', () => {
    expect(() => ResponseVariantSchema.parse({
      ...validVariant,
      responseHeaders: { 'Set-Cookie': [] },
    })).toThrow();
  });

  it.each([
    ['matcher', {
      ...validEndpoint,
      matcher: {
        ...validEndpoint.matcher,
        headers: {
          Authorization: { operator: 'equals', value: 'a' },
          authorization: { operator: 'equals', value: 'b' },
        },
      },
    }],
    ['response', {
      ...validEndpoint,
      variants: [{
        ...validVariant,
        responseHeaders: { 'Content-Type': 'text/plain', 'content-type': 'application/json' },
      }],
    }],
  ])('rejects %s header normalization collisions', (_name, value) => {
    expect(() => EndpointSchema.parse(value)).toThrowError(/duplicate header.*lowercase/i);
  });

  it('rejects prototype-shaped matcher header collisions', () => {
    expect(() => EndpointSchema.parse({
      ...validEndpoint,
      matcher: {
        ...validEndpoint.matcher,
        headers: ownEnumerableRecord([
          ['__PROTO__', { operator: 'equals' as const, value: 'a' }],
          ['__proto__', { operator: 'equals' as const, value: 'b' }],
        ]),
      },
    })).toThrowError(/duplicate header.*lowercase/i);
  });

  it('rejects prototype-shaped response header collisions', () => {
    expect(() => EndpointSchema.parse({
      ...validEndpoint,
      variants: [{
        ...validVariant,
        responseHeaders: ownEnumerableRecord([
          ['__PROTO__', 'text/plain'],
          ['__proto__', 'application/json'],
        ]),
      }],
    })).toThrowError(/duplicate header.*lowercase/i);
  });

  it('preserves a prototype-shaped matcher header as an own property', () => {
    const parsed = EndpointSchema.parse({
      ...validEndpoint,
      matcher: {
        ...validEndpoint.matcher,
        headers: ownEnumerableRecord([
          ['__proto__', { operator: 'equals' as const, value: 'a' }],
        ]),
      },
    });

    expect(Object.getPrototypeOf(parsed.matcher.headers)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(parsed.matcher.headers, '__proto__')).toBe(true);
  });

  it('preserves a prototype-shaped response header as an own property', () => {
    const parsed = EndpointSchema.parse({
      ...validEndpoint,
      variants: [{
        ...validVariant,
        responseHeaders: ownEnumerableRecord([['__PROTO__', ['one', 'two']]]),
      }],
    });

    expect(Object.getPrototypeOf(parsed.variants[0].responseHeaders)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(
      parsed.variants[0].responseHeaders,
      '__proto__',
    )).toBe(true);
    expect(parsed.variants[0].responseHeaders.__proto__).toEqual(['one', 'two']);
  });
});

describe('persisted validation diagnostics', () => {
  it('rejects unsupported schema versions with fresh-install recovery guidance', () => {
    const result = parsePersistedRecord(ProjectSchema, {
      ...validProject,
      schemaVersion: 2,
    }, 'projects/prj_demo/project.json');

    expect(result).toEqual({
      ok: false,
      findings: [expect.objectContaining({
        severity: 'blocking',
        code: 'UNSUPPORTED_SCHEMA_VERSION',
        file: 'projects/prj_demo/project.json',
        path: '$.schemaVersion',
        recovery: 'Reset the configured MockMate data directory and restart the fresh schema-v4 application.',
      })],
    });
  });

  it('reserves unsupported-version classification for the top-level schema version', () => {
    const result = parsePersistedRecord(AppStateSchema, {
      ...validState,
      bindings: { schemaVersion: '' },
    }, 'states/state_1.json');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected invalid App State bindings');
    expect(result.findings[0]).toMatchObject({
      code: 'INVALID_BINDINGS',
      path: '$.bindings',
    });
    expect(result.findings[0].recovery).not.toMatch(/migrat|backup|rollback/i);
  });

  it.each([
    ['bindings', AppStateSchema, {
      ...validState,
      bindings: { 'secret-dynamic-key': '' },
    }, 'INVALID_BINDINGS', '$.bindings'],
    ['query', EndpointSchema, {
      ...validEndpoint,
      matcher: {
        ...validEndpoint.matcher,
        query: { 'secret-dynamic-key': [{ operator: 'equals', value: 1 }] },
      },
    }, 'INVALID_QUERY', '$.matcher.query'],
    ['matcher headers', EndpointSchema, {
      ...validEndpoint,
      matcher: {
        ...validEndpoint.matcher,
        headers: { 'secret-dynamic-key': { operator: 'equals', value: 1 } },
      },
    }, 'INVALID_HEADERS', '$.matcher.headers'],
    ['response headers', EndpointSchema, {
      ...validEndpoint,
      variants: [{
        ...validVariant,
        responseHeaders: { 'secret-dynamic-key': 1 },
      }],
    }, 'INVALID_RESPONSE_HEADERS', '$.variants[0].responseHeaders'],
  ])('does not expose invalid dynamic %s keys', (_name, schema, value, code, path) => {
    const result = parsePersistedRecord(schema, value, 'record.json');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected invalid dynamic record value');
    expect(result.findings[0]).toMatchObject({ code, path });
    expect(JSON.stringify(result)).not.toContain('secret-dynamic-key');
  });

  it('returns normalized persisted values after final schema parsing', () => {
    const result = parsePersistedRecord(EndpointSchema, {
      ...validEndpoint,
      matcher: {
        ...validEndpoint.matcher,
        headers: { Authorization: { operator: 'equals', value: 'token' } },
      },
    }, 'endpoints/ep_1.json');

    expect(result).toMatchObject({
      ok: true,
      value: { matcher: { headers: { authorization: { operator: 'equals', value: 'token' } } } },
    });
  });

  it('uses actionable field paths, codes, and recovery text', () => {
    const result = parsePersistedRecord(BodyAssetSchema, {
      ...validAsset,
      size: -1,
    }, 'bodies/body.json');

    expect(result).toEqual({
      ok: false,
      findings: [expect.objectContaining({
        severity: 'blocking',
        code: 'INVALID_SIZE',
        file: 'bodies/body.json',
        path: '$.size',
        recovery: expect.stringMatching(/size|record/i),
      })],
    });
  });

  it('never includes invalid values or body bytes in validation findings', () => {
    const secret = 'large-secret-body';
    const result = parsePersistedRecord(BodyAssetSchema, {
      schemaVersion: 4,
      id: 'not-a-digest',
      mediaType: 'application/json',
      size: -1,
      createdAt: secret,
      bodyBytes: secret,
    }, 'body.json');

    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('reports header collisions as blocking findings without throwing', () => {
    const result = parsePersistedRecord(EndpointSchema, {
      ...validEndpoint,
      matcher: {
        ...validEndpoint.matcher,
        headers: {
          Authorization: { operator: 'equals', value: 'a' },
          authorization: { operator: 'equals', value: 'b' },
        },
      },
    }, 'endpoints/ep_1.json');

    expect(result).toEqual({
      ok: false,
      findings: [expect.objectContaining({
        severity: 'blocking',
        code: 'DUPLICATE_HEADER',
        file: 'endpoints/ep_1.json',
        path: '$.matcher.headers',
        recovery: expect.stringMatching(/unique|duplicate/i),
      })],
    });
  });

  it.each([
    ['Endpoint origin', EndpointSchema, {
      ...validEndpoint,
      baseUrl: 'https://user@api.example.test',
    }, 'INVALID_BASE_URL', '$.baseUrl'],
    ['traffic provenance origin', EndpointSchema, {
      ...validEndpoint,
      variants: [{
        ...validVariant,
        trafficProvenance: [{
          type: 'traffic',
          trafficId: 'traffic_1',
          trafficGeneration: 'traffic_generation_1',
          capturedAt: validAsset.createdAt,
          requestOrigin: 'https://user@api.example.test',
          responseIdentity: 'response_1',
          endpointTarget: 'create',
          endpointId: 'ep_1',
          endpointCreated: true,
          variantId: 'var_1',
          variantCreated: true,
          endpointModeChanged: false,
          stateTarget: 'unbound',
          bindingChanged: false,
        }],
      }],
    }, 'INVALID_REQUEST_ORIGIN', '$.variants[0].trafficProvenance[0].requestOrigin'],
    ['Body Asset media type', BodyAssetSchema, {
      ...validAsset,
      mediaType: 'text/plain; bad="unterminated',
    }, 'INVALID_MEDIA_TYPE', '$.mediaType'],
    ['Body Asset content encoding', BodyAssetSchema, {
      ...validAsset,
      encoding: 'gzip,,br',
    }, 'INVALID_ENCODING', '$.encoding'],
  ] as const)('returns diagnostics instead of throwing for malformed persisted %s', (
    _name, schema, value, code, findingPath,
  ) => {
    let result: ReturnType<typeof parsePersistedRecord> | undefined;

    expect(() => {
      result = parsePersistedRecord(schema, value, 'record.json');
    }).not.toThrow();
    expect(result).toEqual({
      ok: false,
      findings: [expect.objectContaining({ code, path: findingPath })],
    });
  });
});
