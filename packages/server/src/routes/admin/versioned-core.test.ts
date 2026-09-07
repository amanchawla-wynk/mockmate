import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';

import type { Application } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../app';
import type { BodyAsset, RepositoryDiagnostic } from '../../domain/model';
import type { AppOptions } from '../../middleware/admin-security';
import { createAtomicFileWriter, type AtomicFileWriter } from '../../repository/atomic-write';
import { createBodyStore } from '../../repository/body-store';
import { nodeFileSystem } from '../../repository/file-system';
import {
  createProjectRepository,
  type ProjectRepository,
} from '../../repository/project-repository';
import {
  endpointRecord,
  ProjectBuilder,
  projectRecord,
  settingsRecord,
  stateRecord,
} from '../../test-support/project-builder';
import { createSetupRouter } from '../setup';
import type { TrafficService } from '../../services/traffic-service';

const MAX_BODY_BYTES = 10 * 1024 * 1024;

let root: string;
let builder: ProjectBuilder;
let repository: ProjectRepository;
let app: Application;

function repositoryAt(
  directory: string,
  options: {
    atomicWriter?: AtomicFileWriter;
    idSource?: () => string;
  } = {},
): ProjectRepository {
  const atomicWriter = options.atomicWriter ?? createAtomicFileWriter(nodeFileSystem);
  return createProjectRepository({
    rootDirectory: directory,
    atomicWriter,
    bodyStore: createBodyStore({
      rootDirectory: directory,
      atomicWriter,
      fileSystem: nodeFileSystem,
    }),
    ...(options.idSource === undefined ? {} : { idSource: options.idSource }),
  });
}

function versionedApp(
  value: ProjectRepository = repository,
  options: AppOptions = { isAdminRequestLocal: () => true },
): Application {
  return createApp({
    runtime: {
      rootDirectory: root,
      repository: value,
      traffic: {
        list: () => ({ entries: [], hasMore: false }),
        get: () => undefined,
        clear: async () => undefined,
        dispose: async () => undefined,
        promoter: { promote: async () => { throw new Error('unavailable'); } },
      } as unknown as TrafficService,
      adminSecurity: options,
      dispose: async () => undefined,
    },
    setupRouter: createSetupRouter({
      certificateDirectory: path.join(root, 'certificates'),
      getPorts: () => ({ http: 3000, https: 3443, proxy: 8080 }),
    }),
  });
}

function endpointInput(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Playback / denied? #1',
    baseUrl: 'https://api.example.test',
    matcher: {
      method: 'GET',
      path: '/playback/:id',
      query: { quality: [{ operator: 'equals', value: 'hd' }] },
      headers: { 'X-Plan': { operator: 'glob', value: 'paid*' } },
    },
    mode: 'mock',
    variants: [{
      name: 'Allowed',
      description: 'temporary',
      status: 200,
      responseHeaders: { 'Content-Type': 'application/octet-stream' },
    }],
    defaultVariantIndex: 0,
    ...overrides,
  };
}

function binaryParser(
  response: NodeJS.ReadableStream,
  callback: (error: Error | null, body?: Buffer) => void,
): void {
  const chunks: Buffer[] = [];
  response.on('data', chunk => chunks.push(Buffer.from(chunk)));
  response.on('end', () => callback(null, Buffer.concat(chunks)));
  response.on('error', callback);
}

async function captureUncaughtErrors<T>(operation: (uncaught: Promise<void>) => Promise<T>): Promise<{
  result: T;
  errors: Error[];
}> {
  if (process.hasUncaughtExceptionCaptureCallback()) {
    throw new Error('Unexpected existing uncaught-exception capture callback');
  }
  const errors: Error[] = [];
  let markUncaught!: () => void;
  const uncaught = new Promise<void>(resolve => { markUncaught = resolve; });
  process.setUncaughtExceptionCaptureCallback(error => {
    errors.push(error);
    markUncaught();
  });
  try {
    return { result: await operation(uncaught), errors };
  } finally {
    process.setUncaughtExceptionCaptureCallback(null);
  }
}

function waitForSourceClose(source: NodeJS.ReadableStream): Promise<void> {
  return new Promise(resolve => source.once('close', resolve));
}

async function createEndpoint(input = endpointInput()) {
  return request(app).post('/api/admin/projects/prj_1/endpoints').send(input);
}

async function replaceProject(
  options: Parameters<ProjectBuilder['writeValid']>[0],
): Promise<void> {
  await fs.promises.rm(builder.generationDirectory(), { recursive: true, force: true });
  await builder.writeValid(options);
  await repository.initialize();
}

async function uploadBody(bytes: Buffer, mediaType = 'application/octet-stream') {
  return request(app)
    .post('/api/admin/projects/prj_1/bodies')
    .set('Content-Type', mediaType)
    .send(bytes);
}

async function finishRawUpload(upload: ReturnType<ReturnType<typeof request>['post']>) {
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    upload.write(Buffer.from('body'));
    upload.end((error, response) => {
      if (error) reject(error);
      else resolve(response);
    });
  });
}

beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mockmate-versioned-routes-'));
  builder = new ProjectBuilder(root);
  await builder.writeValid();
  repository = repositoryAt(root);
  await repository.initialize();
  app = versionedApp();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.promises.rm(root, { recursive: true, force: true });
});

describe('canonical core application', () => {
  it('always requires an initialized repository and exposes only canonical routes', async () => {
    expect(() => createApp({ runtime: undefined as never, setupRouter: undefined as never }))
      .toThrow(/RuntimeContext/i);
    await request(app).get('/api/admin/diagnostics').expect(200);
    await request(app).get('/api/admin/status').expect(404);
    await request(app).get('/api/admin/projects/prj_1/resources').expect(404);
  });

  it('keeps the local ACL, precise CORS, request IDs, and admin 404 contract', async () => {
    const remote = versionedApp(repository, { isAdminRequestLocal: () => false });
    const denied = await request(remote).get('/api/admin/projects');
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({
      code: 'ADMIN_LOCAL_ONLY',
      requestId: expect.any(String),
    });
    expect(denied.headers['x-request-id']).toBe(denied.body.requestId);

    const corsApp = versionedApp(repository, { dashboardOrigins: ['http://dashboard.test'] });
    const preflight = await request(corsApp)
      .options('/api/admin/projects/prj_1/bodies')
      .set('Origin', 'http://dashboard.test')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type,x-mockmate-encoding');
    expect(preflight.status).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe('http://dashboard.test');
    expect(preflight.headers['access-control-allow-headers'].toLowerCase())
      .toContain('x-mockmate-encoding');

    const missing = await request(corsApp)
      .get('/api/admin/not-canonical')
      .set('Origin', 'http://dashboard.test')
      .set('X-Request-Id', 'route-contract-request');
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({
      code: 'ADMIN_ROUTE_NOT_FOUND',
      message: 'Admin route not found',
      requestId: 'route-contract-request',
    });
    expect(missing.headers['access-control-expose-headers'].toLowerCase())
      .toEqual(expect.stringContaining('content-length'));
    expect(missing.headers['access-control-expose-headers'].toLowerCase())
      .toEqual(expect.stringContaining('content-encoding'));
  });
});

