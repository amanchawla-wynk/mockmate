import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bodiesApi,
  endpointsApi,
  importApi,
  interceptionGuidanceApi,
  projectsApi,
  statesApi,
  staticFilesApi,
  trafficApi,
  variantsApi,
} from './client';
import type {
  ImportCommitRequest,
  ImportCommitResult,
  ImportPreview,
  ImportPreviewData,
  ImportPreviewRequest,
  ImportResponseSummary,
  TrafficPromotionInput,
} from './types';

const errorBody = {
  code: 'PROJECT_NOT_FOUND',
  message: 'Project not found',
  requestId: 'req-123',
};

const hashedResponse = {
  name: 'Created',
  status: 201,
  responseHeaders: { 'content-type': 'application/json' },
  body: { kind: 'sha256', sha256: 'ab'.repeat(32), byteCount: 2 },
  identity: 'response-created',
} satisfies ImportResponseSummary;
const bodylessResponse = {
  name: 'No content',
  status: 204,
  responseHeaders: {},
  body: { kind: 'none' },
  identity: 'response-bodyless',
} satisfies ImportResponseSummary;
const publicPreviewFixture = {
  snapshotToken: 'snapshot-token',
  sourceType: 'postman',
  items: [{
    id: 'item-users',
    memberIds: ['member-users'],
    locations: [{ type: 'postman', itemPath: [0] }],
    breadcrumbs: [['Accounts']],
    name: 'Create user',
    description: 'Creates one user',
    baseUrl: 'https://api.example.test',
    matcher: { method: 'POST', path: '/users' },
    requests: [{
      scheme: 'https',
      hostname: 'api.example.test',
      query: [],
      headers: [{ name: 'Authorization', value: '[REDACTED]' }],
      auth: { type: 'bearer', fields: [{ name: 'token', value: '[REDACTED]' }] },
      body: { mediaType: 'application/json', byteCount: 18, omitted: true },
    }],
    responses: [hashedResponse, bodylessResponse],
    proposedAction: 'merge',
    allowedActions: ['merge', 'skip'],
    exactTargets: [{
      endpointId: 'ep_primary',
      endpointRevision: 4,
      name: 'Primary users',
      newVariantCount: 1,
      candidateResponses: [hashedResponse],
    }, {
      endpointId: 'ep_secondary',
      endpointRevision: 7,
      name: 'Secondary users',
      newVariantCount: 1,
      candidateResponses: [bodylessResponse],
    }],
    overlaps: [],
    warnings: [],
    errors: [],
    selectedByDefault: true,
    createEffect: { createsEndpoint: false, createsVariants: 0 },
  }],
  unresolvedMembers: [],
  unresolvedVariables: [],
  warnings: [{
    code: 'IMPORT_SCRIPT_IGNORED',
    message: 'Postman collection scripts are ignored during import',
  }],
  discoveredOrigins: ['https://api.example.test'],
  affectedStates: [],
  summary: { valid: 1, invalid: 0, create: 0, merge: 1, skip: 0 },
} satisfies ImportPreview;

function mockErrorResponse(): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
    new Response(JSON.stringify(errorBody), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    }),
  ));
}

describe('dashboard API errors', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('preserves structured errors from JSON API methods', async () => {
    mockErrorResponse();

    await expect(projectsApi.get('missing')).rejects.toMatchObject({
      name: 'ApiClientError',
      status: 404,
      code: 'PROJECT_NOT_FOUND',
      requestId: 'req-123',
    });
  });

  it('uses the same structured-error reader for file uploads', async () => {
    mockErrorResponse();

    await expect(
      staticFilesApi.upload('missing', 'fixture.json', new File(['{}'], 'fixture.json')),
    ).rejects.toMatchObject({
      name: 'ApiClientError',
      status: 404,
      code: 'PROJECT_NOT_FOUND',
      requestId: 'req-123',
    });
  });
});

