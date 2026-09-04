import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Application } from 'express';
import express from 'express';
import { Readable } from 'node:stream';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../app';
import {
  createProcessTrafficContext,
  createRuntime,
  type RuntimeContext,
  type TrafficService,
} from '../runtime/create-runtime';
import type { ProjectRepository } from '../repository/project-repository';
import { apiErrorMiddleware, requestIdMiddleware } from '../services/api-errors';
import { createSetupRouter } from './setup';
import { createImportsRouter } from './admin/imports';
import { createTrafficRouter } from './admin/traffic';

describe('canonical admin router composition', () => {
  let root: string;
  let app: Application;
  let runtime: RuntimeContext;

  beforeEach(async () => {
    root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mockmate-admin-'));
    runtime = await createRuntime({
      rootDirectory: root,
      processTraffic: createProcessTrafficContext(),
      isAdminRequestLocal: () => true,
    });
    app = createApp({
      runtime,
      setupRouter: createSetupRouter({
        certificateDirectory: path.join(root, 'certificates'),
        getPorts: () => ({ http: 3000, https: 3443, proxy: 8080 }),
      }),
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await fs.promises.rm(root, { recursive: true, force: true });
  });

  async function createProject() {
    const response = await request(app).post('/api/admin/projects').send({ name: 'Canonical Project' });
    expect(response.status).toBe(201);
    return response.body as { id: string; revision: number };
  }

  it('creates, lists, selects, updates, clears, and deletes Projects by revision', async () => {
    const project = await createProject();
    const listed = await request(app).get('/api/admin/projects');
    expect(listed.body).toContainEqual(expect.objectContaining({ id: project.id, revision: 0 }));
    const workspace = await request(app).get('/api/admin/workspace');
    const selected = await request(app).put('/api/admin/workspace').send({
      activeProjectId: project.id, expectedRevision: workspace.body.revision,
    });
    expect(selected.body).toMatchObject({ activeProjectId: project.id, revision: 1 });
    const updated = await request(app).put(`/api/admin/projects/${project.id}`).send({
      expectedRevision: project.revision, patch: { name: 'Renamed Project' },
    });
    expect(updated.body).toMatchObject({ name: 'Renamed Project', revision: 1 });
    await request(app).put('/api/admin/workspace').send({ activeProjectId: null, expectedRevision: 1 }).expect(200);
    await request(app).delete(`/api/admin/projects/${project.id}`).send({ expectedRevision: 1 }).expect(204);
  });

  it('owns Endpoints, Variants, and App States by stable ID and revision', async () => {
    const project = await createProject();
    const endpoint = await request(app).post(`/api/admin/projects/${project.id}/endpoints`).send({
      name: 'Playback', baseUrl: 'https://api.example.test', mode: 'mock',
      matcher: { method: 'GET', path: '/playback' },
      variants: [{ name: 'Allowed', status: 200, responseHeaders: {} }], defaultVariantIndex: 0,
    });
    expect(endpoint.status).toBe(201);
    expect(endpoint.body.id).toMatch(/^ep_/);
    expect(endpoint.body.defaultVariantId).toMatch(/^var_/);
    const variant = endpoint.body.variants[0];
    const savedVariant = await request(app)
      .put(`/api/admin/projects/${project.id}/endpoints/${endpoint.body.id}/variants/${variant.id}`)
      .send({ expectedRevision: variant.revision, patch: { status: 202 } });
    expect(savedVariant.body).toMatchObject({ id: variant.id, status: 202, revision: 1 });
    const state = await request(app).post(`/api/admin/projects/${project.id}/states`).send({
      name: 'Signed in', tags: ['auth'], bindings: { [endpoint.body.id]: variant.id },
    });
    expect(state.status).toBe(201);
    expect(state.body).toMatchObject({ id: expect.stringMatching(/^state_/), bindings: { [endpoint.body.id]: variant.id } });
  });

  it('requires Endpoint origin and mode while rejecting Project origin ownership', async () => {
    await request(app).post('/api/admin/projects').send({
      name: 'Invalid', baseUrl: 'https://api.example.test',
    }).expect(422);
    const project = await createProject();
    const endpoint = {
      name: 'Playback',
      matcher: { method: 'GET', path: '/playback' },
      variants: [{ name: 'Allowed', status: 200, responseHeaders: {} }],
      defaultVariantIndex: 0,
    };
    await request(app).post(`/api/admin/projects/${project.id}/endpoints`).send({
      ...endpoint, mode: 'mock',
    }).expect(422);
    await request(app).post(`/api/admin/projects/${project.id}/endpoints`).send({
      ...endpoint, baseUrl: 'https://api.example.test',
    }).expect(422);
  });

  it('updates Project runtime settings independently by revision', async () => {
    const project = await createProject();
    const initial = await request(app).get(`/api/admin/projects/${project.id}/runtime-settings`);
    const saved = await request(app).put(`/api/admin/projects/${project.id}/runtime-settings`).send({
      expectedRevision: initial.body.revision,
      interceptHosts: ['api.example.test'],
      captureRawTraffic: true,
      debugProvenanceHeaders: false,
    });
    expect(saved.body).toMatchObject({
      interceptHosts: ['api.example.test'], captureRawTraffic: true,
      debugProvenanceHeaders: false, revision: 1,
    });
  });

  it('previews and commits imports with exact HTTP statuses and IDs-only results', async () => {
    const project = await createProject();
    const source = { type: 'curl' as const, text: "curl 'https://api.example.test/users'" };
    const preview = await request(app)
      .post(`/api/admin/projects/${project.id}/import/preview`)
      .send({ source })
      .expect(200);

    await request(app)
      .post(`/api/admin/projects/${project.id}/import/commit`)
      .send({
        source,
        snapshotToken: preview.body.snapshotToken,
        selectedItemIds: [preview.body.items[0].id],
        actions: [{ itemId: preview.body.items[0].id, action: 'create' }],
      })
      .expect(201)
      .expect(response => {
        expect(response.body).toEqual({
          createdEndpointIds: [expect.stringMatching(/^ep_/)],
          updatedEndpointIds: [],
          createdVariantIds: [expect.stringMatching(/^var_/)],
          skippedItemIds: [],
        });
      });
  });

  it('keeps import validation, Project identity, JSON parsing, and envelope errors canonical', async () => {
    const project = await createProject();
    const route = (projectId = project.id) => `/api/admin/projects/${projectId}/import/preview`;
    const expectError = async (
      response: request.Response,
      status: number,
      code: string,
      requestId: string,
    ) => {
      expect(response.status).toBe(status);
      expect(response.headers['x-request-id']).toBe(requestId);
      expect(response.body).toMatchObject({ code, requestId });
    };

    const invalidSources = [
      { source: { type: 'archive', text: 'ignored' } },
      { source: { type: 'curl', text: 'curl https://api.example.test', collection: {} } },
      { source: { type: 'postman', collection: {}, text: 'ignored' } },
      { source: { type: 'curl', text: 'curl https://api.example.test' }, extra: true },
    ];
    for (const [index, body] of invalidSources.entries()) {
      const requestId = `invalid-source-${index}`;
      await expectError(
        await request(app).post(route()).set('X-Request-Id', requestId).send(body),
        422,
        'IMPORT_SOURCE_INVALID',
        requestId,
      );
    }

    const actionRequestId = 'invalid-action';
    await expectError(
      await request(app)
        .post(`/api/admin/projects/${project.id}/import/commit`)
        .set('X-Request-Id', actionRequestId)
        .send({
          source: { type: 'curl', text: 'curl https://api.example.test' },
          snapshotToken: 'token',
          selectedItemIds: ['item'],
          actions: [{ itemId: 'item', action: 'skip', extra: true }],
        }),
      422,
      'IMPORT_SELECTION_INVALID',
      actionRequestId,
    );

    await expectError(
      await request(app).post(route('invalid%2Fproject')).set('X-Request-Id', 'invalid-project').send({
        source: { type: 'curl', text: 'curl https://api.example.test' },
      }),
      400,
      'INVALID_PROJECT_ID',
      'invalid-project',
    );
    await expectError(
      await request(app).post(route('prj_missing')).set('X-Request-Id', 'missing-project').send({
        source: { type: 'curl', text: 'curl https://api.example.test' },
      }),
      404,
      'PROJECT_NOT_FOUND',
      'missing-project',
    );
    await expectError(
      await request(app)
        .post(route())
        .set('Content-Type', 'application/json')
        .set('X-Request-Id', 'malformed-json')
        .send('{"source":'),
      400,
      'MALFORMED_JSON',
      'malformed-json',
    );
    await expectError(
      await request(app)
        .post(route())
        .set('X-Request-Id', 'envelope-limit')
        .send({ padding: 'x'.repeat(12 * 1024 * 1024) }),
      413,
      'PAYLOAD_TOO_LARGE',
      'envelope-limit',
    );
  });

  it('enforces import part and semantic parser limits before repository mutation', async () => {
    const project = await createProject();
    const previewRoute = `/api/admin/projects/${project.id}/import/preview`;
    const commitRoute = `/api/admin/projects/${project.id}/import/commit`;

    const oversizedSource = await request(app).post(previewRoute).send({
      source: { type: 'curl', text: 'x'.repeat(10 * 1024 * 1024) },
    });
    expect(oversizedSource).toMatchObject({ status: 422, body: { code: 'IMPORT_LIMIT_EXCEEDED' } });

    const oversizedCommitFields = await request(app).post(commitRoute).send({
      source: { type: 'curl', text: 'curl https://api.example.test/users' },
      variables: { padding: 'x'.repeat(1024 * 1024) },
      snapshotToken: 'token',
      selectedItemIds: [],
      actions: [],
    });
    expect(oversizedCommitFields).toMatchObject({ status: 422, body: { code: 'IMPORT_LIMIT_EXCEEDED' } });

    const curlLimit = await request(app).post(previewRoute).send({
      source: {
        type: 'curl',
        text: Array.from({ length: 1_001 }, (_, index) => (
          `curl https://api${index}.example.test/users`
        )).join(';'),
      },
    });
    expect(curlLimit).toMatchObject({ status: 422, body: { code: 'IMPORT_LIMIT_EXCEEDED' } });

    const postmanLimit = await request(app).post(previewRoute).send({
      source: {
        type: 'postman',
        collection: {
          info: {
            name: 'Too many',
            schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
          },
          item: Array.from({ length: 1_001 }, (_, index) => ({
            name: `Request ${index}`,
            request: { method: 'GET', url: `https://api.example.test/${index}` },
          })),
        },
      },
    });
    expect(postmanLimit).toMatchObject({ status: 422, body: { code: 'IMPORT_LIMIT_EXCEEDED' } });
  });

  it('rejects multibyte preview non-source fields before invoking the repository', async () => {
    const previewImport = vi.fn();
    const isolated = express();
    isolated.use(express.json({ limit: '12mb' }));
    isolated.use(requestIdMiddleware);
    isolated.use('/projects/:projectId/import', createImportsRouter({
      previewImport,
    } as unknown as ProjectRepository));
    isolated.use(apiErrorMiddleware);

    const response = await request(isolated).post('/projects/prj_1/import/preview').send({
      source: { type: 'curl', text: 'curl https://api.example.test/users' },
      variables: { padding: 'é'.repeat(524_289) },
    });

    expect(response).toMatchObject({ status: 422, body: { code: 'IMPORT_LIMIT_EXCEEDED' } });
    expect(previewImport).not.toHaveBeenCalled();
  });

  it('returns exact unresolved, selection, no-op, and stale commit errors', async () => {
    const project = await createProject();
    const previewRoute = `/api/admin/projects/${project.id}/import/preview`;
    const commitRoute = `/api/admin/projects/${project.id}/import/commit`;
    const postmanSource = {
      type: 'postman' as const,
      collection: {
        info: {
          name: 'Variables',
          schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
        },
        item: [{ name: 'Users', request: { method: 'GET', url: 'https://{{host}}/users' } }],
      },
    };
    const unresolved = await request(app).post(previewRoute).send({ source: postmanSource }).expect(200);
    const unresolvedCommit = await request(app).post(commitRoute).send({
      source: postmanSource,
      snapshotToken: unresolved.body.snapshotToken,
      selectedItemIds: [],
      actions: [],
    });
    expect(unresolvedCommit).toMatchObject({ status: 422, body: { code: 'IMPORT_VARIABLES_REQUIRED' } });

    const source = { type: 'curl' as const, text: 'curl https://api.example.test/users' };
    const preview = await request(app).post(previewRoute).send({ source }).expect(200);
    const invalidSelection = await request(app).post(commitRoute).send({
      source,
      snapshotToken: preview.body.snapshotToken,
      selectedItemIds: ['unknown'],
      actions: [{ itemId: 'unknown', action: 'skip' }],
    });
    expect(invalidSelection).toMatchObject({ status: 422, body: { code: 'IMPORT_SELECTION_INVALID' } });

    const noChanges = await request(app).post(commitRoute).send({
      source,
      snapshotToken: preview.body.snapshotToken,
      selectedItemIds: [],
      actions: [],
    });
    expect(noChanges).toMatchObject({ status: 422, body: { code: 'IMPORT_NO_CHANGES' } });

    await request(app).post(`/api/admin/projects/${project.id}/endpoints`).send({
      name: 'Canonical change',
      baseUrl: 'https://api.example.test',
      matcher: { method: 'GET', path: '/changed' },
      mode: 'mock',
      variants: [{ name: 'Default', status: 200, responseHeaders: {} }],
      defaultVariantIndex: 0,
    }).expect(201);
    const stale = await request(app).post(commitRoute).send({
      source,
      snapshotToken: preview.body.snapshotToken,
      selectedItemIds: [preview.body.items[0].id],
      actions: [{ itemId: preview.body.items[0].id, action: 'create' }],
    });
    expect(stale).toMatchObject({ status: 409, body: { code: 'IMPORT_PREVIEW_STALE' } });
  });

  it('never serializes raw import source, request, auth, variable, or response content', async () => {
    const project = await createProject();
    const rawCurl = "curl 'https://api.example.test/users?token=query-secret' -H 'Authorization: Bearer auth-secret' --data 'request-body-secret'";
    const curlPreview = await request(app)
      .post(`/api/admin/projects/${project.id}/import/preview`)
      .send({ source: { type: 'curl', text: rawCurl } })
      .expect(200);
    const serializedCurl = JSON.stringify(curlPreview.body);
    expect(serializedCurl).not.toContain(rawCurl);
    expect(serializedCurl).not.toMatch(/query-secret|auth-secret|request-body-secret/);

    const collection = {
      info: {
        name: 'Secrets',
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      },
      auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{credential}}' }] },
      item: [{
        name: 'Users',
        request: {
          method: 'POST',
          url: 'https://api.example.test/users',
          body: { mode: 'raw', raw: 'postman-request-secret' },
        },
        response: [{ name: 'OK', code: 200, body: 'postman-response-secret' }],
      }],
    };
    const postmanPreview = await request(app)
      .post(`/api/admin/projects/${project.id}/import/preview`)
      .send({
        source: { type: 'postman', collection },
        variables: { credential: 'supplied-secret' },
      })
      .expect(200);
    expect(JSON.stringify(postmanPreview.body)).not.toMatch(
      /postman-request-secret|postman-response-secret|supplied-secret/,
    );
  });

  it('exposes no legacy payload or identity routes', async () => {
    const project = await createProject();
    await request(app).get(`/api/admin/projects/${project.id}/resources`).expect(404);
    await request(app).put(`/api/admin/projects/${project.id}/activate`).expect(404);
    await request(app).put(`/api/admin/projects/${project.id}/scenario`).send({ name: 'old' }).expect(404);
    await request(app).post('/api/admin/import/postman-project').send({}).expect(404);
    await request(app).post(`/api/admin/projects/${project.id}/import/curl`).send({}).expect(404);
    await request(app).post(`/api/admin/projects/${project.id}/import/postman`).send({}).expect(404);
  });

  it('removes the legacy Traffic routes from the admin surface', async () => {
    const project = await createProject();

    for (const response of [
      await request(app).get(`/api/admin/projects/${project.id}/logs`),
      await request(app).post(`/api/admin/projects/${project.id}/logs/traffic_1/create-mock`).send({}),
    ]) {
      expect(response).toMatchObject({
        status: 404,
        body: { code: 'ADMIN_ROUTE_NOT_FOUND', requestId: expect.any(String) },
      });
    }
  });

  it('owns the six canonical Traffic routes with strict queries and exact body metadata', async () => {
    const project = await runtime.repository.createProject({ name: 'Traffic Project' });
    const bytes = Buffer.from('captured bytes');
    const release = vi.fn(async () => undefined);
    const promotionInput = {
      expectedTrafficGeneration: 'generation-1',
      expectedResponseIdentity: 'response-1',
      endpoint: { action: 'create' as const },
      state: { action: 'unbound' as const },
    };
    const promotionResult = {
      endpointId: 'ep_1', endpointCreated: true,
      variantId: 'var_1', variantCreated: true,
      endpointModeChanged: false, bindingChanged: false,
    };
    const traffic = {
      list: vi.fn(() => ({ entries: [], hasMore: false })),
      get: vi.fn(() => ({ id: 'traffic_1' })),
      clear: vi.fn(async () => undefined),
      openBody: vi.fn(async (_projectId: string, _trafficId: string, side: 'request' | 'response') => ({
        descriptor: {
          side,
          state: 'available' as const,
          mediaType: 'application/octet-stream',
          contentEncoding: 'gzip, br',
          observedSize: bytes.length,
          retainedSize: bytes.length,
          sha256: 'ab'.repeat(32),
        },
        lease: {
          projectId: project.id, sha256: 'ab'.repeat(32), byteCount: bytes.length,
          openStream: () => Readable.from(bytes), release,
        },
      })),
      promoter: { promote: vi.fn(async () => promotionResult) },
    } as unknown as TrafficService;
    const isolated = express();
    isolated.use(requestIdMiddleware);
    isolated.use(express.json());
    isolated.use('/projects/:projectId/traffic', createTrafficRouter(runtime.repository, traffic));
    isolated.use(apiErrorMiddleware);

    await request(isolated).get(`/projects/${project.id}/traffic?afterId=traffic_0&limit=25`).expect(200);
    await request(isolated).get(`/projects/${project.id}/traffic/traffic_1`).expect(200);
    await request(isolated).delete(`/projects/${project.id}/traffic`).expect(204);
    const bodies = await Promise.all((['request', 'response'] as const).map(side => request(isolated)
      .get(`/projects/${project.id}/traffic/traffic_1/bodies/${side}?download=1`)
      .buffer(true)
      .parse((source, callback) => {
        const chunks: Buffer[] = [];
        source.on('data', chunk => chunks.push(Buffer.from(chunk)));
        source.on('end', () => callback(null, Buffer.concat(chunks)));
      })
      .expect(200)));
    const promoted = await request(isolated)
      .post(`/projects/${project.id}/traffic/traffic_1/mock`)
      .send(promotionInput)
      .expect(200);

    expect(traffic.list).toHaveBeenCalledWith(project.id, { afterId: 'traffic_0', limit: 25 });
    expect(traffic.get).toHaveBeenCalledWith(project.id, 'traffic_1');
    expect(traffic.clear).toHaveBeenCalledWith(project.id);
    for (const body of bodies) {
      expect(Buffer.from(body.body)).toEqual(bytes);
      expect(body.headers).toMatchObject({
        'content-type': 'application/octet-stream',
        'content-length': String(bytes.length),
        'content-disposition': 'attachment',
        'x-mockmate-original-content-encoding': 'gzip, br',
        'x-mockmate-sha256': 'ab'.repeat(32),
        'x-request-id': expect.any(String),
      });
      expect(body.headers).not.toHaveProperty('content-encoding');
    }
    expect(traffic.openBody).toHaveBeenCalledWith(project.id, 'traffic_1', 'request');
    expect(traffic.openBody).toHaveBeenCalledWith(project.id, 'traffic_1', 'response');
    expect(release).toHaveBeenCalledTimes(2);
    expect(traffic.promoter.promote).toHaveBeenCalledWith(project.id, 'traffic_1', promotionInput);
    expect(traffic.get).toHaveBeenCalledOnce();
    expect(promoted.body).toEqual(promotionResult);

    await request(isolated)
      .get(`/projects/${project.id}/traffic/traffic_1/body/response`)
      .expect(404);

    for (const query of ['?extra=1', '?limit=0', '?afterId=a&beforeId=b']) {
      await request(isolated).get(`/projects/${project.id}/traffic${query}`).expect(422);
    }
  });
});