describe('Project, workspace, and runtime settings routes', () => {
  it('rejects Project-owned baseUrl and updates App State mode with a strict command', async () => {
    const invalid = await request(app).post('/api/admin/projects').send({
      name: 'Invalid ownership',
      baseUrl: 'https://api.example.test',
    });
    expect(invalid.status).toBe(422);

    const updated = await request(app).put('/api/admin/projects/prj_1/app-state-mode').send({
      appStateMode: 'disabled',
      expectedProjectRevision: 1,
    });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ appStateMode: 'disabled', revision: 2 });

    await request(app).put('/api/admin/projects/prj_1/app-state-mode').send({
      appStateMode: 'enabled',
      expectedProjectRevision: 2,
      unknown: true,
    }).expect(422);
  });

  it('creates, lists, reads, updates, clears, and deletes Projects by revision', async () => {
    const created = await request(app).post('/api/admin/projects').send({
      name: 'Streaming UI',
      description: 'temporary',
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: 'Streaming UI', revision: 0 });

    const list = await request(app).get('/api/admin/projects');
    expect(list.status).toBe(200);
    expect(list.body).toContainEqual(expect.objectContaining({
      id: created.body.id,
      name: 'Streaming UI',
      revision: 0,
    }));
    expect(list.body.find((project: { id: string }) => project.id === created.body.id))
      .not.toHaveProperty('schemaVersion');

    const detail = await request(app).get(`/api/admin/projects/${created.body.id}`);
    expect(detail.body).toMatchObject({ id: created.body.id, schemaVersion: 4 });

    const updated = await request(app).put(`/api/admin/projects/${created.body.id}`).send({
      expectedRevision: 0,
      patch: { name: 'Streaming UI QA', description: null },
    });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ name: 'Streaming UI QA', revision: 1 });
    expect(updated.body).not.toHaveProperty('description');
    expect(updated.body).not.toHaveProperty('baseUrl');

    const stale = await request(app).put(`/api/admin/projects/${created.body.id}`).send({
      expectedRevision: 0,
      patch: { name: 'stale' },
    });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({
      code: 'REVISION_CONFLICT',
      details: { expectedRevision: 0, currentRevision: 1 },
      requestId: expect.any(String),
    });

    await request(app)
      .delete(`/api/admin/projects/${created.body.id}`)
      .send({ expectedRevision: 1 })
      .expect(204);
    await request(app).get(`/api/admin/projects/${created.body.id}`).expect(404);
  });

  it('persists workspace selection, null clear, conflicts, and active-delete protection', async () => {
    const initial = await request(app).get('/api/admin/workspace');
    expect(initial.body).toEqual({ schemaVersion: 4, revision: 0 });

    const selected = await request(app).put('/api/admin/workspace').send({
      expectedRevision: 0,
      activeProjectId: 'prj_1',
    });
    expect(selected.body).toEqual({ schemaVersion: 4, activeProjectId: 'prj_1', revision: 1 });
    await request(app)
      .delete('/api/admin/projects/prj_1')
      .send({ expectedRevision: 1 })
      .expect(409);

    const stale = await request(app).put('/api/admin/workspace').send({
      expectedRevision: 0,
      activeProjectId: null,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.details.currentRevision).toBe(1);

    const cleared = await request(app).put('/api/admin/workspace').send({
      expectedRevision: 1,
      activeProjectId: null,
    });
    expect(cleared.body).toEqual({ schemaVersion: 4, revision: 2 });
    expect((await request(app).get('/api/admin/workspace')).body).toEqual(cleared.body);
  });

  it('reads and updates runtime settings with their own revision', async () => {
    const initial = await request(app).get('/api/admin/projects/prj_1/runtime-settings');
    expect(initial.body).toEqual(settingsRecord());

    const updated = await request(app).put('/api/admin/projects/prj_1/runtime-settings').send({
      expectedRevision: 1,
      interceptHosts: ['API.Example.Test.'],
      captureRawTraffic: true,
      debugProvenanceHeaders: true,
    });
    expect(updated.body).toMatchObject({
      interceptHosts: ['api.example.test'],
      captureRawTraffic: true,
      debugProvenanceHeaders: true,
      revision: 2,
    });

    const stale = await request(app).put('/api/admin/projects/prj_1/runtime-settings').send({
      expectedRevision: 1,
      interceptHosts: [],
      captureRawTraffic: false,
      debugProvenanceHeaders: false,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.details.currentRevision).toBe(2);
  });

  it('requires explicit confirmation for normalized intercept-all before mutation', async () => {
    const update = vi.spyOn(repository, 'updateRuntimeSettings');
    const denied = await request(app).put('/api/admin/projects/prj_1/runtime-settings').send({
      expectedRevision: 1,
      interceptHosts: [' * '],
      captureRawTraffic: true,
      debugProvenanceHeaders: false,
    });
    expect(denied.status).toBe(422);
    expect(denied.body).toMatchObject({
      code: 'INTERCEPT_ALL_CONFIRMATION_REQUIRED',
      requestId: expect.any(String),
    });
    expect(update).not.toHaveBeenCalled();

    const saved = await request(app).put('/api/admin/projects/prj_1/runtime-settings').send({
      expectedRevision: 1,
      interceptHosts: [' * '],
      captureRawTraffic: true,
      debugProvenanceHeaders: false,
      confirmInterceptAll: true,
    });
    expect(saved.status).toBe(200);
    expect(saved.body.interceptHosts).toEqual(['*']);
    expect(saved.body).not.toHaveProperty('confirmInterceptAll');
    await request(app).put('/api/admin/projects/prj_1/runtime-settings').send({
      expectedRevision: 2,
      interceptHosts: [],
      captureRawTraffic: false,
      debugProvenanceHeaders: false,
      unknown: true,
    }).expect(422);
  });

  it('rejects a local control host before runtime settings persistence', async () => {
    const localApp = versionedApp(repository);
    const update = vi.spyOn(repository, 'updateRuntimeSettings');

    const denied = await request(localApp).put('/api/admin/projects/prj_1/runtime-settings').send({
      expectedRevision: 1,
      interceptHosts: ['localhost'],
      captureRawTraffic: true,
      debugProvenanceHeaders: false,
    });

    expect(denied.status).toBe(422);
    expect(denied.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      requestId: expect.any(String),
    });
    expect(update).not.toHaveBeenCalled();
    expect(repository.getRuntimeSettings('prj_1')).toEqual(settingsRecord());
  });
});