describe('dashboard API path identity', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('encodes each stable ID segment in App State CRUD routes', async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ bindings: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetch);

    await statesApi.update('project/1', 'state#1', 2, { bindings: { 'endpoint?1': 'variant#1' } });

    expect(fetch).toHaveBeenCalledWith(
      '/api/admin/projects/project%2F1/states/state%231',
      expect.objectContaining({ method: 'PUT' }),
    );
  });

  it('encodes every stable ID segment', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetch);

    await variantsApi.delete('project/a', 'endpoint?b', 'variant#c', 2);

    expect(fetch.mock.calls[0]?.[0]).toBe(
      '/api/admin/projects/project%2Fa/endpoints/endpoint%3Fb/variants/variant%23c',
    );
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({ expectedRevision: 2 });
  });

  it('encodes every deletion-impact path segment and forwards cancellation', async () => {
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ));
    vi.stubGlobal('fetch', fetch);
    const controller = new AbortController();

    await endpointsApi.deletionImpact('prj 1', 'ep/1', controller.signal);
    await variantsApi.deletionImpact('prj 1', 'ep/1', 'var#1', controller.signal);

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      '/api/admin/projects/prj%201/endpoints/ep%2F1/deletion-impact',
      expect.objectContaining({ signal: controller.signal }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      '/api/admin/projects/prj%201/endpoints/ep%2F1/variants/var%231/deletion-impact',
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it('sends replacement preconditions only when supplied for Variant deletion', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetch);

    await variantsApi.delete('prj_1', 'ep_1', 'var_1', 3, {
      expectedEndpointRevision: 7,
      replacementVariantId: 'var_2',
    });
    await variantsApi.delete('prj_1', 'ep_1', 'var_unused', 4);

    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      expectedRevision: 3,
      expectedEndpointRevision: 7,
      replacementVariantId: 'var_2',
    });
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({
      expectedRevision: 4,
    });
  });
});

