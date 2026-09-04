import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';

import request from 'supertest';
import type { Response } from 'supertest';
import { vi } from 'vitest';

import { createApp } from '../app';
import { normalizeHttpOrigin } from '../domain/http-origin';
import type { BodyAsset, EndpointDetail, Project, ResponseHeaders } from '../domain/model';
import { createSetupRouter } from '../routes/setup';
import { createNodeUpstreamTransport } from '../services/upstream-transport';
import {
  createIntegrationHarness,
  hashTree,
  type IntegrationHarness,
} from './integration-harness';

const MAX_BODY_BYTES = 10 * 1024 * 1024;
const binaryBytes = Buffer.from([0, 255, 1, 254]);

function binaryParser(
  response: NodeJS.ReadableStream,
  callback: (error: Error | null, body?: Buffer) => void,
): void {
  const chunks: Buffer[] = [];
  response.on('data', chunk => chunks.push(Buffer.from(chunk)));
  response.on('end', () => callback(null, Buffer.concat(chunks)));
  response.on('error', callback);
}

async function createProject(
  harness: IntegrationHarness,
  input: { name?: string } = {},
): Promise<Project> {
  const response = await harness.request.post('/api/admin/projects').send({
    name: input.name ?? 'Integration Project',
  });
  expect(response.status).toBe(201);
  return response.body as Project;
}

async function selectProject(harness: IntegrationHarness, projectId: string): Promise<void> {
  const workspace = (await harness.request.get('/api/admin/workspace')).body as { revision: number };
  await harness.request.put('/api/admin/workspace').send({
    expectedRevision: workspace.revision,
    activeProjectId: projectId,
  }).expect(200);
}

async function configureTraffic(
  harness: IntegrationHarness,
  projectId: string,
  interceptHosts: string[],
  captureRawTraffic = false,
): Promise<void> {
  const settings = harness.repository.getRuntimeSettings(projectId);
  await harness.request.put(`/api/admin/projects/${projectId}/runtime-settings`).send({
    expectedRevision: settings.revision,
    interceptHosts,
    captureRawTraffic,
    debugProvenanceHeaders: false,
  }).expect(200);
}