describe('Endpoint and Variant routes', () => {
  it('atomically assigns the first passthrough Variant as fallback and preserves it on later additions', async () => {
    await replaceProject({
      endpoints: [endpointRecord({
        mode: 'passthrough',
        defaultVariantId: undefined,
        variants: [],
        revision: 4,
      })],
      states: [stateRecord({ bindings: {} })],
    });

    const first = await request(app)
      .post('/api/admin/projects/prj_1/endpoints/ep_1/variants')
      .send({
        expectedEndpointRevision: 4,
        name: 'First response',
        status: 200,
        responseHeaders: {},
      });

    expect(first.status).toBe(201);
    const detail = await request(app).get('/api/admin/projects/prj_1/endpoints/ep_1').expect(200);
    expect(detail.body).toMatchObject({
      revision: 5,
      defaultVariantId: first.body.id,
      variants: [{ id: first.body.id }],
    });
    const summaries = await request(app).get('/api/admin/projects/prj_1/endpoints').expect(200);
    expect(summaries.body).toContainEqual(expect.objectContaining({
      id: 'ep_1', variantCount: 1, mockReady: true, revision: 5,
    }));

    const later = await request(app)
      .post('/api/admin/projects/prj_1/endpoints/ep_1/variants')
      .send({
        expectedEndpointRevision: 5,
        name: 'Later response',
        status: 202,
        responseHeaders: {},
      });
    expect(later.status).toBe(201);
    expect(repository.getEndpoint('prj_1', 'ep_1')).toMatchObject({
      revision: 6,
      defaultVariantId: first.body.id,
      variants: [{ id: first.body.id }, { id: later.body.id }],
    });

    const mock = await request(app)
      .put('/api/admin/projects/prj_1/endpoints/ep_1/mode')
      .send({ mode: 'mock', expectedRevision: 6 });
    expect(mock.status).toBe(200);
    expect(mock.body).toMatchObject({ mode: 'mock', defaultVariantId: first.body.id });
  });

  it('requires Endpoint baseUrl and mode and exposes strict revisioned mode updates', async () => {
    await createEndpoint(endpointInput({ baseUrl: undefined })).then(response => {
      expect(response.status).toBe(422);
    });
    await createEndpoint(endpointInput({ mode: undefined })).then(response => {
      expect(response.status).toBe(422);
    });

    const created = await createEndpoint();
    expect(created.status).toBe(201);
    const updated = await request(app)
      .put(`/api/admin/projects/prj_1/endpoints/${created.body.id}`)
      .send({ expectedRevision: 0, patch: { name: 'Full update' } });
    expect(updated.status).toBe(200);

    const mode = await request(app)
      .put(`/api/admin/projects/prj_1/endpoints/${created.body.id}/mode`)
      .send({ mode: 'passthrough', expectedRevision: 1 });
    expect(mode.status).toBe(200);
    expect(mode.body).toMatchObject({ mode: 'passthrough', revision: 2 });

    await request(app)
      .put(`/api/admin/projects/prj_1/endpoints/${created.body.id}/mode`)
      .send({ mode: 'mock', expectedRevision: 2, unknown: true })
      .expect(422);
  });

  it('returns body-free summaries and lazy details while resolving defaultVariantIndex', async () => {
    const bytes = Buffer.from('large body bytes must not appear in metadata');
    const asset = await uploadBody(bytes);
    const created = await createEndpoint(endpointInput({
      variants: [
        { name: 'Allowed', status: 200, responseHeaders: {} },
        {
          name: 'Denied',
          status: 403,
          responseHeaders: {},
          bodyAssetId: asset.body.id,
        },
      ],
      defaultVariantIndex: 1,
    }));
    expect(created.status).toBe(201);
    expect(created.body.name).toBe('Playback / denied? #1');
    expect(created.body.defaultVariantId).toBe(created.body.variants[1].id);

    const list = await request(app).get('/api/admin/projects/prj_1/endpoints');
    expect(list.status).toBe(200);
    expect(list.body).toContainEqual(expect.objectContaining({
      id: created.body.id,
      name: 'Playback / denied? #1',
      baseUrl: 'https://api.example.test',
      mode: 'mock',
      method: 'GET',
      path: '/playback/:id',
      queryConstraintCount: 1,
      headerConstraintCount: 1,
      variantCount: 2,
      mockReady: true,
    }));
    expect(JSON.stringify(list.body)).not.toContain(bytes.toString());
    const summary = list.body.find((endpoint: { id: string }) => endpoint.id === created.body.id);
    expect(summary).not.toHaveProperty('description');
    expect(summary).not.toHaveProperty('variants');

    const detail = await request(app)
      .get(`/api/admin/projects/prj_1/endpoints/${created.body.id}`);
    expect(detail.body.variants[1].bodyAssetId).toBe(asset.body.id);
  });

  it('maps duplicate canonical Endpoint identity to 409 without mutation', async () => {
    const first = await createEndpoint();
    expect(first.status).toBe(201);
    const before = repository.listEndpoints('prj_1');

    const duplicate = await createEndpoint(endpointInput({
      name: 'Duplicate identity',
      baseUrl: 'HTTPS://API.EXAMPLE.TEST:443/',
    }));

    expect(duplicate.status).toBe(409);
    expect(duplicate.body).toMatchObject({
      code: 'ENDPOINT_IDENTITY_CONFLICT',
      requestId: expect.any(String),
    });
    expect(repository.listEndpoints('prj_1')).toEqual(before);
    expect(repository.getEndpoint('prj_1', first.body.id)).toEqual(first.body);
  });

  it('updates and deletes Endpoints with null clears and current-revision conflicts', async () => {
    const created = await createEndpoint();
    expect(created.body.matcher.headers).toEqual({
      'x-plan': { operator: 'glob', value: 'paid*' },
    });
    expect(created.body.variants[0].responseHeaders).toEqual({
      'content-type': 'application/octet-stream',
    });
    const updated = await request(app)
      .put(`/api/admin/projects/prj_1/endpoints/${created.body.id}`)
      .send({ expectedRevision: 0, patch: { name: 'Updated', description: null } });
    expect(updated.body).toMatchObject({ name: 'Updated', revision: 1 });
    expect(updated.body).not.toHaveProperty('description');

    const stale = await request(app)
      .put(`/api/admin/projects/prj_1/endpoints/${created.body.id}`)
      .send({ expectedRevision: 0, patch: { name: 'stale' } });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({
      code: 'REVISION_CONFLICT',
      details: { currentRevision: 1 },
      requestId: expect.any(String),
    });

    await request(app)
      .delete(`/api/admin/projects/prj_1/endpoints/${created.body.id}`)
      .send({ expectedRevision: 1 })
      .expect(204);
    await request(app)
      .get(`/api/admin/projects/prj_1/endpoints/${created.body.id}`)
      .expect(404);
  });

  it('returns exact deletion impacts for encoded stable IDs and missing targets', async () => {
    const endpointId = 'ep #1';
    const variantId = 'var ?bound';
    await replaceProject({
      endpoints: [endpointRecord({
        id: endpointId,
        revision: 7,
        defaultVariantId: variantId,
        variants: [
          {
            id: variantId,
            endpointId,
            name: 'Bound',
            status: 200,
            responseHeaders: {},
            revision: 3,
          },
          {
            id: 'var replacement',
            endpointId,
            name: 'Replacement',
            status: 204,
            responseHeaders: {},
            revision: 1,
          },
        ],
      })],
      states: [stateRecord({
        id: 'state_bound',
        name: 'Bound state',
        revision: 2,
        bindings: { [endpointId]: variantId },
      })],
    });

    const endpointImpact = await request(app).get(
      `/api/admin/projects/prj_1/endpoints/${encodeURIComponent(endpointId)}/deletion-impact`,
    );
    expect(endpointImpact.status).toBe(200);
    expect(endpointImpact.body).toEqual({
      endpointId,
      endpointRevision: 7,
      affectedStates: [{ id: 'state_bound', name: 'Bound state', revision: 2 }],
    });

    const variantImpact = await request(app).get(
      `/api/admin/projects/prj_1/endpoints/${encodeURIComponent(endpointId)}`
      + `/variants/${encodeURIComponent(variantId)}/deletion-impact`,
    );
    expect(variantImpact.status).toBe(200);
    expect(variantImpact.body).toEqual({
      endpointId,
      endpointRevision: 7,
      variantId,
      variantRevision: 3,
      isFallback: true,
      affectedStates: [{ id: 'state_bound', name: 'Bound state', revision: 2 }],
      replacementVariants: [{ id: 'var replacement', name: 'Replacement', revision: 1 }],
    });

    const missing = await request(app).get(
      `/api/admin/projects/prj_1/endpoints/${encodeURIComponent(endpointId)}`
      + '/variants/var_missing/deletion-impact',
    );
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('VARIANT_NOT_FOUND');
  });

  it.each([
    '/api/admin/projects/prj%2F1/endpoints/ep_1/deletion-impact',
    '/api/admin/projects/prj_1/endpoints/ep%2F1/deletion-impact',
    '/api/admin/projects/prj_1/endpoints/ep_1/variants/var%5C1/deletion-impact',
  ])('rejects an unstable deletion-impact path segment with 400: %s', async url => {
    const response = await request(app).get(url);
    expect(response.status).toBe(400);
  });

  it('deletes an unreferenced Variant with only its revision', async () => {
    await replaceProject({
      endpoints: [endpointRecord({
        revision: 7,
        defaultVariantId: 'var_replacement',
        variants: [
          {
            id: 'var_unused', endpointId: 'ep_1', name: 'Unused', status: 200,
            responseHeaders: {}, revision: 3,
          },
          {
            id: 'var_replacement', endpointId: 'ep_1', name: 'Replacement', status: 204,
            responseHeaders: {}, revision: 1,
          },
        ],
      })],
      states: [stateRecord({ bindings: { ep_1: 'var_replacement' } })],
    });

    await request(app)
      .delete('/api/admin/projects/prj_1/endpoints/ep_1/variants/var_unused')
      .send({ expectedRevision: 3 })
      .expect(204);
  });

  it('requires paired replacement fields and forwards a complete fallback replacement delete', async () => {
    await replaceProject({
      endpoints: [endpointRecord({
        revision: 7,
        defaultVariantId: 'var_replacement',
        variants: [
          {
            id: 'var_bound', endpointId: 'ep_1', name: 'Bound', status: 200,
            responseHeaders: {}, revision: 3,
          },
          {
            id: 'var_replacement', endpointId: 'ep_1', name: 'Replacement', status: 204,
            responseHeaders: {}, revision: 1,
          },
        ],
      })],
      states: [stateRecord({ bindings: {} })],
    });
    const url = '/api/admin/projects/prj_1/endpoints/ep_1/variants/var_bound';

    await request(app)
      .delete(url)
      .send({ expectedRevision: 3, expectedEndpointRevision: 7 })
      .expect(400);
    await request(app)
      .delete(url)
      .send({ expectedRevision: 3, replacementVariantId: 'var_replacement' })
      .expect(400);
    await request(app)
      .delete(url)
      .send({
        expectedRevision: 3,
        expectedEndpointRevision: 7,
        replacementVariantId: 'var_replacement',
      })
      .expect(204);

    expect(repository.getState('prj_1', 'state_1')).toMatchObject({ bindings: {}, revision: 1 });
  });

  it('returns 409 VARIANT_IN_USE without rewriting a dormant binding', async () => {
    await replaceProject({
      endpoints: [endpointRecord({
        revision: 7,
        defaultVariantId: 'var_bound',
        variants: [
          {
            id: 'var_bound', endpointId: 'ep_1', name: 'Bound', status: 200,
            responseHeaders: {}, revision: 3,
          },
          {
            id: 'var_replacement', endpointId: 'ep_1', name: 'Replacement', status: 204,
            responseHeaders: {}, revision: 1,
          },
        ],
      })],
      states: [stateRecord({ bindings: { ep_1: 'var_bound' } })],
    });

    const denied = await request(app)
      .delete('/api/admin/projects/prj_1/endpoints/ep_1/variants/var_bound')
      .send({
        expectedRevision: 3,
        expectedEndpointRevision: 7,
        replacementVariantId: 'var_replacement',
      });

    expect(denied.status).toBe(409);
    expect(denied.body).toMatchObject({ code: 'VARIANT_IN_USE', requestId: expect.any(String) });
    expect(repository.getEndpoint('prj_1', 'ep_1')).toMatchObject({
      revision: 7, defaultVariantId: 'var_bound', variants: [{ id: 'var_bound' }, { id: 'var_replacement' }],
    });
    expect(repository.getState('prj_1', 'state_1')).toMatchObject({
      revision: 1, bindings: { ep_1: 'var_bound' },
    });
  });

  it('keeps impact reads advisory and enforces mutation-time Endpoint revisions', async () => {
    await replaceProject({
      endpoints: [endpointRecord({
        revision: 7,
        defaultVariantId: 'var_replacement',
        variants: [
          {
            id: 'var_bound', endpointId: 'ep_1', name: 'Bound', status: 200,
            responseHeaders: {}, revision: 3,
          },
          {
            id: 'var_replacement', endpointId: 'ep_1', name: 'Replacement', status: 204,
            responseHeaders: {}, revision: 1,
          },
        ],
      })],
      states: [stateRecord({ bindings: {} })],
    });

    const impact = await request(app)
      .get('/api/admin/projects/prj_1/endpoints/ep_1/variants/var_bound/deletion-impact')
      .expect(200);
    expect(impact.body.endpointRevision).toBe(7);

    await request(app)
      .post('/api/admin/projects/prj_1/endpoints/ep_1/variants')
      .send({
        expectedEndpointRevision: 7,
        name: 'Concurrent',
        status: 200,
        responseHeaders: {},
      })
      .expect(201);

    const staleDelete = await request(app)
      .delete('/api/admin/projects/prj_1/endpoints/ep_1/variants/var_bound')
      .send({
        expectedRevision: 3,
        expectedEndpointRevision: impact.body.endpointRevision,
        replacementVariantId: 'var_replacement',
      });
    expect(staleDelete.status).toBe(409);
    expect(staleDelete.body).toMatchObject({
      code: 'REVISION_CONFLICT',
      details: { expectedRevision: 7, currentRevision: 8 },
    });
  });

  it('creates and updates nonempty repeated response headers without collapsing values', async () => {
    const created = await createEndpoint(endpointInput({
      variants: [{
        name: 'Cookies',
        status: 200,
        responseHeaders: { 'Set-Cookie': ['one=1', 'two=2'] },
      }],
    }));
    expect(created.status).toBe(201);
    expect(created.body.variants[0].responseHeaders['set-cookie']).toEqual(['one=1', 'two=2']);

    const updated = await request(app)
      .put(`/api/admin/projects/prj_1/endpoints/${created.body.id}/variants/${created.body.variants[0].id}`)
      .send({
        expectedRevision: 0,
        patch: { responseHeaders: { 'Set-Cookie': ['three=3', 'four=4'] } },
      });
    expect(updated.status).toBe(200);
    expect(updated.body.responseHeaders['set-cookie']).toEqual(['three=3', 'four=4']);
  });

  it.each([
    ['empty arrays', []],
    ['CR/LF in the first member', ['bad\r\nvalue', 'safe']],
    ['CR/LF in a later member', ['safe', 'bad\nvalue']],
  ])('rejects %s in repeated response headers on create and update', async (_name, values) => {
    const invalidCreate = await createEndpoint(endpointInput({
      variants: [{ name: 'Invalid', status: 200, responseHeaders: { 'Set-Cookie': values } }],
    }));
    expect(invalidCreate.status).toBe(422);
    expect(invalidCreate.body.code).toBe('VALIDATION_FAILED');

    const invalidUpdate = await request(app)
      .put('/api/admin/projects/prj_1/endpoints/ep_1/variants/var_1')
      .send({ expectedRevision: 1, patch: { responseHeaders: { 'Set-Cookie': values } } });
    expect(invalidUpdate.status).toBe(422);
    expect(invalidUpdate.body.code).toBe('VALIDATION_FAILED');
  });

  it('creates, updates, clears, and deletes Variants with exact preconditions', async () => {
    const endpoint = await createEndpoint();
    const asset = await uploadBody(Buffer.from('variant body'));

    const created = await request(app)
      .post(`/api/admin/projects/prj_1/endpoints/${endpoint.body.id}/variants`)
      .send({
        expectedEndpointRevision: 0,
        name: 'Failure',
        description: 'temporary',
        status: 500,
        responseHeaders: { 'X-Test': 'yes' },
        bodyAssetId: asset.body.id,
        delayMs: 10,
      });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      endpointId: endpoint.body.id,
      name: 'Failure',
      revision: 0,
    });

    const invalidBodyReference = await request(app)
      .post(`/api/admin/projects/prj_1/endpoints/${endpoint.body.id}/variants`)
      .send({
        expectedEndpointRevision: 1,
        name: 'Missing body',
        status: 500,
        responseHeaders: {},
        bodyAssetId: '0'.repeat(64),
      });
    expect(invalidBodyReference.status).toBe(422);
    expect(invalidBodyReference.body).toMatchObject({
      code: 'INVALID_PROJECT',
      requestId: expect.any(String),
    });

    const updated = await request(app)
      .put(`/api/admin/projects/prj_1/endpoints/${endpoint.body.id}/variants/${created.body.id}`)
      .send({
        expectedRevision: 0,
        patch: { description: null, bodyAssetId: null, delayMs: null, status: 503 },
      });
    expect(updated.body).toMatchObject({ status: 503, revision: 1 });
    expect(updated.body).not.toHaveProperty('description');
    expect(updated.body).not.toHaveProperty('bodyAssetId');
    expect(updated.body).not.toHaveProperty('delayMs');

    const stale = await request(app)
      .delete(`/api/admin/projects/prj_1/endpoints/${endpoint.body.id}/variants/${created.body.id}`)
      .send({ expectedRevision: 0 });
    expect(stale.status).toBe(409);
    expect(stale.body.details.currentRevision).toBe(1);

    await request(app)
      .delete(`/api/admin/projects/prj_1/endpoints/${endpoint.body.id}/variants/${created.body.id}`)
      .send({ expectedRevision: 1 })
      .expect(204);
  });
});

