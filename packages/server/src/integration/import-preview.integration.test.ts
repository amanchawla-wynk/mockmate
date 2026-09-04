import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { Response } from 'supertest';

import type {
  AppState,
  BodyAsset,
  EndpointDetail,
  EndpointSummary,
  Project,
  ProjectRuntimeSettings,
  ResponseVariant,
  WorkspaceState,
} from '../domain/model';
import type { ImportCommitResult, ImportPreview } from '../import/contracts';
import type { ProxyTestResponse } from '../test-support/proxy-test-client';
import {
  createIntegrationHarness,
  hashTree,
  type IntegrationHarness,
} from './integration-harness';

const POSTMAN_V21_SCHEMA = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';

function binaryParser(
  response: NodeJS.ReadableStream,
  callback: (error: Error | null, body?: Buffer) => void,
): void {
  const chunks: Buffer[] = [];
  response.on('data', chunk => chunks.push(Buffer.from(chunk)));
  response.on('end', () => callback(null, Buffer.concat(chunks)));
  response.on('error', callback);
}

async function uploadBody(
  harness: IntegrationHarness,
  projectId: string,
  bytes: Buffer,
  mediaType: string,
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

function delivered(response: ProxyTestResponse): {
  status: number;
  headers: Record<string, string | string[]>;
  body: Buffer;
} {
  const headers: Record<string, string | string[]> = {};
  for (const [rawName, value] of response.rawHeaders) {
    const name = rawName.toLowerCase();
    const current = headers[name];
    if (current === undefined) headers[name] = value;
    else headers[name] = Array.isArray(current) ? [...current, value] : [current, value];
  }
  return { status: response.statusCode, headers, body: response.body };
}

type AppStateSnapshot = Array<Pick<AppState, 'id' | 'revision' | 'bindings'>>;

async function canonicalStateSnapshot(
  harness: IntegrationHarness,
  projectId: string,
): Promise<AppStateSnapshot> {
  const stateResponse = await harness.request
    .get(`/api/admin/projects/${projectId}/states`)
    .expect(200);
  const states = await Promise.all((stateResponse.body as Array<{ id: string }>).map(async ({ id }) => {
    const response = await harness.request
      .get(`/api/admin/projects/${projectId}/states/${id}`)
      .expect(200);
    const state = response.body as AppState;
    return { id: state.id, revision: state.revision, bindings: state.bindings };
  }));
  return states.sort((left, right) => left.id.localeCompare(right.id));
}

async function canonicalSnapshot(harness: IntegrationHarness, projectId: string): Promise<{
  endpointIdsAndVariantIds: Array<{ id: string; variantIds: string[] }>;
  states: AppStateSnapshot;
  pointer: unknown;
  generationDirectories: string[];
  bodyFiles: Record<string, string>;
}> {
  const endpointResponse = await harness.request
    .get(`/api/admin/projects/${projectId}/endpoints`)
    .expect(200);
  const endpoints = endpointResponse.body as EndpointSummary[];
  const endpointDetails = await Promise.all(endpoints.map(async endpoint => (
    (await harness.request
      .get(`/api/admin/projects/${projectId}/endpoints/${endpoint.id}`)
      .expect(200)).body as EndpointDetail
  )));
  const projectRoot = path.join(harness.rootDirectory, 'projects', projectId);
  return {
    endpointIdsAndVariantIds: endpointDetails.map(endpoint => ({
      id: endpoint.id,
      variantIds: endpoint.variants.map(variant => variant.id),
    })),
    states: await canonicalStateSnapshot(harness, projectId),
    pointer: await harness.readJson(`projects/${projectId}/current.json`),
    generationDirectories: (await fs.promises.readdir(path.join(projectRoot, 'generations'))).sort(),
    bodyFiles: await hashTree(path.join(projectRoot, 'bodies')),
  };
}

it('imports multiple backends through HTTP, survives restart, and rejects stale multi-item commits atomically', async () => {
  const harness = await createIntegrationHarness();
  try {
    const projectResponse = await harness.request.post('/api/admin/projects').send({
      name: 'Import acceptance',
    }).expect(201);
    const project = projectResponse.body as Project;
    const existingFallbackBytes = Buffer.from('existing fallback');
    const existingFallbackAsset = await uploadBody(
      harness,
      project.id,
      existingFallbackBytes,
      'text/plain',
    );
    const existingEndpointResponse = await harness.request
      .post(`/api/admin/projects/${project.id}/endpoints`)
      .send({
        name: 'Existing fallback endpoint',
        baseUrl: 'https://legacy.api.example.test',
        matcher: { method: 'GET', path: '/legacy' },
        mode: 'mock',
        variants: [{
          name: 'Existing fallback',
          status: 200,
          responseHeaders: { 'content-type': 'text/plain' },
          bodyAssetId: existingFallbackAsset.id,
        }],
        defaultVariantIndex: 0,
      })
      .expect(201);
    const existingEndpoint = existingEndpointResponse.body as EndpointDetail;
    const existingFallback = existingEndpoint.variants[0]!;
    const stateResponse = await harness.request
      .post(`/api/admin/projects/${project.id}/states`)
      .send({
        name: 'Existing state',
        tags: ['acceptance'],
        bindings: { [existingEndpoint.id]: existingFallback.id },
      })
      .expect(201);
    const existingState = stateResponse.body as AppState;
    const unboundStateResponse = await harness.request
      .post(`/api/admin/projects/${project.id}/states`)
      .send({ name: 'Unbound state', tags: ['acceptance'], bindings: {} })
      .expect(201);
    const unboundState = unboundStateResponse.body as AppState;
    const interceptHosts = [
      'legacy.api.example.test',
      'eu.api.example.test',
      'billing.api.example.test',
    ];
    const initialSettingsResponse = await harness.request
      .get(`/api/admin/projects/${project.id}/runtime-settings`)
      .expect(200);
    await harness.request
      .put(`/api/admin/projects/${project.id}/runtime-settings`)
      .send({
        expectedRevision: (initialSettingsResponse.body as ProjectRuntimeSettings).revision,
        interceptHosts,
        captureRawTraffic: false,
        debugProvenanceHeaders: false,
      })
      .expect(200);
    const workspaceResponse = await harness.request.get('/api/admin/workspace').expect(200);
    await harness.request.put('/api/admin/workspace').send({
      expectedRevision: (workspaceResponse.body as WorkspaceState).revision,
      activeProjectId: project.id,
    }).expect(200);

    const importedMergeBytes = Buffer.from('imported accepted');
    const importedMergeAssetId = createHash('sha256').update(importedMergeBytes).digest('hex');
    const collection = {
      info: { name: 'Multi-backend acceptance', schema: POSTMAN_V21_SCHEMA },
      variable: [{ key: 'region', value: 'eu' }],
      item: [
        {
          name: 'Merge legacy response',
          request: { method: 'GET', url: 'https://legacy.api.example.test/legacy' },
          response: [{
            name: 'Imported accepted',
            code: 202,
            header: [
              { key: 'Content-Type', value: 'text/plain' },
              { key: 'X-Import-Trace', value: 'trace-one' },
              { key: 'x-import-trace', value: 'trace-two' },
              { key: 'Connection', value: 'close' },
              { key: 'Content-Length', value: '999' },
            ],
            body: importedMergeBytes.toString('utf8'),
          }],
        },
        {
          name: 'Regional account',
          request: { method: 'GET', url: 'https://{{region}}.api.example.test:8443/accounts/:id' },
          response: [{
            name: 'Multi-status account',
            code: 207,
            header: [
              { key: 'Content-Type', value: 'application/vnd.mockmate+json; profile=import' },
              { key: 'Set-Cookie', value: 'session=one; Path=/' },
              { key: 'set-cookie', value: 'theme=dark; Path=/' },
            ],
            body: '{"account":true}',
          }],
        },
        {
          name: 'Second backend status',
          request: { method: 'GET', url: 'https://{{backendHost}}/status' },
          response: [{
            name: 'Bodyless status',
            code: 204,
            header: [{ key: 'Content-Type', value: 'application/vnd.mockmate.empty' }],
          }],
        },
      ],
    };
    const source = { type: 'postman' as const, collection };
    const variables = {
      region: 'ignored-by-collection-default',
      backendHost: 'billing.api.example.test',
    };
    const statesBeforeImport = await canonicalStateSnapshot(harness, project.id);
    expect(statesBeforeImport.map(state => state.id)).toEqual([
      existingState.id,
      unboundState.id,
    ].sort());
    const settingsBeforeImport = (await harness.request
      .get(`/api/admin/projects/${project.id}/runtime-settings`)
      .expect(200)).body as ProjectRuntimeSettings;
    const workspaceBeforeImport = (await harness.request
      .get('/api/admin/workspace')
      .expect(200)).body as WorkspaceState;

    const previewResponse = await harness.request
      .post(`/api/admin/projects/${project.id}/import/preview`)
      .send({ source, variables })
      .expect(200);
    const preview = previewResponse.body as ImportPreview;
    expect(preview.unresolvedVariables).toEqual([]);
    expect(preview.discoveredOrigins).toEqual([
      'https://billing.api.example.test',
      'https://eu.api.example.test:8443',
      'https://legacy.api.example.test',
    ]);
    const mergeItem = preview.items.find(item => item.matcher.path === '/legacy')!;
    const accountItem = preview.items.find(item => item.matcher.path === '/accounts/*')!;
    const secondBackendItem = preview.items.find(item => item.matcher.path === '/status')!;
    expect(mergeItem).toMatchObject({
      proposedAction: 'merge',
      allowedActions: ['merge', 'skip'],
      selectedByDefault: true,
      createEffect: { createsEndpoint: false, createsVariants: 0 },
    });
    expect(mergeItem.responses).toEqual([{
      name: 'Imported accepted',
      status: 202,
      responseHeaders: {
        'content-type': 'text/plain',
        'x-import-trace': ['trace-one', 'trace-two'],
      },
      body: {
        kind: 'sha256',
        sha256: importedMergeAssetId,
        byteCount: importedMergeBytes.length,
      },
      identity: expect.any(String),
    }]);
    expect(mergeItem.exactTargets).toEqual([
      {
        endpointId: existingEndpoint.id,
        endpointRevision: existingEndpoint.revision,
        name: existingEndpoint.name,
        newVariantCount: 1,
        candidateResponses: mergeItem.responses,
      },
    ]);
    expect(mergeItem.overlaps).toEqual([]);
    const [mergeTarget] = mergeItem.exactTargets;
    expect(accountItem).toMatchObject({
      baseUrl: 'https://eu.api.example.test:8443',
      matcher: { method: 'GET', path: '/accounts/*' },
    });
    expect(accountItem).toMatchObject({
      proposedAction: 'create',
      allowedActions: ['create', 'skip'],
      selectedByDefault: true,
      createEffect: { createsEndpoint: true, createsVariants: 1 },
    });
    expect(accountItem.exactTargets).toEqual([]);
    expect(accountItem.overlaps).toEqual([]);
    expect(secondBackendItem).toMatchObject({
      baseUrl: 'https://billing.api.example.test',
      matcher: { method: 'GET', path: '/status' },
      proposedAction: 'create',
      allowedActions: ['create', 'skip'],
      selectedByDefault: true,
      createEffect: { createsEndpoint: true, createsVariants: 1 },
    });
    expect(secondBackendItem.exactTargets).toEqual([]);
    expect(secondBackendItem.overlaps).toEqual([]);

    const selectedItemIds = [mergeItem.id, accountItem.id, secondBackendItem.id];
    const commitResponse = await harness.request
      .post(`/api/admin/projects/${project.id}/import/commit`)
      .send({
        source,
        variables,
        snapshotToken: preview.snapshotToken,
        selectedItemIds,
        actions: [
          { itemId: mergeItem.id, action: mergeItem.proposedAction, endpointId: mergeTarget.endpointId },
          { itemId: accountItem.id, action: accountItem.proposedAction },
          { itemId: secondBackendItem.id, action: secondBackendItem.proposedAction },
        ],
      })
      .expect(201);
    const result = commitResponse.body as ImportCommitResult;
    expect(Object.keys(result).sort()).toEqual([
      'createdEndpointIds',
      'createdVariantIds',
      'skippedItemIds',
      'updatedEndpointIds',
    ]);
    expect(result).toEqual({
      createdEndpointIds: [expect.any(String), expect.any(String)],
      updatedEndpointIds: [existingEndpoint.id],
      createdVariantIds: [expect.any(String), expect.any(String), expect.any(String)],
      skippedItemIds: [],
    });
    expect(Object.values(result).flat().every(value => typeof value === 'string')).toBe(true);

    const mergedEndpoint = (await harness.request
      .get(`/api/admin/projects/${project.id}/endpoints/${existingEndpoint.id}`)
      .expect(200)).body as EndpointDetail;
    expect({
      schemaVersion: mergedEndpoint.schemaVersion,
      id: mergedEndpoint.id,
      projectId: mergedEndpoint.projectId,
      name: mergedEndpoint.name,
      description: mergedEndpoint.description,
      matcher: mergedEndpoint.matcher,
      defaultVariantId: mergedEndpoint.defaultVariantId,
    }).toEqual({
      schemaVersion: existingEndpoint.schemaVersion,
      id: existingEndpoint.id,
      projectId: existingEndpoint.projectId,
      name: existingEndpoint.name,
      description: existingEndpoint.description,
      matcher: existingEndpoint.matcher,
      defaultVariantId: existingEndpoint.defaultVariantId,
    });
    expect(mergedEndpoint.revision).toBe(existingEndpoint.revision + 1);
    expect(mergedEndpoint.defaultVariantId).toBe(existingFallback.id);
    expect(mergedEndpoint.variants).toHaveLength(existingEndpoint.variants.length + 1);
    expect(mergedEndpoint.variants[0]).toEqual(existingFallback);
    const importedMergeVariant = mergedEndpoint.variants[1]!;
    expect(importedMergeVariant).toEqual({
      id: result.createdVariantIds[0],
      endpointId: existingEndpoint.id,
      name: 'Imported accepted',
      status: 202,
      responseHeaders: {
        'content-type': 'text/plain',
        'x-import-trace': ['trace-one', 'trace-two'],
      },
      bodyAssetId: importedMergeAssetId,
      revision: 0,
    });
    expect(result.createdVariantIds.filter(id => id === importedMergeVariant.id)).toEqual([
      importedMergeVariant.id,
    ]);
    const importedMergeDownload = await downloadBody(harness, project.id, importedMergeAssetId);
    expect(importedMergeDownload.status).toBe(200);
    expect(importedMergeDownload.headers['content-type']).toMatch(/^application\/octet-stream\b/);
    expect(importedMergeDownload.headers['content-length']).toBe(String(importedMergeBytes.length));
    expect(importedMergeDownload.body).toEqual(importedMergeBytes);
    const fallbackDownload = await downloadBody(harness, project.id, existingFallbackAsset.id);
    expect(fallbackDownload.status).toBe(200);
    expect(fallbackDownload.body).toEqual(existingFallbackBytes);
    const statesAfterImport = await canonicalStateSnapshot(harness, project.id);
    expect(statesAfterImport.map(state => state.id)).toEqual(statesBeforeImport.map(state => state.id));
    expect(statesAfterImport).toEqual(statesBeforeImport);
    expect((await harness.request
      .get(`/api/admin/projects/${project.id}/runtime-settings`)
      .expect(200)).body).toEqual(settingsBeforeImport);
    expect((await harness.request.get('/api/admin/workspace').expect(200)).body)
      .toEqual(workspaceBeforeImport);

    const createdEndpoints = await Promise.all(result.createdEndpointIds.map(async endpointId => (
      (await harness.request
        .get(`/api/admin/projects/${project.id}/endpoints/${endpointId}`)
        .expect(200)).body as EndpointDetail
    )));
    const accountEndpoint = createdEndpoints.find(endpoint => endpoint.matcher.path === '/accounts/*')!;
    const secondBackendEndpoint = createdEndpoints.find(endpoint => endpoint.matcher.path === '/status')!;
    const accountVariant = accountEndpoint.variants[0]!;
    const secondBackendVariant = secondBackendEndpoint.variants[0]!;
    expect(accountVariant.bodyAssetId).toBe(createHash('sha256').update('{"account":true}').digest('hex'));
    const importedBodyDownload = await downloadBody(harness, project.id, accountVariant.bodyAssetId!);
    expect(importedBodyDownload.status).toBe(200);
    expect(importedBodyDownload.headers['content-type']).toMatch(/^application\/octet-stream\b/);
    expect(importedBodyDownload.body).toEqual(Buffer.from('{"account":true}'));
    expect(secondBackendVariant).not.toHaveProperty('bodyAssetId');

    await harness.restart();
    expect((await harness.request.get('/api/admin/workspace').expect(200)).body)
      .toEqual(workspaceBeforeImport);
    const proxy = await harness.proxy();
    const accountDelivery = delivered(await proxy.requestTls({
      host: 'eu.api.example.test',
      targetPort: 8443,
      path: '/accounts/42',
    }));
    expect(accountDelivery.status).toBe(207);
    expect(accountDelivery.body).toEqual(Buffer.from('{"account":true}'));
    expect(accountDelivery.headers['content-type']).toBe('application/vnd.mockmate+json; profile=import');
    expect(accountDelivery.headers['set-cookie']).toEqual([
      'session=one; Path=/',
      'theme=dark; Path=/',
    ]);

    const wrongHostDelivery = delivered(await proxy.requestTls({
      host: 'billing.api.example.test',
      path: '/accounts/42',
    }));
    expect(wrongHostDelivery.status).toBe(502);
    expect(JSON.parse(wrongHostDelivery.body.toString('utf8'))).toMatchObject({
      code: 'UPSTREAM_FAILURE',
    });
    const secondBackendDelivery = delivered(await proxy.requestTls({
      host: 'billing.api.example.test',
      path: '/status',
    }));
    expect(secondBackendDelivery.status).toBe(204);
    expect(secondBackendDelivery.body).toEqual(Buffer.alloc(0));
    expect(secondBackendDelivery.headers['content-type']).toBe('application/vnd.mockmate.empty');
    const fallbackDelivery = delivered(await proxy.requestTls({
      host: 'legacy.api.example.test',
      path: '/legacy',
    }));
    expect(fallbackDelivery.status).toBe(200);
    expect(fallbackDelivery.body).toEqual(existingFallbackBytes);

    const staleBodies = [Buffer.from('stale candidate one'), Buffer.from('stale candidate two')];
    const staleCollection = {
      info: { name: 'Stale multi-item import', schema: POSTMAN_V21_SCHEMA },
      item: staleBodies.map((body, index) => ({
        name: `Stale candidate ${index + 1}`,
        request: { method: 'GET', url: `https://stale.example.test/candidate-${index + 1}` },
        response: [{ name: 'Candidate', code: 200, body: body.toString('utf8') }],
      })),
    };
    const staleSource = { type: 'postman' as const, collection: staleCollection };
    const stalePreviewResponse = await harness.request
      .post(`/api/admin/projects/${project.id}/import/preview`)
      .send({ source: staleSource })
      .expect(200);
    const stalePreview = stalePreviewResponse.body as ImportPreview;
    expect(stalePreview.items).toHaveLength(2);
    const stalePreviewItems = staleBodies.map((body, index) => {
      const matcher = {
        method: 'GET',
        path: `/candidate-${index + 1}`,
      };
      const item = stalePreview.items.find(candidate => (
        candidate.baseUrl === 'https://stale.example.test'
        && candidate.matcher.method === matcher.method
        && candidate.matcher.path === matcher.path
      ));
      expect(item).toMatchObject({
        baseUrl: 'https://stale.example.test',
        matcher,
        proposedAction: 'create',
        allowedActions: ['create', 'skip'],
        selectedByDefault: true,
        createEffect: { createsEndpoint: true, createsVariants: 1 },
      });
      expect(item!.exactTargets).toEqual([]);
      expect(item!.overlaps).toEqual([]);
      expect(item!.overlaps.some(overlap => overlap.confirmationRequired)).toBe(false);
      expect(item!.responses).toHaveLength(1);
      expect(item!.responses[0].body).toEqual({
        kind: 'sha256',
        sha256: createHash('sha256').update(body).digest('hex'),
        byteCount: body.length,
      });
      return item!;
    });
    const staleSelectedItems = stalePreviewItems.filter(item => item.selectedByDefault);
    expect(staleSelectedItems).toEqual(stalePreviewItems);
    const staleSelectedItemIds = staleSelectedItems.map(item => item.id);
    const staleActions = staleSelectedItems.map(item => ({
      itemId: item.id,
      action: item.proposedAction,
      ...(item.overlaps.some(overlap => overlap.confirmationRequired)
        ? { confirmOverlap: true }
        : {}),
    }));
    expect(staleActions).toEqual(stalePreviewItems.map(item => ({
      itemId: item.id,
      action: 'create',
    })));
    const candidateBodyHashes = stalePreviewItems.map(item => {
      const [response] = item.responses;
      expect(response.body.kind).toBe('sha256');
      if (response.body.kind !== 'sha256') throw new Error('Expected stale candidate body hash');
      return response.body.sha256;
    });
    const variantMutationResponse = await harness.request
      .put(`/api/admin/projects/${project.id}/endpoints/${accountEndpoint.id}/variants/${accountVariant.id}`)
      .send({ expectedRevision: accountVariant.revision, patch: { status: 208 } })
      .expect(200);
    expect((variantMutationResponse.body as ResponseVariant).revision).toBe(accountVariant.revision + 1);

    const beforeStaleCommit = await canonicalSnapshot(harness, project.id);
    for (const candidateBodyHash of candidateBodyHashes) {
      expect(Object.keys(beforeStaleCommit.bodyFiles).some(file => file.includes(candidateBodyHash))).toBe(false);
    }
    const staleCommitResponse = await harness.request
      .post(`/api/admin/projects/${project.id}/import/commit`)
      .send({
        source: staleSource,
        snapshotToken: stalePreview.snapshotToken,
        selectedItemIds: staleSelectedItemIds,
        actions: staleActions,
      });
    expect(staleCommitResponse.status).toBe(409);
    expect(staleCommitResponse.body).toMatchObject({ code: 'IMPORT_PREVIEW_STALE' });
    const afterStaleCommit = await canonicalSnapshot(harness, project.id);
    expect(afterStaleCommit).toEqual(beforeStaleCommit);
    for (const candidateBodyHash of candidateBodyHashes) {
      expect(Object.keys(afterStaleCommit.bodyFiles).some(file => file.includes(candidateBodyHash))).toBe(false);
    }
  } finally {
    await harness.dispose();
  }
});
