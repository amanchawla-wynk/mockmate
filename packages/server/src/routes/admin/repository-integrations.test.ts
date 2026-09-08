import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';

import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../app';
import type { ImportPreview, ImportResponseSummary } from '../../import/contracts';
import type { ProjectRepository } from '../../repository/project-repository';
import {
  createProcessTrafficContext,
  createRuntime,
  type RuntimeContext,
} from '../../runtime/create-runtime';
import { HttpError } from '../../services/api-errors';
import { createSetupRouter } from '../setup';

let root: string;
let repository: ProjectRepository;
let projectId: string;
let runtime: RuntimeContext;
const curlFixture = "curl 'https://api.example.test/imported'";
const sensitiveQueryFamilies = [
  { family: 'credential', name: 'clientCredentialId' },
  { family: 'session', name: 'userSessionId' },
  { family: 'auth', name: 'authContext' },
] as const;
const postmanFixture = {
  info: { name: 'Imported collection', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
  item: [{
    name: 'Imported endpoint',
    request: { method: 'GET', url: 'https://api.example.test/postman-imported' },
    response: [{ name: 'OK', code: 200, header: [{ key: 'Content-Type', value: 'application/json' }], body: '{}' }],
  }],
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

beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mockmate-integrations-'));
  runtime = await createRuntime({
    rootDirectory: root,
    processTraffic: createProcessTrafficContext(),
    isAdminRequestLocal: () => true,
  });
  repository = runtime.repository;
  const project = await repository.createProject({ name: 'Canonical' });
  projectId = project.id;
  const settings = repository.getRuntimeSettings(projectId);
  await repository.updateRuntimeSettings(projectId, {
    expectedRevision: settings.revision,
    interceptHosts: ['api.example.test', 'upstream.example.test'],
    captureRawTraffic: true,
    debugProvenanceHeaders: false,
  });
  await repository.setActiveProject(projectId, repository.getWorkspaceState().revision);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await runtime.dispose();
  await fs.promises.rm(root, { recursive: true, force: true });
});

function appFor(value: ProjectRepository = repository) {
  const getPorts = () => ({ http: 3000, https: 3443, proxy: 8080 });
  return createApp({
    runtime: { ...runtime, repository: value },
    setupRouter: createSetupRouter({
      certificateDirectory: path.join(root, 'certificates'),
      getPorts,
    }),
    getPorts,
  });
}