describe('App State and diagnostics routes', () => {
  it('lists summaries and supports State detail, CRUD, null clears, and selection', async () => {
    const list = await request(app).get('/api/admin/projects/prj_1/states');
    expect(list.body).toEqual([expect.objectContaining({
      id: 'state_1',
      boundEndpointCount: 1,
      totalEndpointCount: 1,
    })]);
    expect(list.body[0]).not.toHaveProperty('missingEndpointIds');
    expect(list.body[0]).not.toHaveProperty('bindings');
    expect((await request(app).get('/api/admin/projects/prj_1/states/state_1')).body)
      .toEqual(stateRecord());

    const created = await request(app).post('/api/admin/projects/prj_1/states').send({
      name: 'Checkout',
      description: 'temporary',
      tags: ['commerce'],
      expectedUi: 'checkout-screen',
      bindings: { ep_1: 'var_1' },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: 'Checkout', revision: 0 });

    const updated = await request(app)
      .put(`/api/admin/projects/prj_1/states/${created.body.id}`)
      .send({
        expectedRevision: 0,
        patch: { name: 'Checkout ready', description: null, expectedUi: null },
      });
    expect(updated.body).toMatchObject({ name: 'Checkout ready', revision: 1 });
    expect(updated.body).not.toHaveProperty('description');
    expect(updated.body).not.toHaveProperty('expectedUi');

    const selected = await request(app).put('/api/admin/projects/prj_1/state-selection').send({
      expectedRevision: 1,
      activeStateId: created.body.id,
    });
    expect(selected.body).toMatchObject({
      activeStateId: created.body.id,
      appStateMode: 'enabled',
      revision: 2,
    });

    const cleared = await request(app).put('/api/admin/projects/prj_1/state-selection').send({
      expectedRevision: 2,
      activeStateId: null,
    });
    expect(cleared.body).not.toHaveProperty('activeStateId');
    expect(cleared.body).toMatchObject({ appStateMode: 'enabled' });

    await request(app)
      .delete(`/api/admin/projects/prj_1/states/${created.body.id}`)
      .send({ expectedRevision: 1 })
      .expect(204);
  });

  it('returns global diagnostics even when their Project cannot load', async () => {
    const corruptBuilder = new ProjectBuilder(root, { projectId: 'prj_corrupt' });
    await corruptBuilder.writeGeneration({
      project: projectRecord({ id: 'prj_corrupt', name: 'Unreadable' }),
      settings: settingsRecord({ projectId: 'prj_corrupt' }),
      endpoints: [endpointRecord({
        id: 'ep_corrupt',
        projectId: 'prj_corrupt',
        defaultVariantId: 'var_corrupt',
        variants: [{
          id: 'var_corrupt',
          endpointId: 'ep_corrupt',
          name: 'Default',
          status: 200,
          responseHeaders: {},
          revision: 0,
        }],
      })],
      states: [],
    });
    await corruptBuilder.writePointer();
    await fs.promises.writeFile(
      path.join(corruptBuilder.generationDirectory(), 'project.json'),
      '{bad',
    );
    await repository.initialize();

    const global = await request(app).get('/api/admin/diagnostics');
    expect(global.status).toBe(200);
    expect(global.body).toEqual({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ projectId: 'prj_corrupt', code: 'MALFORMED_JSON' }),
      ]),
    });

    const project = await request(app).get('/api/admin/projects/prj_corrupt/diagnostics');
    expect(project.body).toEqual({
      projectId: 'prj_corrupt',
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ projectId: 'prj_corrupt', code: 'MALFORMED_JSON' }),
      ]),
    });
  });

  it('returns 404 for diagnostics of an absent Project but [] for a valid Project', async () => {
    const valid = await request(app).get('/api/admin/projects/prj_1/diagnostics');
    expect(valid.status).toBe(200);
    expect(valid.body).toEqual({ projectId: 'prj_1', diagnostics: [] });

    const missing = await request(app).get('/api/admin/projects/prj_missing/diagnostics');
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({
      code: 'PROJECT_NOT_FOUND',
      requestId: expect.any(String),
    });
  });
});

