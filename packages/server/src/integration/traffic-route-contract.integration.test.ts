import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { trafficApi } from '../../../dashboard/src/api/client';
import { startServers } from '../app';
import type { PublicationOperation } from '../repository/traffic-promotion';
import { createProcessTrafficContext, createRuntime } from '../runtime/create-runtime';
import { createIntegrationHarness } from './integration-harness';

function directRequest(port: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port,
      path: '/captured',
      method: 'GET',
      headers: { Host: 'api.example.test' },
    }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => resolve(Buffer.concat(chunks)));
    });
    request.on('error', reject);
    request.end();
  });
}

describe('live dashboard Traffic route contract', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses the actual dashboard client against the six canonical server operations', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mockmate-traffic-contract-'));
    const runtime = await createRuntime({
      rootDirectory: root,
      processTraffic: createProcessTrafficContext(),
      isAdminRequestLocal: () => true,
    });
    const project = await runtime.repository.createProject({ name: 'Traffic Contract' });
    const settings = runtime.repository.getRuntimeSettings(project.id);
    await runtime.repository.updateRuntimeSettings(project.id, {
      expectedRevision: settings.revision,
      interceptHosts: ['api.example.test'],
      captureRawTraffic: true,
      debugProvenanceHeaders: false,
    });
    const bytes = Buffer.from('canonical captured body');
    const asset = await runtime.repository.putBody(
      project.id,
      Readable.from(bytes),
      { mediaType: 'text/plain' },
      { maxBytes: 1024 },
    );
    await runtime.repository.createEndpoint(project.id, {
      name: 'Captured',
      baseUrl: 'http://api.example.test',
      matcher: { method: 'GET', path: '/captured' },
      mode: 'mock',
      variants: [{
        name: 'Captured response', status: 200,
        responseHeaders: { 'content-type': 'text/plain' },
        bodyAssetId: asset.id,
      }],
      defaultVariantIndex: 0,
    });
    await runtime.repository.setActiveProject(
      project.id,
      runtime.repository.getWorkspaceState().revision,
    );
    const owner = await startServers({
      runtime,
      requestedPorts: { http: 0, https: 0, proxy: 0 },
      certificateDirectory: path.join(root, 'certificates'),
    });
    const base = `http://127.0.0.1:${owner.ports.http}`;
    const nativeFetch = globalThis.fetch;
    const setup = await nativeFetch(`${base}/setup`);
    const setupHtml = await setup.text();
    expect(setup.status).toBe(200);
    for (const port of [owner.ports.http, owner.ports.https, owner.ports.proxy]) {
      expect(setupHtml).toContain(String(port));
    }
    const activeCa = await nativeFetch(`${base}/setup/ca.crt`);
    expect(Buffer.from(await activeCa.arrayBuffer())).toEqual(
      await fs.promises.readFile(path.join(root, 'certificates', 'ca.crt')),
    );
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => (
      nativeFetch(new URL(String(input), base), init)
    ));

    try {
      await expect(directRequest(owner.ports.http)).resolves.toEqual(bytes);
      await vi.waitFor(async () => {
        expect((await trafficApi.list(project.id)).entries).toHaveLength(1);
      });
      const page = await trafficApi.list(project.id);
      const trafficId = page.entries[0]!.id;
      const detail = await trafficApi.detail(project.id, trafficId);
      expect(detail).toMatchObject({ id: trafficId, projectId: project.id, decision: 'mock' });

      const body = await trafficApi.body(project.id, trafficId, 'response');
      expect(Buffer.from(await body.arrayBuffer())).toEqual(bytes);
      const download = await fetch(trafficApi.bodyDownloadUrl(project.id, trafficId, 'response'));
      expect(download.headers.get('content-disposition')).toBe('attachment');
      expect(Buffer.from(await download.arrayBuffer())).toEqual(bytes);

      if (detail.promotion.state !== 'eligible') throw new Error('Expected promotable Traffic');
      const command = {
        expectedTrafficGeneration: detail.promotion.review.expectedTrafficGeneration,
        expectedResponseIdentity: detail.promotion.review.expectedResponseIdentity,
        endpoint: detail.promotion.review.endpoint.action === 'create'
          ? { action: 'create' as const }
          : {
            action: 'reuse' as const,
            endpointId: detail.promotion.review.endpoint.endpointId,
            expectedRevision: detail.promotion.review.endpoint.expectedRevision,
          },
        state: detail.promotion.review.state,
      };
      const promoted = await trafficApi.promote(project.id, trafficId, command);
      expect(promoted).toMatchObject({
        endpointId: expect.any(String),
        variantId: expect.any(String),
      });
      await expect(trafficApi.promote(project.id, trafficId, command)).resolves.toEqual(promoted);

      for (const legacyPath of [
        `/api/admin/projects/${project.id}/logs`,
        `/api/admin/projects/${project.id}/logs/${trafficId}/create-mock`,
      ]) {
        const legacy = await fetch(legacyPath, { method: legacyPath.endsWith('create-mock') ? 'POST' : 'GET' });
        expect(legacy.status).toBe(404);
        await expect(legacy.json()).resolves.toMatchObject({ code: 'ADMIN_ROUTE_NOT_FOUND' });
      }

      await trafficApi.clear(project.id);
      expect((await trafficApi.list(project.id)).entries).toEqual([]);
    } finally {
      await owner.close();
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it.each<PublicationOperation>(['memoryPublish', 'resultAttach', 'cleanup'])(
    'replays the committed result after a %s failure in-process and after restart',
    async operation => {
      let fired = false;
      const harness = await createIntegrationHarness({
        publicationFailpoints: {
          async before(candidate) {
            if (!fired && candidate === operation) {
              fired = true;
              throw new Error(`${operation} failed`);
            }
          },
        },
      });
      try {
        const project = await harness.repository.createProject({ name: `${operation} replay` });
        const settings = harness.repository.getRuntimeSettings(project.id);
        await harness.repository.updateRuntimeSettings(project.id, {
          expectedRevision: settings.revision,
          interceptHosts: ['api.example.test'],
          captureRawTraffic: true,
          debugProvenanceHeaders: false,
        });
        const bytes = Buffer.from(`${operation} response`);
        const asset = await harness.repository.putBody(
          project.id,
          Readable.from(bytes),
          { mediaType: 'text/plain' },
          { maxBytes: 1024 },
        );
        await harness.repository.createEndpoint(project.id, {
          name: `${operation} endpoint`,
          baseUrl: 'http://api.example.test',
          matcher: { method: 'GET', path: '/captured' },
          mode: 'mock',
          variants: [{
            name: `${operation} response`, status: 200,
            responseHeaders: { 'content-type': 'text/plain' },
            bodyAssetId: asset.id,
          }],
          defaultVariantIndex: 0,
        });
        await harness.repository.setActiveProject(
          project.id,
          harness.repository.getWorkspaceState().revision,
        );
        await harness.request.get('/captured').set('Host', 'api.example.test').expect(200);
        let trafficId = '';
        await vi.waitFor(async () => {
          const response = await harness.request
            .get(`/api/admin/projects/${project.id}/traffic`)
            .expect(200);
          expect(response.body.entries).toHaveLength(1);
          trafficId = response.body.entries[0].id;
        });
        const detail = await harness.request
          .get(`/api/admin/projects/${project.id}/traffic/${trafficId}`)
          .expect(200);
        expect(detail.body.promotion.state).toBe('eligible');
        const review = detail.body.promotion.review;
        const command = {
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
        };

        await harness.request
          .post(`/api/admin/projects/${project.id}/traffic/${trafficId}/mock`)
          .send(command)
          .expect(500);
        expect(fired).toBe(true);
        const replay = await harness.request
          .post(`/api/admin/projects/${project.id}/traffic/${trafficId}/mock`)
          .send(command)
          .expect(200);
        await harness.restart();
        const restartedReplay = await harness.request
          .post(`/api/admin/projects/${project.id}/traffic/${trafficId}/mock`)
          .send(command)
          .expect(200);
        expect(restartedReplay.body).toEqual(replay.body);
      } finally {
        await harness.dispose();
      }
    },
    30_000,
  );
});