describe('canonical dashboard API contracts', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uploads raw bytes with exact Blob identity and cancellation signal', async () => {
    const bodyAsset = {
      schemaVersion: 4,
      id: 'a'.repeat(64),
      mediaType: 'application/json',
      size: 7,
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(bodyAsset), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetch);
    const blob = new Blob(['{"a":1}'], { type: 'application/json' });
    const controller = new AbortController();

    await bodiesApi.upload('prj_1', blob, controller.signal);

    const [, init] = fetch.mock.calls[0] ?? [];
    expect(init?.body).toBe(blob);
    expect(init?.signal).toBe(controller.signal);
    expect(init?.headers).toMatchObject({ 'Content-Type': 'application/json' });
  });

  it('uses the six canonical Traffic operations with encoded relative URLs', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ entries: [], hasMore: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'traffic/1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response('captured', { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ endpointId: 'ep_1' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetch);
    const controller = new AbortController();
    const promotion: TrafficPromotionInput = {
      expectedTrafficGeneration: 'generation-1',
      expectedResponseIdentity: 'response-1',
      endpoint: { action: 'create' },
      state: { action: 'unbound' },
    };

    await trafficApi.list('project/1', { afterId: 'traffic/0', limit: 25 }, controller.signal);
    await trafficApi.detail('project/1', 'traffic#1', controller.signal);
    await trafficApi.clear('project/1', controller.signal);
    const body = await trafficApi.body('project/1', 'traffic#1', 'response', controller.signal);
    await trafficApi.promote('project/1', 'traffic#1', promotion, controller.signal);

    expect(body).toBeInstanceOf(Response);
    expect(await body.text()).toBe('captured');
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      '/api/admin/projects/project%2F1/traffic?afterId=traffic%2F0&limit=25',
      expect.objectContaining({ signal: controller.signal }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      '/api/admin/projects/project%2F1/traffic/traffic%231',
      expect.objectContaining({ signal: controller.signal }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      3,
      '/api/admin/projects/project%2F1/traffic',
      expect.objectContaining({ method: 'DELETE', signal: controller.signal }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      4,
      '/api/admin/projects/project%2F1/traffic/traffic%231/bodies/response',
      expect.objectContaining({ signal: controller.signal }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      5,
      '/api/admin/projects/project%2F1/traffic/traffic%231/mock',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify(promotion),
        signal: controller.signal,
      }),
    );
    expect(trafficApi.bodyDownloadUrl('project/1', 'traffic#1', 'request')).toBe(
      '/api/admin/projects/project%2F1/traffic/traffic%231/bodies/request?download=1',
    );
  });

  it('surfaces the temporary canonical Traffic promotion error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: 'TRAFFIC_PROMOTION_UNAVAILABLE',
      message: 'Traffic promotion is unavailable',
      requestId: 'req_traffic',
    }), {
      status: 501,
      headers: { 'Content-Type': 'application/json' },
    })));

    await expect(trafficApi.promote('prj_1', 'traffic_1', {
      expectedTrafficGeneration: 'generation-1',
      expectedResponseIdentity: 'response-1',
      endpoint: { action: 'create' },
      state: { action: 'unbound' },
    })).rejects.toMatchObject({
      status: 501,
      code: 'TRAFFIC_PROMOTION_UNAVAILABLE',
      requestId: 'req_traffic',
    });
  });

  it('sends schema-v4 mode and full runtime-setting commands', async () => {
    const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify({}), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetch);

    await endpointsApi.setMode('prj/1', 'ep#1', 'passthrough', 4);
    await statesApi.setMode('prj/1', 'disabled', 7);
    await projectsApi.updateRuntimeSettings('prj/1', {
      interceptHosts: ['API.EXAMPLE.TEST'],
      captureRawTraffic: true,
      debugProvenanceHeaders: false,
      expectedRevision: 3,
    });

    expect(fetch).toHaveBeenNthCalledWith(1,
      '/api/admin/projects/prj%2F1/endpoints/ep%231/mode',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ mode: 'passthrough', expectedRevision: 4 }),
      }));
    expect(fetch).toHaveBeenNthCalledWith(2,
      '/api/admin/projects/prj%2F1/app-state-mode',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ appStateMode: 'disabled', expectedProjectRevision: 7 }),
      }));
    expect(JSON.parse(String(fetch.mock.calls[2]?.[1]?.body))).toEqual({
      interceptHosts: ['API.EXAMPLE.TEST'],
      captureRawTraffic: true,
      debugProvenanceHeaders: false,
      expectedRevision: 3,
    });
  });

  it('encodes repeated interception guidance origins without mutating settings', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      configuredPatterns: [], origins: [], unusedPatterns: [],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch);

    await interceptionGuidanceApi.get('prj/1', [
      'https://api.example.test:8443',
      'http://events.example.test',
    ]);

    expect(fetch).toHaveBeenCalledWith(
      '/api/admin/projects/prj%2F1/interception-guidance?origin=https%3A%2F%2Fapi.example.test%3A8443&origin=http%3A%2F%2Fevents.example.test',
      expect.objectContaining({ signal: undefined }),
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('preserves browser-safe import previews and exact preview/commit request semantics', async () => {
    const commitResult: ImportCommitResult = {
      createdEndpointIds: [],
      updatedEndpointIds: ['ep_primary'],
      createdVariantIds: ['var_created'],
      skippedItemIds: [],
    };
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(publicPreviewFixture), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify(commitResult), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetch);
    const previewInput: ImportPreviewRequest = {
      source: { type: 'postman', collection: { info: { name: 'Fixture' }, item: [] } },
      variables: { host: 'api.example.test' },
    };
    const commitInput: ImportCommitRequest = {
      ...previewInput,
      snapshotToken: publicPreviewFixture.snapshotToken,
      selectedItemIds: ['item-users'],
      actions: [{ itemId: 'item-users', action: 'merge', endpointId: 'ep_primary' }],
    };
    const controller = new AbortController();

    const preview = await importApi.preview('prj/1', previewInput, controller.signal);
    const browserPreviewData: ImportPreviewData = preview;
    expect(preview).toEqual(publicPreviewFixture);
    expect(browserPreviewData.sourceType).toBe('postman');
    expect(preview.items[0].responses[0].body).toEqual({
      kind: 'sha256', sha256: 'ab'.repeat(32), byteCount: 2,
    });
    expect(preview.items[0].exactTargets.map(target => target.candidateResponses)).toEqual([
      [hashedResponse],
      [bodylessResponse],
    ]);
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      '/api/admin/projects/prj%2F1/import/preview',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify(previewInput),
        signal: controller.signal,
      }),
    );

    await expect(importApi.commit('prj/1', commitInput)).resolves.toEqual(commitResult);
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      '/api/admin/projects/prj%2F1/import/commit',
      expect.objectContaining({ method: 'POST', body: JSON.stringify(commitInput) }),
    );
    expect(fetch.mock.calls[1]?.[1]).not.toHaveProperty('signal');
  });

  it('preserves conflict metadata on ApiClientError', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: 'REVISION_CONFLICT',
      message: 'Variant changed',
      details: { currentRevision: 4 },
      recovery: 'Reload or merge the server version.',
      requestId: 'req_1',
    }), {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetch);

    await expect(variantsApi.update('prj_1', 'ep_1', 'var_1', 3, { name: 'Local' }))
      .rejects.toMatchObject({
        code: 'REVISION_CONFLICT',
        currentRevision: 4,
        recovery: 'Reload or merge the server version.',
        requestId: 'req_1',
      });
  });

  it.each([
    { currentRevision: -1 },
    { currentRevision: 1.5 },
    { currentRevision: '4' },
    null,
  ])('does not derive invalid conflict revisions from $currentRevision', async details => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: 'REVISION_CONFLICT',
      message: 'Variant changed',
      details,
      requestId: 'req_1',
    }), {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetch);

    const error = await variantsApi.update('prj_1', 'ep_1', 'var_1', 3, { name: 'Local' })
      .catch((caught: unknown) => caught);

    expect(error).not.toHaveProperty('currentRevision', expect.any(Number));
  });
});