describe('request validation and stable errors', () => {
  it.each([
    ['Endpoint create', 100, async () => createEndpoint(endpointInput({
      variants: [{ name: 'Continue', status: 100, responseHeaders: {} }],
    }))],
    ['Variant create', 103, async () => {
      const endpoint = repository.getEndpoint('prj_1', 'ep_1');
      return request(app)
        .post('/api/admin/projects/prj_1/endpoints/ep_1/variants')
        .send({
          expectedEndpointRevision: endpoint.revision,
          name: 'Early hints',
          status: 103,
          responseHeaders: {},
        });
    }],
    ['Variant update', 199, async () => {
      const endpoint = repository.getEndpoint('prj_1', 'ep_1');
      const variant = endpoint.variants[0]!;
      return request(app)
        .put(`/api/admin/projects/prj_1/endpoints/ep_1/variants/${variant.id}`)
        .send({ expectedRevision: variant.revision, patch: { status: 199 } });
    }],
  ])('rejects informational status at the %s boundary', async (_name, _status, send) => {
    const response = await send();
    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      requestId: expect.any(String),
    });
  });

  it.each([200, 599])('accepts final status %s at the authoring route', async status => {
    const response = await createEndpoint(endpointInput({
      name: `Final ${status}`,
      matcher: { method: 'GET', path: `/final-${status}` },
      variants: [{ name: 'Final', status, responseHeaders: {} }],
    }));

    expect(response.status).toBe(201);
    expect(response.body.variants[0].status).toBe(status);
  });

  it.each([
    ['unknown Project create field', '/api/admin/projects', { name: 'x', revision: 0 }],
    ['empty Project name', '/api/admin/projects', { name: '' }],
    ['invalid Endpoint status', '/api/admin/projects/prj_1/endpoints', endpointInput({
      variants: [{ name: 'Invalid', status: 99, responseHeaders: {} }],
    })],
    ['invalid matcher shape', '/api/admin/projects/prj_1/endpoints', endpointInput({
      matcher: { method: 'GET', path: '/x', headers: { x: 'not-an-expression' } },
    })],
    ['invalid default index', '/api/admin/projects/prj_1/endpoints', endpointInput({
      defaultVariantIndex: 3,
    })],
  ])('maps %s to structured 422', async (_name, url, body) => {
    const response = await request(app).post(url).send(body);
    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      requestId: expect.any(String),
    });
    expect(response.headers['x-request-id']).toBe(response.body.requestId);
  });

  it.each([
    ['empty matcher header name', endpointInput({
      matcher: {
        method: 'GET',
        path: '/x',
        headers: { '': { operator: 'equals', value: 'x' } },
      },
    })],
    ['invalid matcher header name', endpointInput({
      matcher: {
        method: 'GET',
        path: '/x',
        headers: { 'Bad Header': { operator: 'equals', value: 'x' } },
      },
    })],
    ['invalid response header name', endpointInput({
      variants: [{ name: 'Invalid', status: 200, responseHeaders: { 'Bad:Header': 'x' } }],
    })],
    ['response header value with CR/LF', endpointInput({
      variants: [{ name: 'Invalid', status: 200, responseHeaders: { 'X-Test': 'x\r\ny' } }],
    })],
    ['response header value with NUL', endpointInput({
      variants: [{ name: 'Invalid', status: 200, responseHeaders: { 'X-Test': 'x\u0000y' } }],
    })],
    ['response header value with DEL', endpointInput({
      variants: [{ name: 'Invalid', status: 200, responseHeaders: { 'X-Test': 'x\u007fy' } }],
    })],
    ['response header value above Latin-1', endpointInput({
      variants: [{ name: 'Invalid', status: 200, responseHeaders: { 'X-Test': 'snowman \u2603' } }],
    })],
    ['case-insensitive duplicate response headers', endpointInput({
      variants: [{
        name: 'Invalid',
        status: 200,
        responseHeaders: { 'X-Test': 'one', 'x-test': 'two' },
      }],
    })],
    ['case-insensitive duplicate matcher headers', endpointInput({
      matcher: {
        method: 'GET',
        path: '/x',
        headers: {
          'X-Test': { operator: 'equals', value: 'one' },
          'x-test': { operator: 'equals', value: 'two' },
        },
      },
    })],
  ])('rejects %s at the route boundary', async (_name, body) => {
    const response = await createEndpoint(body);
    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      requestId: expect.any(String),
    });
  });

  it('normalizes valid headers without losing Node-compatible values or special keys', async () => {
    const created = await createEndpoint(endpointInput({
      matcher: {
        method: 'GET',
        path: '/x',
        headers: {
          'X-Plan': { operator: 'glob', value: 'paid*' },
          ['__proto__']: { operator: 'equals', value: 'safe' },
        },
      },
      variants: [{
        name: 'Valid',
        status: 200,
        responseHeaders: {
          'X-Text': 'tab\tand Latin-1 \u00e9',
          ['__proto__']: 'safe',
        },
      }],
    }));

    expect(created.status).toBe(201);
    expect(created.body.matcher.headers['x-plan']).toEqual({ operator: 'glob', value: 'paid*' });
    expect(created.body.matcher.headers.__proto__).toEqual({ operator: 'equals', value: 'safe' });
    expect(created.body.variants[0].responseHeaders['x-text']).toBe('tab\tand Latin-1 \u00e9');
    expect(created.body.variants[0].responseHeaders.__proto__).toBe('safe');
  });

  it.each([
    ['State create', '/api/admin/projects/prj_1/states', {
      name: 'Invalid', tags: [], bindings: { '../ep': 'var_1' },
    }],
    ['State update', '/api/admin/projects/prj_1/states/state_1', {
      expectedRevision: 0, patch: { bindings: { '': 'var_1' } },
    }],
    ['State binding value', '/api/admin/projects/prj_1/states', {
      name: 'Invalid', tags: [], bindings: { ep_1: '../var' },
    }],
  ])('rejects unstable binding IDs for %s', async (_name, url, body) => {
    const method = url.endsWith('/states') ? 'post' : 'put';
    const response = await request(app)[method](url).send(body);
    expect(response.status).toBe(422);
    expect(response.body.code).toBe('VALIDATION_FAILED');
  });

  it.each([
    ['an unstable activeStateId', { activeStateId: '../state' }],
    ['a removed baseStateId', { activeStateId: 'state_1', baseStateId: 'state_1' }],
    ['a removed allowFallback', { activeStateId: 'state_1', allowFallback: true }],
  ])('rejects state-selection with %s', async (_name, selectedState) => {
    const response = await request(app)
      .put('/api/admin/projects/prj_1/state-selection')
      .send({ expectedRevision: 1, ...selectedState });
    expect(response.status).toBe(422);
    expect(response.body.code).toBe('VALIDATION_FAILED');
  });

  it('rejects representative server-owned fields nested in mutation inputs', async () => {
    const endpoint = await createEndpoint(endpointInput({
      variants: [{
        id: 'var_server_owned',
        name: 'Invalid',
        status: 200,
        responseHeaders: {},
      }],
    }));
    expect(endpoint.status).toBe(422);
    expect(endpoint.body.code).toBe('VALIDATION_FAILED');

    const state = await request(app).post('/api/admin/projects/prj_1/states').send({
      name: 'Invalid',
      tags: [],
      bindings: {},
      revision: 0,
    });
    expect(state.status).toBe(422);
    expect(state.body.code).toBe('VALIDATION_FAILED');
  });

  it('rejects unknown and invalid fields across every JSON mutation family', async () => {
    type MutationMethod = 'post' | 'put' | 'delete';
    const mutations: Array<{
      name: string;
      method: MutationMethod;
      url: string;
      valid: Record<string, unknown>;
      invalid: Record<string, unknown>;
    }> = [
      { name: 'Project create', method: 'post', url: '/api/admin/projects', valid: { name: 'x' }, invalid: { name: '' } },
      { name: 'Project update', method: 'put', url: '/api/admin/projects/prj_1', valid: { expectedRevision: 1, patch: { name: 'x' } }, invalid: { expectedRevision: -1, patch: { name: 'x' } } },
      { name: 'Project delete', method: 'delete', url: '/api/admin/projects/prj_1', valid: { expectedRevision: 1 }, invalid: { expectedRevision: -1 } },
      { name: 'workspace update', method: 'put', url: '/api/admin/workspace', valid: { expectedRevision: 0, activeProjectId: 'prj_1' }, invalid: { expectedRevision: -1, activeProjectId: 'prj_1' } },
      { name: 'runtime settings update', method: 'put', url: '/api/admin/projects/prj_1/runtime-settings', valid: { expectedRevision: 1, interceptHosts: [], captureRawTraffic: false, debugProvenanceHeaders: false }, invalid: { expectedRevision: 1, interceptHosts: [], captureRawTraffic: 'yes', debugProvenanceHeaders: false } },
      { name: 'Endpoint create', method: 'post', url: '/api/admin/projects/prj_1/endpoints', valid: endpointInput(), invalid: endpointInput({ defaultVariantIndex: -1 }) },
      { name: 'Endpoint update', method: 'put', url: '/api/admin/projects/prj_1/endpoints/ep_1', valid: { expectedRevision: 1, patch: { name: 'x' } }, invalid: { expectedRevision: -1, patch: { name: 'x' } } },
      { name: 'Endpoint delete', method: 'delete', url: '/api/admin/projects/prj_1/endpoints/ep_1', valid: { expectedRevision: 1 }, invalid: { expectedRevision: -1 } },
      { name: 'Variant create', method: 'post', url: '/api/admin/projects/prj_1/endpoints/ep_1/variants', valid: { expectedEndpointRevision: 1, name: 'x', status: 200, responseHeaders: {} }, invalid: { expectedEndpointRevision: -1, name: 'x', status: 200, responseHeaders: {} } },
      { name: 'Variant update', method: 'put', url: '/api/admin/projects/prj_1/endpoints/ep_1/variants/var_1', valid: { expectedRevision: 1, patch: { name: 'x' } }, invalid: { expectedRevision: -1, patch: { name: 'x' } } },
      { name: 'Variant delete', method: 'delete', url: '/api/admin/projects/prj_1/endpoints/ep_1/variants/var_1', valid: { expectedRevision: 1 }, invalid: { expectedRevision: -1 } },
      { name: 'State create', method: 'post', url: '/api/admin/projects/prj_1/states', valid: { name: 'x', tags: [], bindings: {} }, invalid: { name: '', tags: [], bindings: {} } },
      { name: 'State update', method: 'put', url: '/api/admin/projects/prj_1/states/state_1', valid: { expectedRevision: 1, patch: { name: 'x' } }, invalid: { expectedRevision: -1, patch: { name: 'x' } } },
      { name: 'State delete', method: 'delete', url: '/api/admin/projects/prj_1/states/state_1', valid: { expectedRevision: 1 }, invalid: { expectedRevision: -1 } },
      { name: 'state selection update', method: 'put', url: '/api/admin/projects/prj_1/state-selection', valid: { expectedRevision: 1, activeStateId: 'state_1' }, invalid: { expectedRevision: 1, activeStateId: 42 } },
    ];

    for (const mutation of mutations) {
      const unknown = await request(app)[mutation.method](mutation.url)
        .send({ ...mutation.valid, unknown: true });
      expect(unknown.status, `${mutation.name} unknown field`).toBe(422);
      expect(unknown.body.code).toBe('VALIDATION_FAILED');

      const invalid = await request(app)[mutation.method](mutation.url).send(mutation.invalid);
      expect(invalid.status, `${mutation.name} invalid field`).toBe(422);
      expect(invalid.body.code).toBe('VALIDATION_FAILED');
    }
  });

  it('maps malformed JSON and missing stable IDs without losing request IDs', async () => {
    const malformed = await request(app)
      .post('/api/admin/projects')
      .set('Content-Type', 'application/json')
      .send('{bad');
    expect(malformed.status).toBe(400);
    expect(malformed.body).toMatchObject({
      code: 'MALFORMED_JSON',
      requestId: expect.any(String),
    });

    const missing = await request(app)
      .get('/api/admin/projects/prj_1/endpoints/ep_missing');
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({
      code: 'ENDPOINT_NOT_FOUND',
      requestId: expect.any(String),
    });
  });

  it('maps public ID exhaustion to ID_COLLISION without candidate values', async () => {
    const collisionRepository = repositoryAt(root, { idSource: () => '1' });
    await collisionRepository.initialize();
    const response = await request(versionedApp(collisionRepository))
      .post('/api/admin/projects/prj_1/states')
      .send({ name: 'Collision', tags: [], bindings: {} });
    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      code: 'ID_COLLISION',
      message: expect.any(String),
      requestId: expect.any(String),
    });
    expect(JSON.stringify(response.body)).not.toContain('state_1');
  });

  it('keeps repository 422 details and sanitizes unexpected filesystem failures', async () => {
    const invalidReference = await createEndpoint(endpointInput({
      variants: [{
        name: 'Missing body',
        status: 200,
        responseHeaders: {},
        bodyAssetId: '0'.repeat(64),
      }],
    }));
    expect(invalidReference.status).toBe(422);
    expect(invalidReference.body).toMatchObject({
      code: 'INVALID_PROJECT',
      details: expect.any(Array),
      requestId: expect.any(String),
    });

    const failingRepository: ProjectRepository = {
      ...repository,
      updateProject: async () => {
        throw new Error('/Users/example/.mockmate/body-secret');
      },
    };
    const failed = await request(versionedApp(failingRepository))
      .put('/api/admin/projects/prj_1')
      .send({ expectedRevision: 1, patch: { name: 'x' } });
    expect(failed.status).toBe(500);
    expect(failed.body).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
      requestId: expect.any(String),
    });
    expect(JSON.stringify(failed.body)).not.toMatch(/Users|body-secret/);
  });
});