describe('repository-only production integrations', () => {
  it('resolves direct traffic only through the active canonical Project', async () => {
    const body = await repository.putBody(
      projectId,
      Readable.from(Buffer.from('allowed')),
      { mediaType: 'text/plain' },
      { maxBytes: 1024 },
    );
    await repository.createEndpoint(projectId, {
      name: 'Playback',
      baseUrl: 'http://api.example.test',
      matcher: { method: 'GET', path: '/playback' },
      mode: 'mock',
      variants: [{
        name: 'Allowed', status: 200,
        responseHeaders: {
          'content-type': 'text/plain',
          'set-cookie': ['session=one; Path=/', 'theme=dark; Path=/'],
        },
        bodyAssetId: body.id,
      }],
      defaultVariantIndex: 0,
    });

    const app = appFor();
    const response = await request(app)
      .get('/playback?apiToken=direct-log-secret')
      .set('Host', 'api.example.test');
    expect(response.status).toBe(200);
    expect(response.text).toBe('allowed');
    expect(response.headers['set-cookie']).toEqual([
      'session=one; Path=/',
      'theme=dark; Path=/',
    ]);
    await vi.waitFor(() => expect(runtime.traffic.list(projectId).entries.length).toBeGreaterThan(0));
    const entries = runtime.traffic.list(projectId).entries;
    expect(runtime.traffic.get(projectId, entries[0]!.id)?.request.query).toEqual([
      { name: 'apiToken', value: '[REDACTED]' },
    ]);

    await repository.setActiveProject(null, repository.getWorkspaceState().revision);
    const inactive = await request(app).get('/playback').set('Host', 'api.example.test');
    expect(inactive.status).toBe(503);
    expect(inactive.body).toMatchObject({ code: 'NO_ACTIVE_PROJECT', requestId: expect.any(String) });
  });

  it.each(sensitiveQueryFamilies)(
    'redacts $family query family from direct traffic log evidence',
    async ({ family, name }) => {
      const exactValue = `${family}-direct-exact`;
      const pathName = `/direct-${family}`;
      await repository.createEndpoint(projectId, {
        name: `Direct ${family}`,
        baseUrl: 'http://api.example.test',
        matcher: { method: 'GET', path: pathName },
        mode: 'mock',
        variants: [{ name: 'Matched', status: 204, responseHeaders: {} }],
        defaultVariantIndex: 0,
      });

      await request(appFor())
        .get(`${pathName}?${name}=${exactValue}`)
        .set('Host', 'api.example.test')
        .expect(204);

      await vi.waitFor(() => expect(runtime.traffic.list(projectId).entries.length).toBeGreaterThan(0));
      const entries = runtime.traffic.list(projectId).entries;
      const entry = runtime.traffic.get(projectId, entries[0]!.id);
      expect(entry?.request.query).toEqual([{ name, value: '[REDACTED]' }]);
      expect(JSON.stringify(entry)).not.toContain(exactValue);
    },
  );

  it('does not perform upstream I/O for a direct passthrough Endpoint', async () => {
    await repository.createEndpoint(projectId, {
      name: 'Upstream passthrough',
      baseUrl: 'https://upstream.example.test',
      matcher: { method: 'GET', path: '/passthrough' },
      mode: 'passthrough',
    });
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('forwarded', {
      headers: [
        ['Content-Type', 'text/plain'],
        ['Set-Cookie', 'session=one; Path=/'],
        ['Set-Cookie', 'theme=dark; Path=/'],
      ],
    }));

    const response = await request(appFor())
      .get('/passthrough')
      .set('Host', 'upstream.example.test');

    expect(response.status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });


  it.each([
    ['nonnumeric limit', '?limit=abc'],
    ['zero limit', '?limit=0'],
    ['oversized limit', '?limit=1001'],
    ['dual cursors', '?afterId=log_1&beforeId=log_2'],
  ])('rejects invalid traffic pagination: %s', async (_name, query) => {
    const app = appFor();
    const response = await request(app)
      .get(`/api/admin/projects/${projectId}/traffic${query}`)
      .set('X-Request-Id', 'traffic-pagination-request');

    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      requestId: 'traffic-pagination-request',
    });
  });

  it.each([
    ['cURL', { type: 'curl' as const, text: curlFixture }],
    ['Postman', { type: 'postman' as const, collection: postmanFixture }],
  ])('writes %s route commits through ProjectRepository', async (_name, source) => {
    const app = appFor();
    const preview = await request(app)
      .post(`/api/admin/projects/${projectId}/import/preview`)
      .send({ source })
      .expect(200);
    await request(app)
      .post(`/api/admin/projects/${projectId}/import/commit`)
      .send({
        source,
        snapshotToken: preview.body.snapshotToken,
        selectedItemIds: [preview.body.items[0].id],
        actions: [{ itemId: preview.body.items[0].id, action: 'create' }],
      })
      .expect(201);

    expect(repository.listEndpoints(projectId)).toHaveLength(1);
    expect(repository.listEndpoints(projectId)[0].path).toMatch(/imported$/);
  });

  it('keeps sensitive query values private while committing exact canonical constraints', async () => {
    const existing = await repository.createEndpoint(projectId, {
      name: 'Existing overlap',
      baseUrl: 'https://api.example.test',
      matcher: {
        method: 'GET',
        path: '/private-query',
        query: { apiToken: [{ operator: 'equals', value: 'existing-overlap-secret' }] },
      },
      mode: 'mock',
      variants: [{ name: 'Existing', status: 200, responseHeaders: {} }],
      defaultVariantIndex: 0,
    });
    const source = {
      type: 'curl' as const,
      text: "curl 'https://api.example.test/private-query?apiToken=route-secret-omega&apiToken=route-secret-alpha'",
    };
    const app = appFor();

    const previewResponse = await request(app)
      .post(`/api/admin/projects/${projectId}/import/preview`)
      .send({ source })
      .expect(200);
    const serializedPreview = JSON.stringify(previewResponse.body);

    for (const secret of [
      'route-secret-alpha',
      'route-secret-omega',
      'existing-overlap-secret',
    ]) {
      expect(serializedPreview).not.toContain(secret);
    }
    expect(previewResponse.body.items[0].requests[0].query).toEqual([
      { name: 'apiToken', value: '[REDACTED]' },
      { name: 'apiToken', value: '[REDACTED]' },
    ]);
    expect(previewResponse.body.items[0].matcher.query.apiToken).toEqual([
      { operator: 'equals', value: '[REDACTED]' },
      { operator: 'equals', value: '[REDACTED]' },
    ]);
    expect(previewResponse.body.items[0].overlaps).toEqual([
      expect.objectContaining({
        endpointId: existing.id,
        matcher: expect.objectContaining({
          query: { apiToken: [{ operator: 'equals', value: '[REDACTED]' }] },
        }),
      }),
    ]);

    const item = previewResponse.body.items[0];
    await request(app)
      .post(`/api/admin/projects/${projectId}/import/commit`)
      .send({
        source,
        snapshotToken: previewResponse.body.snapshotToken,
        selectedItemIds: [item.id],
        actions: [{ itemId: item.id, action: 'create' }],
      })
      .expect(201);

    const imported = repository.listEndpoints(projectId)
      .map(endpoint => repository.getEndpoint(projectId, endpoint.id))
      .find(endpoint => endpoint.id !== existing.id)!;
    expect(imported.matcher.query).toEqual({
      apiToken: [
        { operator: 'equals', value: 'route-secret-alpha' },
        { operator: 'equals', value: 'route-secret-omega' },
      ],
    });
  });

  it.each(sensitiveQueryFamilies)(
    'redacts $family query family from serialized Import item and overlap JSON before exact commit',
    async ({ family, name }) => {
      const sourceValue = `${family}-route-exact`;
      const secondSourceValue = `${family}-route-exact-second`;
      const overlapValue = `${family}-overlap-exact`;
      const existing = await repository.createEndpoint(projectId, {
        name: `Existing ${family} overlap`,
        baseUrl: 'https://api.example.test',
        matcher: {
          method: 'GET',
          path: `/private-${family}`,
          query: { [name]: [{ operator: 'equals', value: overlapValue }] },
        },
        mode: 'mock',
        variants: [{ name: 'Existing', status: 200, responseHeaders: {} }],
        defaultVariantIndex: 0,
      });
      const source = {
        type: 'curl' as const,
        text: `curl 'https://api.example.test/private-${family}?${name}=${sourceValue}&${name}=${secondSourceValue}'`,
      };
      const app = appFor();

      const previewResponse = await request(app)
        .post(`/api/admin/projects/${projectId}/import/preview`)
        .send({ source })
        .expect(200);
      const serializedPreview = JSON.stringify(previewResponse.body);

      expect(serializedPreview).not.toContain(sourceValue);
      expect(serializedPreview).not.toContain(secondSourceValue);
      expect(serializedPreview).not.toContain(overlapValue);
      expect(previewResponse.body.items[0].requests[0].query).toEqual([
        { name, value: '[REDACTED]' },
        { name, value: '[REDACTED]' },
      ]);
      expect(previewResponse.body.items[0].matcher.query[name]).toEqual([
        { operator: 'equals', value: '[REDACTED]' },
        { operator: 'equals', value: '[REDACTED]' },
      ]);
      expect(previewResponse.body.items[0].overlaps).toEqual([
        expect.objectContaining({
          endpointId: existing.id,
          matcher: expect.objectContaining({
            query: { [name]: [{ operator: 'equals', value: '[REDACTED]' }] },
          }),
        }),
      ]);

      const item = previewResponse.body.items[0];
      await request(app)
        .post(`/api/admin/projects/${projectId}/import/commit`)
        .send({
          source,
          snapshotToken: previewResponse.body.snapshotToken,
          selectedItemIds: [item.id],
          actions: [{ itemId: item.id, action: 'create' }],
        })
        .expect(201);

      const imported = repository.listEndpoints(projectId)
        .map(endpoint => repository.getEndpoint(projectId, endpoint.id))
        .find(endpoint => endpoint.id !== existing.id)!;
      expect(imported.matcher.query).toEqual({
        [name]: [
          { operator: 'equals', value: sourceValue },
          { operator: 'equals', value: secondSourceValue },
        ],
      });
    },
  );

  it('serializes an injected browser-safe preview fixture without transport reshaping', async () => {
    const previewImport = vi.fn(() => publicPreviewFixture);
    const app = appFor({ ...repository, previewImport });

    const response = await request(app)
      .post(`/api/admin/projects/${projectId}/import/preview`)
      .send({ source: { type: 'postman', collection: {} } })
      .expect(200);

    expect(response.body).toEqual(publicPreviewFixture);
    expect(response.body.items[0].responses[0].body).toEqual({
      kind: 'sha256', sha256: 'ab'.repeat(32), byteCount: 2,
    });
    expect(response.body.items[0].createEffect).toEqual({ createsEndpoint: false, createsVariants: 0 });
    expect(response.body.warnings).toEqual(publicPreviewFixture.warnings);
    expect(response.body.items[0].exactTargets.map((target: { candidateResponses: unknown[] }) => (
      target.candidateResponses
    ))).toEqual([[hashedResponse], [bodylessResponse]]);
    expect(response.body.items[0].responses[0].body).not.toHaveProperty('value');
  });

  it('serializes a real repository preview without private plan fields', async () => {
    const endpoint = await repository.createEndpoint(projectId, {
      name: 'Existing users',
      baseUrl: 'https://api.example.test',
      matcher: { method: 'POST', path: '/users' },
      mode: 'mock',
      variants: [{ name: 'Existing', status: 200, responseHeaders: {} }],
      defaultVariantIndex: 0,
    });
    const previewImport = vi.spyOn(repository, 'previewImport');
    const app = appFor();
    const savedResponseBody = '{}';
    const savedResponseSha256 = createHash('sha256').update(savedResponseBody).digest('hex');

    const response = await request(app)
      .post(`/api/admin/projects/${projectId}/import/preview`)
      .send({
        source: {
          type: 'postman',
          collection: {
            info: {
              name: 'Real preview fixture',
              schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
            },
            event: [{ listen: 'test', script: { exec: ['ignored-source-script'] } }],
            item: [{
              name: 'Create user',
              request: { method: 'POST', url: 'https://api.example.test/users' },
              response: [{
                name: 'Created',
                code: 201,
                header: [{ key: 'Content-Type', value: 'application/json' }],
                body: savedResponseBody,
              }],
            }],
          },
        },
      })
      .expect(200);

    expect(previewImport).toHaveBeenCalledOnce();
    expect(response.body.warnings).toEqual([{
      code: 'IMPORT_SCRIPT_IGNORED',
      message: 'Postman collection scripts are ignored during import',
    }]);
    expect(response.body.items).toHaveLength(1);
    const item = response.body.items[0];
    expect(item.createEffect).toEqual({ createsEndpoint: false, createsVariants: 0 });
    expect(item.responses).toHaveLength(1);
    expect(item.responses[0].body).toEqual({
      kind: 'sha256',
      sha256: savedResponseSha256,
      byteCount: Buffer.byteLength(savedResponseBody),
    });
    expect(item.exactTargets).toHaveLength(1);
    expect(item.exactTargets[0]).toMatchObject({
      endpointId: endpoint.id,
      endpointRevision: endpoint.revision,
      name: endpoint.name,
      newVariantCount: 1,
    });
    expect(item.exactTargets[0].candidateResponses).toEqual(item.responses);
    expect(item).not.toHaveProperty('createResponses');
    expect(item).not.toHaveProperty('mergeResponsesByEndpointId');
    expect(JSON.stringify(response.body)).not.toMatch(/createResponses|mergeResponsesByEndpointId/);
  });

  it('rejects multibyte import parts by UTF-8 bytes before repository calls', async () => {
    const previewImport = vi.spyOn(repository, 'previewImport');
    const commitImport = vi.spyOn(repository, 'commitImport');
    const app = appFor();
    const multibyteCharacter = 'é';
    const multibyteCharacterBytes = Buffer.byteLength(multibyteCharacter);
    const sourceLimit = 10 * 1024 * 1024;
    const sourceEnvelope = { type: 'curl' as const, text: '' };
    const sourceOverhead = Buffer.byteLength(JSON.stringify(sourceEnvelope));
    const sourceText = multibyteCharacter.repeat(
      Math.floor((sourceLimit - sourceOverhead) / multibyteCharacterBytes) + 1,
    );
    const oversizedSource = { ...sourceEnvelope, text: sourceText };
    const serializedSource = JSON.stringify(oversizedSource);

    expect(serializedSource.length).toBeLessThanOrEqual(sourceLimit);
    expect(Buffer.byteLength(serializedSource)).toBeGreaterThan(sourceLimit);
    const sourceResponse = await request(app)
      .post(`/api/admin/projects/${projectId}/import/preview`)
      .send({ source: oversizedSource });
    expect(sourceResponse).toMatchObject({
      status: 422,
      body: { code: 'IMPORT_LIMIT_EXCEEDED' },
    });
    expect(previewImport).not.toHaveBeenCalled();

    const commitFieldsLimit = 1024 * 1024;
    const commitFieldsEnvelope = {
      variables: { padding: '' },
      snapshotToken: 'snapshot-token',
      selectedItemIds: [],
      actions: [],
    };
    const commitFieldsOverhead = Buffer.byteLength(JSON.stringify(commitFieldsEnvelope));
    const commitPadding = multibyteCharacter.repeat(
      Math.floor((commitFieldsLimit - commitFieldsOverhead) / multibyteCharacterBytes) + 1,
    );
    const oversizedCommitFields = {
      ...commitFieldsEnvelope,
      variables: { padding: commitPadding },
    };
    const serializedCommitFields = JSON.stringify(oversizedCommitFields);

    expect(serializedCommitFields.length).toBeLessThanOrEqual(commitFieldsLimit);
    expect(Buffer.byteLength(serializedCommitFields)).toBeGreaterThan(commitFieldsLimit);
    const commitResponse = await request(app)
      .post(`/api/admin/projects/${projectId}/import/commit`)
      .send({
        source: { type: 'curl', text: curlFixture },
        ...oversizedCommitFields,
      });
    expect(commitResponse).toMatchObject({
      status: 422,
      body: { code: 'IMPORT_LIMIT_EXCEEDED' },
    });
    expect(commitImport).not.toHaveBeenCalled();
  });

  it.each([
    [422, 'IMPORT_SOURCE_INVALID'],
    [422, 'IMPORT_VARIABLES_REQUIRED'],
    [422, 'IMPORT_SELECTION_INVALID'],
    [422, 'IMPORT_NO_CHANGES'],
    [422, 'IMPORT_LIMIT_EXCEEDED'],
    [409, 'IMPORT_PREVIEW_STALE'],
    [409, 'ID_COLLISION'],
    [409, 'ASSET_METADATA_CONFLICT'],
  ])('preserves request IDs for documented import error %s %s', async (status, code) => {
    const requestId = `request-${code.toLowerCase()}`;
    const app = appFor({
      ...repository,
      commitImport: vi.fn(async () => {
        throw new HttpError(status, code, `Public ${code} message`);
      }),
    });

    const response = await request(app)
      .post(`/api/admin/projects/${projectId}/import/commit`)
      .set('X-Request-Id', requestId)
      .send({
        source: { type: 'curl', text: curlFixture },
        snapshotToken: 'snapshot-token',
        selectedItemIds: ['item-users'],
        actions: [{ itemId: 'item-users', action: 'skip' }],
      });

    expect(response.status).toBe(status);
    expect(response.headers['x-request-id']).toBe(requestId);
    expect(response.body).toEqual({
      code,
      message: `Public ${code} message`,
      requestId,
    });
  });

  it('switches automation by stable App State ID', async () => {
    const state = await repository.createState(projectId, {
      name: 'Paid', tags: [], bindings: {},
    });
    const app = appFor();
    await request(app).put('/setMockServerflags').send({ projectId, stateId: state.id }).expect(204);
    expect(repository.getProject(projectId).activeStateId).toBe(state.id);
  });

  it('serves canonical static bytes through repository paths', async () => {
    await repository.putStaticFile(
      projectId,
      'posters/home.bin',
      Readable.from(Buffer.from([0, 255, 1, 254])),
      { mediaType: 'application/octet-stream', maxBytes: 1024 },
    );
    const app = appFor();
    const response = await request(app)
      .get('/static_files/posters/home.bin')
      .buffer(true)
      .parse((source, callback) => {
        const chunks: Buffer[] = [];
        source.on('data', chunk => chunks.push(Buffer.from(chunk)));
        source.on('end', () => callback(null, Buffer.concat(chunks)));
      });
    expect(Buffer.from(response.body)).toEqual(Buffer.from([0, 255, 1, 254]));
  });

  it('keeps production server sources on the canonical cutover boundary', async () => {
    const sourceRoot = path.resolve(__dirname, '../..');
    const visit = async (directory: string): Promise<string[]> => {
      const entries = await fs.promises.readdir(directory, { withFileTypes: true });
      const nested = await Promise.all(entries.map(async entry => {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) return entry.name === 'test-support' ? [] : visit(absolute);
        return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [absolute] : [];
      }));
      return nested.flat();
    };
    const sourceFiles = await visit(sourceRoot);
    const sourcesByFile = await Promise.all(sourceFiles.map(async file => ({
      file,
      source: await fs.promises.readFile(file, 'utf8'),
    })));
    const sources = sourcesByFile.map(({ source }) => source).join('\n');
    const bodyStoreSuffix = path.join('repository', 'body-store.ts');
    const projectRepositorySuffix = path.join('repository', 'project-repository.ts');
    const bodyStore = sourcesByFile.find(({ file }) => file.endsWith(bodyStoreSuffix));
    const projectRepository = sourcesByFile.find(({ file }) => file.endsWith(projectRepositorySuffix));
    const sourcesOutsideImportTransactions = sourcesByFile
      .filter(({ file }) => (
        !file.endsWith(bodyStoreSuffix) && !file.endsWith(projectRepositorySuffix)
      ))
      .map(({ source }) => source)
      .join('\n');

    expect(sources).not.toMatch(/services\/(?:projects|resources|matcher|fixtures)|scenario-ids/);
    expect(sources).not.toMatch(/coreMode|PendingMigrationCutover/);
    expect(sources).not.toMatch(/migration|backup|compatib/i);
    expect(sourcesOutsideImportTransactions).not.toMatch(/rollback/i);
    expect(bodyStore?.source.match(/\brollback\b/gi)).toHaveLength(2);
    expect(bodyStore?.source).toMatch(/rollback\(\): Promise<void>/);
    expect(bodyStore?.source).toMatch(/async rollback\(\): Promise<void>/);
    expect(projectRepository?.source.match(/\brollback\b/gi)).toHaveLength(3);
    expect(projectRepository?.source.match(/bodyTransaction\.rollback\(\)/g)).toHaveLength(3);
  });
});