async function uploadBody(
  harness: IntegrationHarness,
  projectId: string,
  bytes: Buffer,
  mediaType = 'application/octet-stream',
): Promise<BodyAsset> {
  const upload = harness.request
    .post(`/api/admin/projects/${projectId}/bodies`)
    .set('Content-Type', mediaType);
  const response = await new Promise<Response>((resolve, reject) => {
    upload.write(bytes);
    upload.end((error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
  expect(response.status).toBe(201);
  return response.body as BodyAsset;
}

async function streamJsonBody(
  harness: IntegrationHarness,
  projectId: string,
  bytes: Buffer,
): Promise<Response> {
  const upload = harness.request
    .post(`/api/admin/projects/${projectId}/bodies`)
    .set('Content-Type', 'application/json');
  return new Promise((resolve, reject) => {
    for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
      upload.write(bytes.subarray(offset, offset + 64 * 1024));
    }
    upload.end((error, response) => {
      if (error) reject(error);
      else resolve(response);
    });
  });
}

async function downloadBody(
  harness: IntegrationHarness,
  projectId: string,
  assetId: string,
): Promise<Response> {
  return harness.request
    .get(`/api/admin/projects/${projectId}/bodies/${assetId}`)
    .buffer(true)
    .parse(binaryParser);
}

async function createEndpoint(
  harness: IntegrationHarness,
  projectId: string,
  options: {
    name?: string;
    baseUrl?: string;
    mode?: 'mock' | 'passthrough';
    requestPath?: string;
    variants: Array<{
      name: string;
      status?: number;
      responseHeaders?: ResponseHeaders;
      bodyAssetId?: string;
    }>;
    defaultVariantIndex?: number;
  },
): Promise<EndpointDetail> {
  const response = await harness.request
    .post(`/api/admin/projects/${projectId}/endpoints`)
    .send({
      name: options.name ?? 'Integration Endpoint',
      baseUrl: options.baseUrl ?? 'http://api.example.test',
      matcher: {
        method: 'GET',
        path: options.requestPath ?? '/integration',
      },
      mode: options.mode ?? 'mock',
      variants: options.variants.map(variant => ({
        name: variant.name,
        status: variant.status ?? 200,
        responseHeaders: variant.responseHeaders ?? {},
        ...(variant.bodyAssetId === undefined ? {} : { bodyAssetId: variant.bodyAssetId }),
      })),
      ...(options.defaultVariantIndex === undefined && options.variants.length === 0
        ? {}
        : { defaultVariantIndex: options.defaultVariantIndex ?? 0 }),
    });
  expect(response.status).toBe(201);
  return response.body as EndpointDetail;
}

async function selectedGenerationDirectory(
  harness: IntegrationHarness,
  projectId: string,
): Promise<string> {
  const pointer = await harness.readJson(`projects/${projectId}/current.json`) as { generationId: string };
  return path.join(harness.rootDirectory, 'projects', projectId, 'generations', pointer.generationId);
}

function expectNoConversionPaths(tree: Record<string, string>): void {
  const forbidden = Object.keys(tree).filter(file => file.split('/').some(segment =>
    ['migration-staging', 'migration-backups', 'pending-migrations'].includes(segment)
      || segment.endsWith('.retired')
      || segment.endsWith('.quarantine')));
  expect(forbidden).toEqual([]);
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close(error => {
    if (error) reject(error);
    else resolve();
  }));
}

it('starts and restarts a clean schema-v4 root', async () => {
  const configuredDataDirectory = process.env.MOCKMATE_DATA_DIR;
  const harness = await createIntegrationHarness();
  try {
    expect(process.env.MOCKMATE_DATA_DIR).toBe(configuredDataDirectory);
    expect((await harness.request.get('/api/admin/projects')).body).toEqual([]);
    expect((await harness.request.get('/api/admin/workspace')).body)
      .toEqual({ schemaVersion: 4, revision: 0 });
    expect(await harness.readJson('workspace.json')).toEqual({ schemaVersion: 4, revision: 0 });
    expect(await harness.listRootEntries()).toEqual(expect.arrayContaining(['projects', 'trash', 'workspace.json']));
    const beforeRestart = await hashTree(harness.rootDirectory);
    expectNoConversionPaths(beforeRestart);
    await harness.restart();
    expect((await harness.request.get('/api/admin/projects')).body).toEqual([]);
    expect((await harness.request.get('/api/admin/workspace')).body)
      .toEqual({ schemaVersion: 4, revision: 0 });
    expect(process.env.MOCKMATE_DATA_DIR).toBe(configuredDataDirectory);
    const afterRestart = await hashTree(harness.rootDirectory);
    expect(afterRestart).toEqual(beforeRestart);
    expectNoConversionPaths(afterRestart);
  } finally {
    await harness.dispose();
  }
});

it('persists canonical selection and response across restart', async () => {
  const harness = await createIntegrationHarness();
  try {
    const project = await createProject(harness);
    const bytes = Buffer.from('{"persisted":true}');
    const asset = await uploadBody(harness, project.id, bytes, 'application/json');
    const endpoint = await createEndpoint(harness, project.id, {
      requestPath: '/persisted',
      variants: [{ name: 'Persisted', bodyAssetId: asset.id }],
    });
    await configureTraffic(harness, project.id, ['api.example.test']);
    await selectProject(harness, project.id);

    const before = {
      project: (await harness.request.get(`/api/admin/projects/${project.id}`)).body,
      endpoint: (await harness.request.get(`/api/admin/projects/${project.id}/endpoints/${endpoint.id}`)).body,
      workspace: (await harness.request.get('/api/admin/workspace')).body,
      pointer: await harness.readJson(`projects/${project.id}/current.json`),
      tree: await hashTree(harness.rootDirectory),
    };
    const firstResponse = await harness.request.get('/persisted').set('Host', 'api.example.test').buffer(true).parse(binaryParser);
    expect(firstResponse.body).toEqual(bytes);

    await harness.restart();

    expect((await harness.request.get(`/api/admin/projects/${project.id}`)).body).toEqual(before.project);
    expect((await harness.request.get(`/api/admin/projects/${project.id}/endpoints/${endpoint.id}`)).body)
      .toEqual(before.endpoint);
    expect((await harness.request.get('/api/admin/workspace')).body).toEqual(before.workspace);
    expect(await harness.readJson(`projects/${project.id}/current.json`)).toEqual(before.pointer);
    expect(await hashTree(harness.rootDirectory)).toEqual(before.tree);
    expect((await harness.request.get('/persisted').set('Host', 'api.example.test').buffer(true).parse(binaryParser)).body).toEqual(bytes);
    expectNoConversionPaths(before.tree);
  } finally {
    await harness.dispose();
  }
});

it('rejects unsupported canonical records without publishing them', async () => {
  const harness = await createIntegrationHarness();
  try {
    const project = await createProject(harness);
    const generation = await selectedGenerationDirectory(harness, project.id);
    const projectFile = path.join(generation, 'project.json');
    const record = JSON.parse(await fs.promises.readFile(projectFile, 'utf8')) as Record<string, unknown>;
    await fs.promises.writeFile(projectFile, JSON.stringify({ ...record, schemaVersion: 2 }));
    const before = await hashTree(harness.rootDirectory);

    await harness.restart();

    expect((await harness.request.get('/api/admin/projects')).body)
      .not.toContainEqual(expect.objectContaining({ id: project.id }));
    const diagnostics = await harness.request.get('/api/admin/diagnostics').expect(200);
    expect(diagnostics.body.diagnostics).toContainEqual(expect.objectContaining({
      projectId: project.id,
      severity: 'blocking',
      code: 'UNSUPPORTED_SCHEMA_VERSION',
      file: expect.stringContaining('project.json'),
      path: '$.schemaVersion',
      recovery: expect.any(String),
    }));
    expect(await hashTree(harness.rootDirectory)).toEqual(before);
    expectNoConversionPaths(before);
  } finally {
    await harness.dispose();
  }
});

it('ignores legacy Resource Scenario storage', async () => {
  const harness = await createIntegrationHarness();
  try {
    const legacyRoot = path.join(harness.rootDirectory, 'legacy-project');
    await fs.promises.mkdir(path.join(legacyRoot, 'resources'), { recursive: true });
    await fs.promises.mkdir(path.join(legacyRoot, 'scenarios'), { recursive: true });
    await fs.promises.writeFile(path.join(legacyRoot, 'project.json'), JSON.stringify({
      id: 'legacy-project', name: 'Legacy Project', activeScenarioId: 'scenario-one',
    }));
    await fs.promises.writeFile(path.join(legacyRoot, 'resources', 'users.json'), JSON.stringify({
      id: 'users', method: 'GET', path: '/legacy-users',
    }));
    await fs.promises.writeFile(path.join(legacyRoot, 'scenarios', 'scenario-one.json'), JSON.stringify({
      id: 'scenario-one', resources: ['users'],
    }));
    const before = await hashTree(harness.rootDirectory);

    await harness.restart();
    expect((await harness.request.get('/api/admin/projects')).body).toEqual([]);
    expect(await hashTree(harness.rootDirectory)).toEqual(before);
    await harness.restart();
    expect((await harness.request.get('/api/admin/projects')).body).toEqual([]);
    expect(await hashTree(harness.rootDirectory)).toEqual(before);
    expectNoConversionPaths(before);
  } finally {
    await harness.dispose();
  }
});

it('captures and promotes an exact passthrough response', async () => {
  const capturedBytes = Buffer.from('{"captured":true}');
  const upstream = http.createServer((_incoming, response) => {
      response.writeHead(202, {
        'content-type': 'application/json',
      'content-length': String(capturedBytes.length),
    });
    response.end(capturedBytes);
  });
  await new Promise<void>((resolve, reject) => {
    upstream.listen(0, '127.0.0.1', resolve);
    upstream.once('error', reject);
  });
  const address = upstream.address();
  if (!address || typeof address === 'string') throw new Error('Upstream did not bind a TCP port');
  const nodeTransport = createNodeUpstreamTransport();
  const harness = await createIntegrationHarness({
    upstreamTransport: {
      forward: request => nodeTransport.forward({
        ...request,
        authority: {
          ...request.authority,
          origin: normalizeHttpOrigin(`http://127.0.0.1:${address.port}`),
        },
      }),
    },
  });
  try {
    const project = await createProject(harness);
    await createEndpoint(harness, project.id, {
      name: 'Captured passthrough',
      baseUrl: `http://upstream.example.test:${address.port}`,
      mode: 'passthrough',
      requestPath: '/captured',
      variants: [],
    });
    await configureTraffic(harness, project.id, ['upstream.example.test'], true);
    await selectProject(harness, project.id);

    const proxy = await harness.proxy();
    const captured = await proxy.requestPlain({
      host: `upstream.example.test:${address.port}`,
      path: '/captured',
    });
    expect(captured.statusCode).toBe(202);
    expect(captured.body).toEqual(capturedBytes);
    let page!: Response;
    await vi.waitFor(async () => {
      page = await harness.request.get(`/api/admin/projects/${project.id}/traffic`).expect(200);
      expect(page.body.entries).toHaveLength(1);
    });
    const trafficId = page.body.entries.at(-1).id as string;
    const detail = await harness.request
      .get(`/api/admin/projects/${project.id}/traffic/${trafficId}`)
      .expect(200);
    expect(detail.body).toMatchObject({ id: trafficId, decision: 'endpoint_passthrough' });
    expect((await harness.request
      .get(`/api/admin/projects/${project.id}/traffic/${trafficId}/bodies/response`)
      .buffer(true)
      .parse(binaryParser)).body).toEqual(capturedBytes);
    expect(detail.body.promotion.state).toBe('eligible');
    const review = detail.body.promotion.review;
    await harness.request
      .post(`/api/admin/projects/${project.id}/traffic/${trafficId}/mock`)
      .send({
        expectedTrafficGeneration: review.expectedTrafficGeneration,
        expectedResponseIdentity: review.expectedResponseIdentity,
        endpoint: review.endpoint.action === 'create'
          ? { action: 'create' }
          : {
            action: 'reuse',
            endpointId: review.endpoint.endpointId,
            expectedRevision: review.endpoint.expectedRevision,
          },
        state: review.state,
      })
      .expect(200)
      .expect(response => {
        expect(response.body).toMatchObject({
          endpointId: expect.any(String),
          variantId: expect.any(String),
        });
      });
  } finally {
    if (upstream.listening) await closeServer(upstream);
    await harness.dispose();
  }
}, 30_000);

it('serves binary assets through direct and intercepted paths', async () => {
  const harness = await createIntegrationHarness();
  try {
    const project = await createProject(harness);
    const asset = await uploadBody(harness, project.id, binaryBytes);
    await createEndpoint(harness, project.id, {
      baseUrl: 'http://api.example.test',
      requestPath: '/binary',
      variants: [{ name: 'Binary', bodyAssetId: asset.id }],
    });
    await harness.request.put(`/api/admin/projects/${project.id}/runtime-settings`).send({
      expectedRevision: 0,
      interceptHosts: ['api.example.test'],
      captureRawTraffic: false,
      debugProvenanceHeaders: false,
    }).expect(200);
    await selectProject(harness, project.id);

    const direct = await harness.request
      .get('/binary')
      .set('Host', 'api.example.test')
      .buffer(true)
      .parse(binaryParser);
    const proxy = await harness.proxy();
    const intercepted = await proxy.requestPlain({ host: 'api.example.test', path: '/binary' });

    expect(direct.body).toEqual(binaryBytes);
    expect(direct.headers['content-type']).toContain('application/octet-stream');
    expect(direct.headers['content-length']).toBe(String(binaryBytes.length));
    expect(intercepted.body).toEqual(binaryBytes);
    expect(intercepted.headers['content-type']).toContain('application/octet-stream');
    expect(intercepted.headers['content-length']).toBe(String(binaryBytes.length));

    await harness.restart();
    await expect(proxy.requestPlain({ host: 'api.example.test', path: '/binary' }))
      .rejects.toThrow();
    await expect(proxy.close()).resolves.toBeUndefined();
    await expect(proxy.close()).resolves.toBeUndefined();
  } finally {
    await harness.dispose();
  }
});

it('accepts exactly 10 MiB JSON and rejects one extra byte', async () => {
  const harness = await createIntegrationHarness();
  try {
    const project = await createProject(harness);
    const exact = Buffer.concat([
      Buffer.from('"'),
      Buffer.alloc(MAX_BODY_BYTES - 2, 0x61),
      Buffer.from('"'),
    ]);
    const exactUpload = await streamJsonBody(harness, project.id, exact);
    expect(exactUpload.status).toBe(201);
    expect(exactUpload.body).toMatchObject({
      id: createHash('sha256').update(exact).digest('hex'),
      size: MAX_BODY_BYTES,
    });
    const downloaded = await downloadBody(harness, project.id, exactUpload.body.id as string);
    expect(createHash('sha256').update(downloaded.body as Buffer).digest('hex'))
      .toBe(createHash('sha256').update(exact).digest('hex'));

    const tooLarge = Buffer.concat([
      Buffer.from('"'),
      Buffer.alloc(MAX_BODY_BYTES - 1, 0x61),
      Buffer.from('"'),
    ]);
    const rejected = await streamJsonBody(harness, project.id, tooLarge);
    expect(rejected.status).toBe(413);
    expect(rejected.body).toMatchObject({
      code: 'BODY_TOO_LARGE',
      requestId: expect.any(String),
    });
  } finally {
    await harness.dispose();
  }
}, 30_000);

it('keeps Endpoint summaries body-independent', async () => {
  const harness = await createIntegrationHarness();
  try {
    const project = await createProject(harness);
    const small = await uploadBody(harness, project.id, Buffer.of(0x61));
    const large = await uploadBody(harness, project.id, Buffer.alloc(MAX_BODY_BYTES, 0x61));
    const smallEndpoint = await createEndpoint(harness, project.id, {
      name: 'Small', requestPath: '/small', variants: [{ name: 'Body', bodyAssetId: small.id }],
    });
    const largeEndpoint = await createEndpoint(harness, project.id, {
      name: 'Large', requestPath: '/large', variants: [{ name: 'Body', bodyAssetId: large.id }],
    });

    const summaries = (await harness.request
      .get(`/api/admin/projects/${project.id}/endpoints`)
      .expect(200)).body as Array<{ id: string; variantCount: number }>;
    const smallSummary = summaries.find(endpoint => endpoint.id === smallEndpoint.id)!;
    const largeSummary = summaries.find(endpoint => endpoint.id === largeEndpoint.id)!;
    expect(smallSummary).toMatchObject({ variantCount: 1 });
    expect(largeSummary).toMatchObject({ variantCount: 1 });
    expect(smallSummary).not.toHaveProperty('variants');
    expect(largeSummary).not.toHaveProperty('variants');
    expect(JSON.stringify(smallSummary)).not.toContain(small.id);
    expect(JSON.stringify(largeSummary)).not.toContain(large.id);
    expect(Buffer.byteLength(JSON.stringify(smallSummary)))
      .toBe(Buffer.byteLength(JSON.stringify(largeSummary)));
  } finally {
    await harness.dispose();
  }
}, 30_000);

it('preserves disk memory and delivery on failed mutation', async () => {
  const harness = await createIntegrationHarness();
  try {
    const project = await createProject(harness);
    const oldBytes = Buffer.from('old response');
    const asset = await uploadBody(harness, project.id, oldBytes, 'text/plain');
    const endpoint = await createEndpoint(harness, project.id, {
      requestPath: '/atomic', variants: [{ name: 'Old', bodyAssetId: asset.id }],
    });
    await configureTraffic(harness, project.id, ['api.example.test']);
    await selectProject(harness, project.id);
    const generation = await selectedGenerationDirectory(harness, project.id);
    const generationBefore = await hashTree(generation);
    const repositoryBefore = harness.repository.getEndpoint(project.id, endpoint.id);

    harness.failNextRename();
    const failed = await harness.request
      .put(`/api/admin/projects/${project.id}/endpoints/${endpoint.id}`)
      .send({ expectedRevision: endpoint.revision, patch: { name: 'New' } });

    expect(failed.status).toBe(500);
    expect(await hashTree(generation)).toEqual(generationBefore);
    expect(harness.repository.getEndpoint(project.id, endpoint.id)).toEqual(repositoryBefore);
    expect((await harness.request.get('/atomic').set('Host', 'api.example.test').buffer(true).parse(binaryParser)).body)
      .toEqual(oldBytes);
  } finally {
    await harness.dispose();
  }
});

it('surfaces corrupt persistence through global diagnostics', async () => {
  const harness = await createIntegrationHarness();
  try {
    const project = await createProject(harness);
    const bodySentinel = Buffer.from('corrupt-body-sentinel-5f6df9a4');
    const asset = await uploadBody(harness, project.id, bodySentinel, 'text/plain');
    const endpoint = await createEndpoint(harness, project.id, {
      requestPath: '/broken', variants: [{ name: 'Broken', bodyAssetId: asset.id }],
    });
    await configureTraffic(harness, project.id, ['api.example.test']);
    const bodyDirectory = path.join(
      harness.rootDirectory,
      'projects',
      project.id,
      'bodies',
      'sha256',
      asset.id.slice(0, 2),
    );
    const bodyFile = path.join(bodyDirectory, asset.id);
    expect(await fs.promises.readFile(bodyFile)).toEqual(bodySentinel);
    await fs.promises.unlink(path.join(bodyDirectory, `${asset.id}.json`));
    const before = await hashTree(harness.rootDirectory);

    await harness.restart();

    const response = await harness.request.get('/api/admin/diagnostics').expect(200);
    expect(response.body.diagnostics).toContainEqual(expect.objectContaining({
      projectId: project.id,
      severity: 'blocking',
      code: 'MISSING_BODY_ASSET',
      file: expect.stringContaining(`${endpoint.id}.json`),
      path: '$.variants[0].bodyAssetId',
      recovery: expect.any(String),
    }));
    expect(await fs.promises.readFile(bodyFile)).toEqual(bodySentinel);
    expect(JSON.stringify(response.body)).not.toContain(bodySentinel.toString('utf8'));
    expect((await harness.request.get('/api/admin/projects')).body)
      .not.toContainEqual(expect.objectContaining({ id: project.id }));
    expect(await hashTree(harness.rootDirectory)).toEqual(before);
    expectNoConversionPaths(before);
  } finally {
    await harness.dispose();
  }
});

it('reports revision conflicts without overwriting', async () => {
  const harness = await createIntegrationHarness();
  try {
    const project = await createProject(harness);
    const endpoint = await createEndpoint(harness, project.id, {
      requestPath: '/revision', variants: [{ name: 'Revision' }],
    });
    let current = endpoint;
    for (const name of ['Revision one', 'Revision two', 'Revision three']) {
      const response = await harness.request
        .put(`/api/admin/projects/${project.id}/endpoints/${endpoint.id}`)
        .send({ expectedRevision: current.revision, patch: { name } })
        .expect(200);
      current = response.body as EndpointDetail;
    }
    expect(current.revision).toBe(3);
    const beforeTree = await hashTree(harness.rootDirectory);
    const beforeRepository = harness.repository.getEndpoint(project.id, endpoint.id);

    const conflict = await harness.request
      .put(`/api/admin/projects/${project.id}/endpoints/${endpoint.id}`)
      .send({ expectedRevision: 2, patch: { name: 'stale overwrite' } });

    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({
      code: 'REVISION_CONFLICT',
      details: { currentRevision: 3 },
      requestId: expect.any(String),
    });
    expect(harness.repository.getEndpoint(project.id, endpoint.id)).toEqual(beforeRepository);
    expect(await hashTree(harness.rootDirectory)).toEqual(beforeTree);
  } finally {
    await harness.dispose();
  }
});

it('reports partial-state fallback provenance', async () => {
  const harness = await createIntegrationHarness();
  try {
    const project = await createProject(harness);
    const defaultAsset = await uploadBody(harness, project.id, Buffer.from('default'), 'text/plain');
    const baseAsset = await uploadBody(harness, project.id, Buffer.from('base'), 'text/plain');
    const endpoint = await createEndpoint(harness, project.id, {
      requestPath: '/stateful',
      variants: [
        { name: 'Default', bodyAssetId: defaultAsset.id },
        { name: 'Base', bodyAssetId: baseAsset.id },
      ],
    });
    const active = await harness.request.post(`/api/admin/projects/${project.id}/states`).send({
      name: 'Active', tags: [], bindings: {},
    }).expect(201);
    const base = await harness.request.post(`/api/admin/projects/${project.id}/states`).send({
      name: 'Base', tags: [], bindings: { [endpoint.id]: endpoint.variants[1].id },
    }).expect(201);
    await configureTraffic(harness, project.id, ['api.example.test']);
    const currentProject = (await harness.request.get(`/api/admin/projects/${project.id}`)).body as Project;
    await harness.request.put(`/api/admin/projects/${project.id}/state-selection`).send({
      expectedRevision: currentProject.revision,
      activeStateId: active.body.id,
      baseStateId: base.body.id,
      allowFallback: true,
    }).expect(200);
    await selectProject(harness, project.id);

    const delivered = await harness.request
      .get('/stateful')
      .set('Host', 'api.example.test')
      .buffer(true)
      .parse(binaryParser);
    expect(delivered.body).toEqual(Buffer.from('base'));
    const traffic = await harness.request.get(`/api/admin/projects/${project.id}/traffic`).expect(200);
    const detail = await harness.request
      .get(`/api/admin/projects/${project.id}/traffic/${traffic.body.entries.at(-1).id}`)
      .expect(200);
    expect(detail.body).toMatchObject({
      endpoint: { id: endpoint.id },
      variantId: endpoint.variants[1].id,
      appState: {
        selectedStateId: base.body.id,
        resolutionSource: 'project_base_state',
        fallbackReasons: ['active_state_unbound'],
      },
    });
  } finally {
    await harness.dispose();
  }
});

it('preserves mobile automation selection when a bound Variant deletion is blocked', async () => {
  const harness = await createIntegrationHarness();
  try {
    const project = await createProject(harness);
    const firstAsset = await uploadBody(harness, project.id, Buffer.from('first body'), 'text/plain');
    const replacementAsset = await uploadBody(
      harness,
      project.id,
      Buffer.from('replacement body'),
      'text/plain',
    );
    const endpoint = await createEndpoint(harness, project.id, {
      requestPath: '/mobile/profile',
      variants: [
        {
          name: 'First',
          status: 201,
          responseHeaders: { 'Set-Cookie': ['session=one', 'theme=dark'] },
          bodyAssetId: firstAsset.id,
        },
        {
          name: 'Replacement',
          status: 202,
          responseHeaders: { 'Set-Cookie': ['session=replaced', 'theme=light'] },
          bodyAssetId: replacementAsset.id,
        },
      ],
    });
    await configureTraffic(harness, project.id, ['api.example.test']);
    const state = await harness.request.post(`/api/admin/projects/${project.id}/states`).send({
      name: 'Mobile suite',
      tags: [],
      bindings: { [endpoint.id]: endpoint.variants[0].id },
    }).expect(201);
    const stateId = state.body.id as string;
    await selectProject(harness, project.id);

    await harness.request
      .put('/setMockServerflags')
      .send({ projectId: project.id, stateId, clearTraffic: true })
      .expect(204);

    const first = await harness.request
      .get('/mobile/profile')
      .set('Host', 'api.example.test')
      .buffer(true)
      .parse(binaryParser)
      .expect(201);
    expect(first.headers['set-cookie']).toEqual(['session=one', 'theme=dark']);
    expect(first.body).toEqual(Buffer.from('first body'));

    const currentEndpoint = (await harness.request
      .get(`/api/admin/projects/${project.id}/endpoints/${endpoint.id}`)
      .expect(200)).body as EndpointDetail;
    const boundVariant = currentEndpoint.variants.find(variant => variant.id === endpoint.variants[0].id)!;
    const replacementVariant = currentEndpoint.variants.find(
      variant => variant.id === endpoint.variants[1].id,
    )!;
    const blocked = await harness.request
      .delete(`/api/admin/projects/${project.id}/endpoints/${endpoint.id}/variants/${boundVariant.id}`)
      .send({
        expectedRevision: boundVariant.revision,
        expectedEndpointRevision: currentEndpoint.revision,
        replacementVariantId: replacementVariant.id,
      });
    expect(blocked.status).toBe(409);
    expect(blocked.body).toMatchObject({ code: 'VARIANT_IN_USE' });

    const reboundState = await harness.request
      .get(`/api/admin/projects/${project.id}/states/${stateId}`)
      .expect(200);
    expect(reboundState.body.id).toBe(stateId);
    expect(reboundState.body.bindings).toEqual({ [endpoint.id]: boundVariant.id });

    await harness.request
      .post('/setMockServerflags')
      .send({ stateId })
      .expect(204);

    const second = await harness.request
      .get('/mobile/profile')
      .set('Host', 'api.example.test')
      .buffer(true)
      .parse(binaryParser)
      .expect(201);
    expect(second.headers['set-cookie']).toEqual(['session=one', 'theme=dark']);
    expect(second.body).toEqual(Buffer.from('first body'));

    const unknown = await harness.request
      .post('/setMockServerflags')
      .send({ stateId: 'state_unknown' })
      .expect(404);
    expect(unknown.body).toMatchObject({
      code: 'STATE_NOT_FOUND',
      requestId: expect.any(String),
    });
    expect((await harness.request.get(`/api/admin/projects/${project.id}`).expect(200)).body.activeStateId)
      .toBe(stateId);

    const preserved = await harness.request
      .get('/mobile/profile')
      .set('Host', 'api.example.test')
      .buffer(true)
      .parse(binaryParser)
      .expect(201);
    expect(preserved.headers['set-cookie']).toEqual(['session=one', 'theme=dark']);
    expect(preserved.body).toEqual(Buffer.from('first body'));
  } finally {
    await harness.dispose();
  }
});

it('preserves canonical static media', async () => {
  const harness = await createIntegrationHarness();
  try {
    const project = await createProject(harness);
    await selectProject(harness, project.id);
    const uploaded = await harness.request
      .post(`/api/admin/projects/${project.id}/static-files`)
      .query({ path: 'posters/home.bin' })
      .set('Content-Type', 'application/octet-stream')
      .send(binaryBytes);
    expect(uploaded.status).toBe(201);
    expect(uploaded.body.file).toEqual({
      path: 'posters/home.bin',
      size: binaryBytes.length,
      mediaType: 'application/octet-stream',
    });
    const listed = await harness.request
      .get(`/api/admin/projects/${project.id}/static-files`)
      .expect(200);
    expect(listed.body.files).toContainEqual(uploaded.body.file);

    const delivered = await harness.request
      .get('/static_files/posters/home.bin')
      .buffer(true)
      .parse(binaryParser);
    expect(delivered.body).toEqual(binaryBytes);
    expect(delivered.headers['content-type']).toContain('application/octet-stream');
  } finally {
    await harness.dispose();
  }
});

it('retains ACL CORS request IDs and sanitization', async () => {
  const harness = await createIntegrationHarness();
  try {
    const remoteApp = createApp({
      runtime: {
        rootDirectory: harness.rootDirectory,
        repository: harness.repository,
        traffic: harness.traffic,
        adminSecurity: { isAdminRequestLocal: () => false },
        dispose: async () => undefined,
      },
      setupRouter: createSetupRouter({
        certificateDirectory: path.join(harness.rootDirectory, 'certificates'),
        getPorts: () => ({ http: 0, https: 0, proxy: 0 }),
      }),
    });
    const denied = await request(remoteApp)
      .get('/api/admin/projects')
      .set('X-Request-Id', 'acl-denied-request');
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({
      code: 'ADMIN_LOCAL_ONLY',
      requestId: 'acl-denied-request',
    });
    expect(denied.headers['x-request-id']).toBe(denied.body.requestId);

    const corsDenied = await harness.request
      .get('/api/admin/projects')
      .set('Origin', 'http://unapproved.example');
    expect(corsDenied.status).toBe(200);
    expect(corsDenied.headers).not.toHaveProperty('access-control-allow-origin');

    const project = await createProject(harness);
    const secretBytes = 'rename-body-secret-2cb5e84f';
    const secretPath = `/private/mockmate-secrets/${secretBytes}.tmp`;
    const secretDest = `/private/mockmate-secrets/${secretBytes}.json`;
    const renameError = Object.assign(
      new Error(`EIO: i/o error, rename '${secretPath}' -> '${secretDest}'`),
      { code: 'EIO', syscall: 'rename', path: secretPath, dest: secretDest },
    );
    harness.failNextRename(renameError);
    const failed = await harness.request
      .put(`/api/admin/projects/${project.id}`)
      .set('X-Request-Id', 'io-failure-request')
      .send({ expectedRevision: 0, patch: { name: 'Must not persist' } });
    expect(failed.status).toBe(500);
    expect(failed.body).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
      requestId: 'io-failure-request',
    });
    expect(failed.headers['x-request-id']).toBe(failed.body.requestId);
    const serializedFailure = JSON.stringify(failed.body);
    for (const secret of [secretPath, secretDest, secretBytes]) {
      expect(serializedFailure).not.toContain(secret);
    }
  } finally {
    await harness.dispose();
  }
});