describe('streamed Body Asset routes', () => {
  it('round-trips exact binary and zero-byte bodies with immutable metadata headers', async () => {
    const bytes = Buffer.from([0, 255, 1, 254]);
    const upload = await request(app)
      .post('/api/admin/projects/prj_1/bodies')
      .set('Content-Type', 'application/octet-stream')
      .set('X-MockMate-Encoding', 'identity')
      .send(bytes);
    expect(upload.status).toBe(201);
    expect(upload.body).toMatchObject({
      mediaType: 'application/octet-stream',
      size: bytes.length,
    });
    expect(upload.body).not.toHaveProperty('encoding');

    const download = await request(app)
      .get(`/api/admin/projects/prj_1/bodies/${upload.body.id}`)
      .buffer(true)
      .parse(binaryParser);
    expect(download.status).toBe(200);
    expect(download.headers['content-type']).toContain('application/octet-stream');
    expect(download.headers['content-length']).toBe(String(bytes.length));
    expect(download.headers['content-encoding']).toBeUndefined();
    expect(download.body).toEqual(bytes);

    const empty = await uploadBody(Buffer.alloc(0), 'application/x-empty');
    expect(empty.status).toBe(201);
    expect(empty.body.size).toBe(0);
    const emptyDownload = await request(app)
      .get(`/api/admin/projects/prj_1/bodies/${empty.body.id}`)
      .buffer(true)
      .parse(binaryParser);
    expect(emptyDownload.status).toBe(200);
    expect(emptyDownload.headers['content-length']).toBe('0');
    expect(emptyDownload.body).toEqual(Buffer.alloc(0));
  });

  it('accepts exactly 10 MiB and rejects 10 MiB plus one byte without buffering middleware', async () => {
    const inclusive = await uploadBody(Buffer.alloc(MAX_BODY_BYTES, 0xa5));
    expect(inclusive.status).toBe(201);
    expect(inclusive.body.size).toBe(MAX_BODY_BYTES);

    const tooLarge = await uploadBody(Buffer.alloc(MAX_BODY_BYTES + 1, 0xa5));
    expect(tooLarge.status).toBe(413);
    expect(tooLarge.body).toMatchObject({
      code: 'BODY_TOO_LARGE',
      requestId: expect.any(String),
    });
  }, 20_000);

  it.each([
    ['missing Content-Type', undefined, undefined],
    ['invalid Content-Type', 'not a media type', undefined],
    ['invalid encoding', 'application/octet-stream', 'not an encoding'],
  ])('rejects %s as structured validation', async (_name, mediaType, encoding) => {
    let upload = request(app).post('/api/admin/projects/prj_1/bodies');
    if (mediaType !== undefined) upload = upload.set('Content-Type', mediaType);
    if (encoding !== undefined) upload = upload.set('X-MockMate-Encoding', encoding);
    const response = await finishRawUpload(upload);
    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      requestId: expect.any(String),
    });
  });

  it('keeps strict JSON validation in the streamed repository path', async () => {
    const upload = request(app)
      .post('/api/admin/projects/prj_1/bodies')
      .set('Content-Type', 'application/json');
    const response = await new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
      upload.write(Buffer.from('{bad'));
      upload.end((error, result) => {
        if (error) reject(error);
        else resolve(result);
      });
    });
    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({
      code: 'INVALID_JSON_BODY',
      requestId: expect.any(String),
    });
  });

  it('cleans all Body Asset residue when a real HTTP upload is cancelled', async () => {
    let markStarted!: () => void;
    let markSettled!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const settled = new Promise<void>(resolve => { markSettled = resolve; });
    const cancellable: ProjectRepository = {
      ...repository,
      putBody: async (projectId, stream, metadata, policy) => {
        markStarted();
        try {
          return await repository.putBody(projectId, stream, metadata, policy);
        } finally {
          markSettled();
        }
      },
    };
    const server = versionedApp(cancellable).listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP test server');

    const outgoing = http.request({
      host: '127.0.0.1',
      port: address.port,
      method: 'POST',
      path: '/api/admin/projects/prj_1/bodies',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(MAX_BODY_BYTES),
      },
    });
    const closed = new Promise<void>(resolve => {
      outgoing.once('error', () => resolve());
      outgoing.once('close', () => resolve());
    });
    outgoing.write(Buffer.alloc(64 * 1024, 0xa5));
    await started;
    outgoing.destroy();
    await closed;
    await settled;
    await new Promise<void>(resolve => server.close(() => resolve()));

    const bodyRoot = path.join(root, 'projects', 'prj_1', 'bodies', 'sha256');
    let residue: string[] = [];
    try {
      residue = await fs.promises.readdir(bodyRoot, { recursive: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    expect(residue).toEqual([]);
  });

  it('forwards synchronous open and pre-header stream failures to sanitized JSON errors', async () => {
    const asset: BodyAsset = {
      schemaVersion: 4,
      id: '0'.repeat(64),
      mediaType: 'application/octet-stream',
      size: 1,
      createdAt: new Date(0).toISOString(),
    };
    const openFailure: ProjectRepository = {
      ...repository,
      getBody: async () => asset,
      openBody: () => { throw new Error('/secret/open-path'); },
    };
    const opened = await request(versionedApp(openFailure))
      .get(`/api/admin/projects/prj_1/bodies/${asset.id}`);
    expect(opened.status).toBe(500);
    expect(opened.body.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(opened.body)).not.toContain('open-path');

    let destroyCalls = 0;
    const source = new Readable({
      read() {},
      destroy(_error, callback) {
        destroyCalls += 1;
        setImmediate(() => callback(new Error('/secret/pre-header-cleanup-path')));
      },
    });
    const sourceClosed = waitForSourceClose(source);
    const streamFailure: ProjectRepository = {
      ...repository,
      getBody: async () => asset,
      openBody: () => {
        setImmediate(() => source.emit('error', new Error('/secret/stream-path')));
        return source;
      },
    };
    const { result: streamed, errors } = await captureUncaughtErrors(async uncaught => {
      const response = await request(versionedApp(streamFailure))
        .get(`/api/admin/projects/prj_1/bodies/${asset.id}`);
      await Promise.race([sourceClosed, uncaught]);
      return response;
    });
    expect(streamed.status).toBe(500);
    expect(streamed.body.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(streamed.body)).not.toContain('stream-path');
    expect(errors).toEqual([]);
    expect(destroyCalls).toBe(1);
    expect(source.destroyed).toBe(true);
    expect(source.listenerCount('error')).toBe(0);
    expect(source.listenerCount('close')).toBe(0);
  });

  it('settles failing asynchronous source destruction when the client cancels', async () => {
    let destroyCalls = 0;
    let sent = false;
    const asset: BodyAsset = {
      schemaVersion: 4,
      id: '0'.repeat(64),
      mediaType: 'application/octet-stream',
      size: 1024 * 1024,
      createdAt: new Date(0).toISOString(),
    };
    const source = new Readable({
      read() {
        if (!sent) {
          sent = true;
          this.push(Buffer.alloc(1024));
        }
      },
      destroy(_error, callback) {
        destroyCalls += 1;
        setImmediate(() => callback(new Error('/secret/cancel-cleanup-path')));
      },
    });
    const sourceClosed = waitForSourceClose(source);
    const cancellable: ProjectRepository = {
      ...repository,
      getBody: async () => asset,
      openBody: () => source,
    };
    const server = versionedApp(cancellable).listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP test server');

    const { errors } = await captureUncaughtErrors(async uncaught => {
      await new Promise<void>((resolve, reject) => {
        const outgoing = http.get({
          host: '127.0.0.1',
          port: address.port,
          path: `/api/admin/projects/prj_1/bodies/${asset.id}`,
        }, response => {
          response.once('data', () => {
            response.destroy();
            resolve();
          });
        });
        outgoing.once('error', reject);
      });
      await Promise.race([sourceClosed, uncaught]);
      await new Promise<void>(resolve => server.close(() => resolve()));
    });

    expect(errors).toEqual([]);
    expect(destroyCalls).toBe(1);
    expect(source.listenerCount('error')).toBe(0);
    expect(source.listenerCount('close')).toBe(0);
  });

  it('terminates safely when a download and its asynchronous cleanup fail after headers', async () => {
    const asset: BodyAsset = {
      schemaVersion: 4,
      id: '0'.repeat(64),
      mediaType: 'application/octet-stream',
      size: 2,
      createdAt: new Date(0).toISOString(),
    };
    let destroyCalls = 0;
    const source = new Readable({
      read() {},
      destroy(_error, callback) {
        destroyCalls += 1;
        setImmediate(() => callback(new Error('/secret/post-header-cleanup-path')));
      },
    });
    const sourceClosed = waitForSourceClose(source);
    const failing: ProjectRepository = {
      ...repository,
      getBody: async () => asset,
      openBody: () => {
        setImmediate(() => {
          source.push(Buffer.of(0xff));
          setImmediate(() => source.emit('error', new Error('/secret/late-stream-path')));
        });
        return source;
      },
    };
    const server = versionedApp(failing).listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP test server');

    const { result, errors } = await captureUncaughtErrors(async uncaught => {
      const responseResult = await new Promise<{ bytes: Buffer; terminated: boolean }>((resolve, reject) => {
        http.get({
          host: '127.0.0.1',
          port: address.port,
          path: `/api/admin/projects/prj_1/bodies/${asset.id}`,
        }, response => {
          const chunks: Buffer[] = [];
          response.on('data', chunk => chunks.push(Buffer.from(chunk)));
          response.once('aborted', () => resolve({ bytes: Buffer.concat(chunks), terminated: true }));
          response.once('error', () => resolve({ bytes: Buffer.concat(chunks), terminated: true }));
          response.once('end', () => resolve({ bytes: Buffer.concat(chunks), terminated: false }));
        }).once('error', reject);
      });
      await Promise.race([sourceClosed, uncaught]);
      await new Promise<void>(resolve => server.close(() => resolve()));
      return responseResult;
    });

    expect(result).toEqual({ bytes: Buffer.of(0xff), terminated: true });
    expect(errors).toEqual([]);
    expect(destroyCalls).toBe(1);
    expect(source.destroyed).toBe(true);
    expect(source.listenerCount('error')).toBe(0);
    expect(source.listenerCount('close')).toBe(0);
  });

  it('removes route-owned source listeners after a successful download', async () => {
    const asset: BodyAsset = {
      schemaVersion: 4,
      id: '0'.repeat(64),
      mediaType: 'application/octet-stream',
      size: 1,
      createdAt: new Date(0).toISOString(),
    };
    const source = Readable.from([Buffer.of(0xff)]);
    const sourceClosed = waitForSourceClose(source);
    const successful: ProjectRepository = {
      ...repository,
      getBody: async () => asset,
      openBody: () => source,
    };

    const response = await request(versionedApp(successful))
      .get(`/api/admin/projects/prj_1/bodies/${asset.id}`)
      .buffer(true)
      .parse(binaryParser);
    await sourceClosed;

    expect(response.status).toBe(200);
    expect(response.body).toEqual(Buffer.of(0xff));
    expect(source.listenerCount('error')).toBe(0);
    expect(source.listenerCount('close')).toBe(0);
  });
});

describe('router diagnostics contract', () => {
  it('uses the exact global and Project response envelopes', async () => {
    const diagnostic: RepositoryDiagnostic = {
      projectId: 'prj_1',
      severity: 'warning',
      code: 'TEST_WARNING',
      file: 'projects/prj_1/project.json',
      path: '$.name',
      message: 'Test warning',
      recovery: 'Fix the test warning.',
    };
    const diagnosticsRepository: ProjectRepository = {
      ...repository,
      listAllDiagnostics: () => [diagnostic],
      listDiagnostics: projectId => projectId === 'prj_1' ? [diagnostic] : [],
    };
    const diagnosticsApp = versionedApp(diagnosticsRepository);
    expect((await request(diagnosticsApp).get('/api/admin/diagnostics')).body)
      .toEqual({ diagnostics: [diagnostic] });
    expect((await request(diagnosticsApp).get('/api/admin/projects/prj_1/diagnostics')).body)
      .toEqual({ projectId: 'prj_1', diagnostics: [diagnostic] });
  });
});
