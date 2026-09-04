import { createHash } from 'node:crypto';
import fsDefault from 'node:fs';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BodyAsset, EndpointDetail } from '../domain/model';
import type {
  TrafficPromotionInput,
  TrafficRowLeaseSnapshot,
} from '../domain/traffic';
import type { TrafficBodyLease } from '../services/traffic-body-cache';
import { normalizeHttpOrigin } from '../domain/http-origin';
import { parseRawQuery } from '../domain/query-matcher';
import type { ImportCommitRequest, ImportPreviewRequest } from '../import/contracts';
import {
  endpointRecord,
  ProjectBuilder,
  projectRecord,
  settingsRecord,
  stateRecord,
} from '../test-support/project-builder';
import { createAtomicFileWriter, type AtomicFileWriter } from './atomic-write';
import {
  createBodyStore,
  type BodyImportTransaction,
  type BodyStore,
} from './body-store';
import { compileProject, type MatchRequest } from './compile-project';
import { nodeFileSystem, type FileSystem } from './file-system';
import {
  createProjectRepository,
  type ProjectRepository,
  type ProjectRepositoryOptions,
} from './project-repository';
import type { ValidatedProjectSnapshot } from './snapshot';
import {
  promotionResponseIdentity,
  type PublicationOperation,
} from './traffic-promotion';

let root: string;
let builder: ProjectBuilder;
let repository: ProjectRepository;
let compile: ReturnType<typeof vi.fn<NonNullable<ProjectRepositoryOptions['beforeCompile']>>>;

async function consume(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function staticTransactionEntries(): Promise<string[]> {
  try {
    return await fs.promises.readdir(path.join(
      builder.projectDirectory(), 'static', '.mockmate-static-transactions',
    ));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

const STATIC_TRANSACTION_POINTER = '.mockmate-static-transaction.json';

interface TestStaticTransaction {
  schemaVersion: 4;
  transactionId: string;
  operation: 'put' | 'delete';
  path: string;
  before: { schemaVersion: 4; files: Array<{ path: string; size: number; mediaType: string }> };
  after: { schemaVersion: 4; files: Array<{ path: string; size: number; mediaType: string }> };
}

function transactionPointer(
  journal: TestStaticTransaction,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 4,
    transactionId: journal.transactionId,
    operation: journal.operation,
    path: journal.path,
    journalSha256: createHash('sha256').update(JSON.stringify(journal)).digest('hex'),
    ...overrides,
  };
}

async function writeStaticTransactionState(
  state: 'preparing' | 'pending' | 'committed' | 'restored',
  journal: TestStaticTransaction,
): Promise<string> {
  const directory = path.join(
    builder.projectDirectory(),
    'static',
    '.mockmate-static-transactions',
    `${state}-${journal.transactionId}`,
  );
  await fs.promises.mkdir(directory, { recursive: true });
  await fs.promises.writeFile(path.join(directory, 'transaction.json'), JSON.stringify(journal));
  return directory;
}

async function writeTransactionPointer(value: unknown): Promise<void> {
  await fs.promises.writeFile(
    path.join(builder.projectDirectory(), 'static', STATIC_TRANSACTION_POINTER),
    JSON.stringify(value),
  );
}

async function hasTransactionPointer(): Promise<boolean> {
  try {
    await fs.promises.lstat(path.join(builder.projectDirectory(), 'static', STATIC_TRANSACTION_POINTER));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function retainPendingNestedReplacement(): Promise<{
  staticRoot: string;
  pendingDirectory: string;
}> {
  const realWriter = createAtomicFileWriter(nodeFileSystem);
  let failManifest = false;
  await initialize({
    atomicWriter: {
      ...realWriter,
      async writeJson(destination, value) {
        if (failManifest && destination.endsWith(`${path.sep}.mockmate-static.json`)) {
          throw new Error('manifest publication failed');
        }
        return realWriter.writeJson(destination, value);
      },
    },
  });
  await repository.putStaticFile('prj_1', 'link/victim.bin', Readable.from('old'), {
    mediaType: 'application/prior', maxBytes: 3,
  });
  failManifest = true;
  const destination = path.join(builder.projectDirectory(), 'static', 'link', 'victim.bin');
  const realRename = fs.promises.rename.bind(fs.promises);
  const rename = vi.spyOn(fs.promises, 'rename').mockImplementation((source, target) => {
    if (source.toString().endsWith(`${path.sep}previous`) && target.toString() === destination) {
      return Promise.reject(Object.assign(new Error('restore denied'), { code: 'EACCES' }));
    }
    return realRename(source, target);
  });
  await expect(repository.putStaticFile('prj_1', 'link/victim.bin', Readable.from('new'), {
    mediaType: 'application/new', maxBytes: 3,
  })).rejects.toMatchObject({ status: 500, code: 'STATIC_TRANSACTION_INCOMPLETE' });
  rename.mockRestore();
  const staticRoot = path.join(builder.projectDirectory(), 'static');
  const pendingName = (await staticTransactionEntries()).find(entry => entry.startsWith('pending-'));
  if (!pendingName) throw new Error('Expected retained pending transaction');
  return {
    staticRoot,
    pendingDirectory: path.join(staticRoot, '.mockmate-static-transactions', pendingName),
  };
}

async function storageState(directory = root): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const visit = async (current: string): Promise<void> => {
    const entries = await fs.promises.readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(directory, absolute).split(path.sep).join('/');
      if (entry.isDirectory()) {
        result[`${relative}/`] = 'directory';
        await visit(absolute);
      } else {
        result[relative] = (await fs.promises.readFile(absolute)).toString('base64');
      }
    }
  };
  await visit(directory);
  return result;
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>(settle => { resolve = settle; });
  return { promise, resolve };
}

function variant(id: string) {
  return {
    id,
    endpointId: 'ep_1',
    name: id,
    status: 200,
    responseHeaders: {},
    revision: 1,
  };
}

function request(overrides: Partial<MatchRequest> = {}): MatchRequest {
  return {
    origin: normalizeHttpOrigin('https://api.example.test'),
    method: 'GET',
    path: '/profile',
    query: parseRawQuery(''),
    headers: {},
    ...overrides,
  };
}

function options(overrides: {
  atomicWriter?: AtomicFileWriter;
  bodyStore?: BodyStore;
  beforeCompile?: NonNullable<ProjectRepositoryOptions['beforeCompile']>;
  idSource?: () => string;
  importTokenKey?: Buffer;
  importVariableDigestKey?: Buffer;
  fileSystem?: FileSystem;
  publicationFailpoints?: ProjectRepositoryOptions['publicationFailpoints'];
} = {}) {
  const atomicWriter = overrides.atomicWriter ?? createAtomicFileWriter(nodeFileSystem);
  return {
    rootDirectory: root,
    atomicWriter,
    bodyStore: overrides.bodyStore ?? createBodyStore({
      rootDirectory: root,
      atomicWriter,
      fileSystem: nodeFileSystem,
    }),
    beforeCompile: overrides.beforeCompile ?? compile,
    ...(overrides.idSource === undefined ? {} : { idSource: overrides.idSource }),
    ...(overrides.importTokenKey === undefined ? {} : { importTokenKey: overrides.importTokenKey }),
    ...(overrides.importVariableDigestKey === undefined
      ? {}
      : { importVariableDigestKey: overrides.importVariableDigestKey }),
    ...(overrides.fileSystem === undefined ? {} : { fileSystem: overrides.fileSystem }),
    ...(overrides.publicationFailpoints === undefined
      ? {}
      : { publicationFailpoints: overrides.publicationFailpoints }),
  };
}

async function initialize(
  overrides: Parameters<typeof options>[0] = {},
): Promise<ProjectRepository & { diagnostics: ReturnType<ProjectRepository['listAllDiagnostics']> }> {
  repository = createProjectRepository(options(overrides));
  const result = await repository.initialize();
  return Object.assign(repository, result);
}

const POSTMAN_V21_SCHEMA = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';

function importCollection(items: unknown[], variables?: Array<{ key: string; value: string }>) {
  return {
    info: { name: 'Repository import', schema: POSTMAN_V21_SCHEMA },
    item: items,
    ...(variables === undefined ? {} : { variable: variables }),
  };
}

function importItem(
  name: string,
  url: string,
  responses: unknown[] = [],
  method = 'GET',
) {
  return {
    name,
    request: { method, url },
    response: responses,
  };
}

function savedResponse(
  name: string,
  code: number,
  body?: string,
  header: Array<{ key: string; value: string }> = [],
) {
  return {
    name,
    code,
    header,
    ...(body === undefined ? {} : { body }),
  };
}

function commitRequest(
  preview: ReturnType<ProjectRepository['previewImport']>,
  input: ImportPreviewRequest,
  actions = preview.items.filter(item => item.selectedByDefault).map(item => ({
    itemId: item.id,
    action: item.proposedAction,
    ...(item.proposedAction === 'merge' ? { endpointId: item.exactTargets[0].endpointId } : {}),
    ...(item.proposedAction === 'create' && item.overlaps.some(overlap => overlap.confirmationRequired)
      ? { confirmOverlap: true }
      : {}),
  })),
): ImportCommitRequest {
  return {
    ...input,
    snapshotToken: preview.snapshotToken,
    selectedItemIds: actions.map(action => action.itemId),
    actions: actions as ImportCommitRequest['actions'],
  };
}

function trafficPromotionFixture(pathname = '/promoted') {
  const bytes = Buffer.from(`promoted response for ${pathname}`);
  const body: BodyAsset = {
    schemaVersion: 4,
    id: createHash('sha256').update(bytes).digest('hex'),
    mediaType: 'text/plain',
    size: bytes.length,
    createdAt: '2026-09-02T00:00:00.000Z',
  };
  const headers: Array<[string, string]> = [['content-type', 'text/plain']];
  const accepted: TrafficRowLeaseSnapshot['accepted'] = {
    projectId: 'prj_1',
    trafficId: `trf_${pathname.slice(1)}`,
    generation: `tg_${pathname.slice(1)}`,
    capturedAt: '2026-09-02T00:00:00.000Z',
    acceptedAt: '2026-09-02T00:00:01.000Z',
    request: {
      origin: 'https://api.example.test', method: 'POST', path: pathname, query: [],
    },
    response: {
      identity: promotionResponseIdentity(202, headers, body),
      status: 202,
      headers,
      contentEncoding: { ok: true },
      body: {
        state: 'available', observedSize: bytes.length, retainedSize: bytes.length,
        sha256: body.id, mediaType: body.mediaType,
      },
    },
  };
  const snapshot: TrafficRowLeaseSnapshot = {
    projectId: 'prj_1',
    trafficId: accepted.trafficId,
    generation: accepted.generation,
    detail: {} as TrafficRowLeaseSnapshot['detail'],
    accepted,
  };
  const lease: TrafficBodyLease = {
    projectId: 'prj_1', sha256: body.id, byteCount: body.size,
    openStream: () => Readable.from([bytes.subarray(0, 4), bytes.subarray(4)]),
    async release() {},
  };
  const command: TrafficPromotionInput = {
    expectedTrafficGeneration: accepted.generation,
    expectedResponseIdentity: accepted.response.identity,
    endpoint: { action: 'create' },
    state: { action: 'unbound' },
  };
  return { body, snapshot, lease, command };
}

beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mockmate-repository-'));
  builder = new ProjectBuilder(root);
  compile = vi.fn<NonNullable<ProjectRepositoryOptions['beforeCompile']>>();
  await builder.writeValid();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.promises.rm(root, { recursive: true, force: true });
});

describe('Project repository loading', () => {
  it('does not expose the removed captured-mock publisher', async () => {
    await initialize();

    expect(repository).not.toHaveProperty('createCapturedMock');
  });

  it('replays canonical Traffic receipts across response edits and restart', async () => {
    const command: TrafficPromotionInput = {
      expectedTrafficGeneration: 'tg_1',
      expectedResponseIdentity: 'resp_1',
      endpoint: { action: 'reuse', endpointId: 'ep_1', expectedRevision: 1 },
      state: { action: 'bind', stateId: 'state_1', expectedRevision: 1 },
    };
    await builder.writeValid({ endpoints: [endpointRecord({
      variants: [{
        id: 'var_1',
        endpointId: 'ep_1',
        name: 'Captured',
        status: 200,
        responseHeaders: {},
        trafficProvenance: [{
          type: 'traffic',
          trafficId: 'trf_1',
          trafficGeneration: 'tg_1',
          capturedAt: '2026-09-02T00:00:00.000Z',
          requestOrigin: 'https://api.example.test',
          responseIdentity: 'resp_1',
          endpointTarget: 'reuse',
          endpointId: 'ep_1',
          endpointCreated: false,
          variantId: 'var_1',
          variantCreated: true,
          endpointModeChanged: false,
          stateTarget: 'bound',
          stateId: 'state_1',
          bindingChanged: true,
        }],
        revision: 0,
      }],
    })] });
    await initialize();

    const expected = {
      state: 'exact',
      result: expect.objectContaining({ endpointId: 'ep_1', variantId: 'var_1' }),
    };
    await expect(repository.lookupTrafficPromotionReceipt('prj_1', 'trf_1', command))
      .resolves.toEqual(expected);
    await repository.updateVariant('prj_1', 'ep_1', 'var_1', 0, { status: 201 });
    await expect(repository.lookupTrafficPromotionReceipt('prj_1', 'trf_1', command))
      .resolves.toEqual(expected);
    await repository.initialize();
    await expect(repository.lookupTrafficPromotionReceipt('prj_1', 'trf_1', {
      ...command,
      endpoint: { ...command.endpoint, expectedRevision: 99 },
      state: { ...command.state, expectedRevision: 99 },
    })).resolves.toEqual(expected);
    await expect(repository.lookupTrafficPromotionReceipt('prj_1', 'trf_1', {
      ...command,
      expectedTrafficGeneration: 'tg_other',
    })).resolves.toEqual({ state: 'conflict' });
  });

  it('loads only the generation selected by current.json', async () => {
    await builder.writeGeneration({
      generationId: 'gen_old',
      project: projectRecord({ name: 'Old' }),
    });
    await builder.writeGeneration({
      generationId: 'gen_selected',
      project: projectRecord({ name: 'Selected' }),
    });
    await builder.writePointer('gen_selected');

    await initialize();

    expect(repository.getProject('prj_1').name).toBe('Selected');
    expect(compile).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['malformed pointer JSON', '{', 'MALFORMED_JSON'],
    ['unsupported pointer schema', JSON.stringify({ schemaVersion: 2, generationId: 'gen_current' }), 'UNSUPPORTED_SCHEMA_VERSION'],
  ])('diagnoses %s without loading a partial Project', async (_name, pointer, code) => {
    await fs.promises.writeFile(path.join(builder.projectDirectory(), 'current.json'), pointer);
    const result = await initialize();
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code, projectId: 'prj_1' }));
    expect(repository.listProjects()).toEqual([]);
    expect(compile).not.toHaveBeenCalled();
  });

  it('reports invalid records and filename/ID mismatches instead of silently dropping them', async () => {
    await builder.writeEndpointRaw('ep_bad.json', endpointRecord({ id: 'different-id' }));
    const result = await initialize();
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'RECORD_ID_MISMATCH',
      file: expect.stringContaining('ep_bad.json'),
    }));
    expect(repository.listProjects()).toEqual([]);
  });

  it('reports duplicate IDs across differently named records', async () => {
    await builder.writeEndpointRaw('alias.json', endpointRecord());
    const result = await initialize();
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'DUPLICATE_RECORD_ID' }));
    expect(repository.listProjects()).toEqual([]);
  });

  it.each(['endpoints', 'states'] as const)(
    'requires the selected generation %s directory',
    async directory => {
      await fs.promises.rm(path.join(builder.generationDirectory(), directory), { recursive: true });
      const result = await initialize();
      expect(result.diagnostics).toContainEqual(expect.objectContaining({
        code: 'MISSING_RECORD_DIRECTORY',
        file: expect.stringContaining(`/generations/gen_current/${directory}`),
        projectId: 'prj_1',
      }));
      expect(repository.listProjects()).toEqual([]);
      expect(compile).not.toHaveBeenCalled();
    },
  );

  it('retains both diagnostics when both selected-generation record directories are missing', async () => {
    await Promise.all(['endpoints', 'states'].map(directory => fs.promises.rm(
      path.join(builder.generationDirectory(), directory),
      { recursive: true },
    )));
    const result = await initialize();
    expect(result.diagnostics.filter(finding => finding.code === 'MISSING_RECORD_DIRECTORY'))
      .toHaveLength(2);
    expect(repository.listProjects()).toEqual([]);
    expect(compile).not.toHaveBeenCalled();
  });

  it.each([
    ['Project', async () => {
      await fs.promises.writeFile(
        path.join(builder.generationDirectory(), 'project.json'),
        JSON.stringify(projectRecord({ id: 'prj\\unsafe' })),
      );
    }],
    ['Endpoint', async () => {
      await builder.writeEndpointRaw('unsafe.json', endpointRecord({ id: 'ep/unsafe' }));
    }],
    ['App State', async () => {
      await builder.writeStateRaw('unsafe.json', stateRecord({ id: 'state\\unsafe' }));
    }],
    ['Response Variant', async () => {
      const endpoint = endpointRecord({ defaultVariantId: 'var\\unsafe' });
      endpoint.variants[0].id = 'var\\unsafe';
      await builder.writeEndpointRaw('ep_1.json', endpoint);
    }],
  ])('diagnoses an unsafe persisted %s ID without exposing it', async (_name, writeUnsafe) => {
    await writeUnsafe();
    const result = await initialize();
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'INVALID_RECORD_ID',
      projectId: 'prj_1',
    }));
    expect(repository.listProjects()).toEqual([]);
    expect(compile).not.toHaveBeenCalled();
  });

  it('diagnoses an unsafe selected generation ID', async () => {
    await builder.writePointer('gen\\unsafe');
    const result = await initialize();
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'INVALID_GENERATION_POINTER',
      projectId: 'prj_1',
    }));
    expect(repository.listProjects()).toEqual([]);
  });

  it('retains a sanitized diagnostic for a crash-left staging directory', async () => {
    await fs.promises.mkdir(path.join(root, 'projects', '.staging-crash-left'), { recursive: true });
    const result = await initialize();
    expect(result.diagnostics).toContainEqual({
      severity: 'blocking',
      code: 'INCOMPLETE_PROJECT_STAGING',
      file: 'projects/.staging-crash-left',
      message: 'An incomplete staged Project was found.',
      recovery: 'Inspect and remove or recover the staged Project directory.',
    });
    expect(repository.listProjects()).toHaveLength(1);
  });

  it('distinguishes workspace I/O failure from malformed JSON', async () => {
    const readFile = fs.promises.readFile.bind(fs.promises);
    vi.spyOn(fs.promises, 'readFile').mockImplementation(async (filePath, options) => {
      if (filePath.toString() === path.join(root, 'workspace.json')) {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      }
      return readFile(filePath, options as never);
    });
    const result = await initialize();
    expect(result.diagnostics).toContainEqual({
      severity: 'blocking',
      code: 'WORKSPACE_IO_ERROR',
      file: 'workspace.json',
      message: 'Workspace state could not be read.',
      recovery: 'Restore readable workspace storage and retry initialization.',
    });
  });

  it('maps static scan lstat failures to a retained diagnostic', async () => {
    const staticFile = path.join(builder.projectDirectory(), 'static', 'file.bin');
    await fs.promises.mkdir(path.dirname(staticFile), { recursive: true });
    await fs.promises.writeFile(staticFile, 'value');
    const lstat = fs.promises.lstat.bind(fs.promises);
    vi.spyOn(fs.promises, 'lstat').mockImplementation(async filePath => {
      if (filePath.toString() === staticFile) {
        throw Object.assign(new Error('scan failed'), { code: 'EIO' });
      }
      return lstat(filePath);
    });
    const result = await initialize();
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'STATIC_IO_ERROR',
      file: 'projects/prj_1/static/file.bin',
      projectId: 'prj_1',
    }));
    expect(repository.listProjects()).toEqual([]);
  });

  it('maps static scan directory failures to a retained diagnostic', async () => {
    const staticRoot = path.join(builder.projectDirectory(), 'static');
    const realReaddir = fs.promises.readdir.bind(fs.promises);
    vi.spyOn(fs.promises, 'readdir').mockImplementation((filePath, options) => {
      if (filePath.toString() === staticRoot) {
        return Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' }));
      }
      return realReaddir(filePath, options as never) as never;
    });
    const result = await initialize();
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'STATIC_IO_ERROR', projectId: 'prj_1', file: 'projects/prj_1/static',
    }));
    expect(repository.listProjects()).toEqual([]);
  });

  it.each([
    ['MISSING_DEFAULT_VARIANT', endpointRecord({ defaultVariantId: 'missing' }), stateRecord()],
    ['VARIANT_ENDPOINT_MISMATCH', (() => {
      const endpoint = endpointRecord();
      endpoint.variants[0].endpointId = 'foreign';
      return endpoint;
    })(), stateRecord()],
    ['INVALID_STATE_BINDING', endpointRecord(), stateRecord({ bindings: { ep_1: 'missing' } })],
  ])('reports %s without compiling or loading a partial snapshot', async (code, endpoint, state) => {
    await builder.writeValid({ endpoints: [endpoint], states: [state] });
    const result = await initialize();
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code }));
    expect(repository.listProjects()).toEqual([]);
    expect(compile).not.toHaveBeenCalled();
  });

  it('diagnoses missing or corrupt body content even when metadata exists', async () => {
    const bytes = Buffer.from('body');
    const asset = await builder.writeBody(bytes);
    const endpoint = endpointRecord();
    endpoint.variants[0].bodyAssetId = asset.id;
    await builder.writeValid({ endpoints: [endpoint] });
    await fs.promises.writeFile(
      path.join(builder.projectDirectory(), 'bodies', 'sha256', asset.id.slice(0, 2), asset.id),
      'corrupt',
    );

    const result = await initialize();
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'MISSING_BODY_ASSET' }));
    expect(repository.listProjects()).toEqual([]);
  });

  it('retains repository-wide diagnostics when zero Projects are valid', async () => {
    await fs.promises.writeFile(path.join(builder.generationDirectory(), 'project.json'), '{');
    const result = await initialize();
    expect(repository.listProjects()).toEqual([]);
    expect(repository.listAllDiagnostics()).toEqual(result.diagnostics);
    expect(repository.listDiagnostics('prj_1')).toEqual(result.diagnostics);
  });

  it('diagnoses invalid workspace selection without manufacturing an active Project', async () => {
    await builder.writeWorkspace({ schemaVersion: 4, activeProjectId: 'missing', revision: 4 });
    const result = await initialize();
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'INVALID_WORKSPACE_SELECTION' }));
    expect(repository.getWorkspaceState()).toEqual({ schemaVersion: 4, revision: 4 });
  });

  it('reloads a complete Project and preserves the prior snapshot/compiler value on failure', async () => {
    await initialize();
    await builder.writeGeneration({ project: projectRecord({ name: 'Reloaded' }) });
    await repository.reloadProject('prj_1');
    expect(repository.getProject('prj_1').name).toBe('Reloaded');
    await fs.promises.writeFile(path.join(builder.generationDirectory(), 'project.json'), '{');
    await expect(repository.reloadProject('prj_1')).rejects.toMatchObject({
      status: 422,
      code: 'INVALID_PROJECT',
    });
    expect(repository.getProject('prj_1').name).toBe('Reloaded');
    expect(repository.listDiagnostics('prj_1')).not.toEqual([]);
  });

  it('rejects a selected generation reached through a symlink ancestor', async () => {
    const outside = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mockmate-generation-outside-'));
    try {
      await fs.promises.cp(builder.generationDirectory(), outside, { recursive: true });
      await fs.promises.rm(builder.generationDirectory(), { recursive: true });
      await fs.promises.symlink(outside, builder.generationDirectory());
      const result = await initialize();
      expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'INVALID_RECORD_FILE' }));
      expect(repository.listProjects()).toEqual([]);
      expect(compile).not.toHaveBeenCalled();
    } finally {
      await fs.promises.rm(outside, { recursive: true, force: true });
    }
  });

  it('uses the real compiler when no failure-injection seam is provided', async () => {
    const atomicWriter = createAtomicFileWriter(nodeFileSystem);
    const realRepository = createProjectRepository({
      rootDirectory: root,
      atomicWriter,
      bodyStore: createBodyStore({ rootDirectory: root, atomicWriter, fileSystem: nodeFileSystem }),
    });
    await realRepository.initialize();
    expect(realRepository.resolve('prj_1', request()))
      .toMatchObject({ kind: 'mock', endpointId: 'ep_1', resolved: { variantId: 'var_1' } });
  });

  it('always publishes the real compiled Project even when the pre-compile hook returns a forged value', async () => {
    const beforeCompile = vi.fn((snapshot: ValidatedProjectSnapshot) => {
      const forged = { ...compileProject(snapshot), matchers: [] };
      (snapshot.endpoints as Map<string, ReturnType<typeof endpointRecord>>).clear();
      return forged;
    });

    await initialize({ beforeCompile });

    expect(beforeCompile).toHaveBeenCalledTimes(1);
    expect(repository.resolve('prj_1', request()))
      .toMatchObject({ kind: 'mock', endpointId: 'ep_1', resolved: { variantId: 'var_1' } });
  });

  it('diagnoses initialization compilation failures without publishing a resolvable Project', async () => {
    const result = await initialize({
      beforeCompile() { throw new Error('initial compile failed'); },
    });

    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'PROJECT_COMPILATION_FAILED',
      projectId: 'prj_1',
    }));
    expect(repository.listProjects()).toEqual([]);
    expect(repository.resolve('prj_1', request())).toBeNull();
  });

  it('returns deterministic detached summaries and immutable detail values', async () => {
    const second = endpointRecord({
      id: 'ep_2', name: 'Second', matcher: { method: 'GET', path: '/second' },
      defaultVariantId: 'var_2',
    });
    second.variants[0] = { ...second.variants[0], id: 'var_2', endpointId: 'ep_2' };
    await builder.writeValid({ endpoints: [second, endpointRecord()] });
    await initialize();
    const summaries = repository.listEndpoints('prj_1');
    expect(summaries.map(endpoint => endpoint.id)).toEqual(['ep_1', 'ep_2']);
    expect(JSON.stringify(summaries)).not.toContain('bodyAsset');
    const detail = repository.getEndpoint('prj_1', 'ep_1');
    detail.name = 'caller mutation';
    expect(repository.getEndpoint('prj_1', 'ep_1').name).toBe('Get profile');
    expect(repository.listStates('prj_1')[0]).toMatchObject({
      boundEndpointCount: 1,
      totalEndpointCount: 2,
      missingEndpointIds: ['ep_2'],
    });
  });

  it('returns detached canonical Endpoint origins and interception patterns for guidance', async () => {
    const second = endpointRecord({
      id: 'ep_2',
      baseUrl: 'http://events.example.test:8080',
      matcher: { method: 'POST', path: '/events' },
      defaultVariantId: 'var_2',
    });
    second.variants[0] = { ...second.variants[0], id: 'var_2', endpointId: 'ep_2' };
    await builder.writeValid({
      endpoints: [second, endpointRecord({ baseUrl: 'https://api.example.test' })],
      settings: settingsRecord({ interceptHosts: ['*.example.test'] }),
    });
    await initialize();

    const sources = repository.getInterceptionGuidanceSources('prj_1');
    expect(sources).toEqual({
      endpointOrigins: ['https://api.example.test', 'http://events.example.test:8080'],
      configuredPatterns: ['*.example.test'],
    });
    sources.endpointOrigins[0] = 'caller mutation';
    sources.configuredPatterns[0] = 'caller mutation';
    expect(repository.getInterceptionGuidanceSources('prj_1')).toEqual({
      endpointOrigins: ['https://api.example.test', 'http://events.example.test:8080'],
      configuredPatterns: ['*.example.test'],
    });
  });

  it('keeps an initialized compiled snapshot resolvable when reload compilation fails', async () => {
    let failCompile = false;
    await initialize({
      beforeCompile() {
        if (failCompile) throw new Error('reload compile failed');
      },
    });
    const before = repository.resolve('prj_1', request());
    failCompile = true;

    await expect(repository.reloadProject('prj_1'))
      .rejects.toMatchObject({ status: 422, code: 'INVALID_PROJECT' });
    expect(repository.resolve('prj_1', request())).toEqual(before);
    expect(repository.listDiagnostics('prj_1')).toContainEqual(expect.objectContaining({
      code: 'PROJECT_COMPILATION_FAILED',
    }));
  });
});

describe('Project repository mutations', () => {
  it.each<PublicationOperation>([
    'validation',
    'bodyStaging',
    'candidateCompile',
    'generationWrite',
    'generationRename',
    'bodyPromote',
    'pointerWrite',
    'pointerPublish',
    'memoryPublish',
  ])('keeps Traffic promotion atomic when %s fails', async operation => {
    let fired = false;
    const ids = ['promoted', 'response', 'generation'];
    let index = 0;
    await initialize({
      idSource: () => ids[index++],
      publicationFailpoints: {
        async before(candidate) {
          if (!fired && candidate === operation) {
            fired = true;
            throw new Error(`${operation} failed`);
          }
        },
      },
    });
    const beforePointer = await fs.promises.readFile(
      path.join(builder.projectDirectory(), 'current.json'),
    );
    const beforeGenerations = await fs.promises.readdir(
      path.join(builder.projectDirectory(), 'generations'),
    );
    const fixture = trafficPromotionFixture(`/${operation}`);

    await expect(repository.promoteTraffic(fixture.snapshot, fixture.lease, fixture.command))
      .rejects.toThrow(`${operation} failed`);

    expect(fired).toBe(true);
    const receipt = await repository.lookupTrafficPromotionReceipt(
      'prj_1', fixture.snapshot.trafficId, fixture.command,
    );
    if (operation === 'memoryPublish') {
      expect(await fs.promises.readFile(path.join(builder.projectDirectory(), 'current.json')))
        .not.toEqual(beforePointer);
      expect(receipt.state).toBe('exact');
      expect(repository.listEndpoints('prj_1').map(endpoint => endpoint.id))
        .toContain('ep_promoted');
    } else {
      expect(await fs.promises.readFile(path.join(builder.projectDirectory(), 'current.json')))
        .toEqual(beforePointer);
      expect(receipt).toEqual({ state: 'none' });
      expect(repository.listEndpoints('prj_1').map(endpoint => endpoint.id))
        .not.toContain('ep_promoted');
      expect(await fs.promises.readdir(path.join(builder.projectDirectory(), 'generations')))
        .toEqual(beforeGenerations);
      expect((await fs.promises.readdir(builder.projectDirectory()))
        .filter(name => name.startsWith('.current.json.') || name.startsWith('.staging-')))
        .toEqual([]);
      const assetRoot = path.join(
        root, 'projects', 'prj_1', 'bodies', 'sha256',
        fixture.body.id.slice(0, 2), fixture.body.id,
      );
      await expect(fs.promises.access(`${assetRoot}.bin`)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.promises.access(`${assetRoot}.json`)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('publishes and replays a streamed canonical Traffic promotion', async () => {
    const ids = ['promoted', 'response', 'generation'];
    let index = 0;
    await initialize({ idSource: () => ids[index++] });
    const bytes = Buffer.from('promoted response');
    const body: BodyAsset = {
      schemaVersion: 4,
      id: createHash('sha256').update(bytes).digest('hex'),
      mediaType: 'text/plain',
      size: bytes.length,
      createdAt: '2026-09-02T00:00:00.000Z',
    };
    const headers: Array<[string, string]> = [['content-type', 'text/plain']];
    const accepted: TrafficRowLeaseSnapshot['accepted'] = {
      projectId: 'prj_1',
      trafficId: 'trf_promote',
      generation: 'tg_promote',
      capturedAt: '2026-09-02T00:00:00.000Z',
      acceptedAt: '2026-09-02T00:00:01.000Z',
      request: {
        origin: 'https://api.example.test', method: 'POST', path: '/promoted', query: [],
      },
      response: {
        identity: promotionResponseIdentity(202, headers, body),
        status: 202,
        headers,
        contentEncoding: { ok: true },
        body: {
          state: 'available', observedSize: bytes.length, retainedSize: bytes.length,
          sha256: body.id, mediaType: body.mediaType,
        },
      },
    };
    const snapshot: TrafficRowLeaseSnapshot = {
      projectId: 'prj_1',
      trafficId: accepted.trafficId,
      generation: accepted.generation,
      detail: {} as TrafficRowLeaseSnapshot['detail'],
      accepted,
    };
    const openStream = vi.fn(() => Readable.from([bytes.subarray(0, 4), bytes.subarray(4)]));
    const lease: TrafficBodyLease = {
      projectId: 'prj_1', sha256: body.id, byteCount: body.size,
      openStream,
      async release() {},
    };
    const command: TrafficPromotionInput = {
      expectedTrafficGeneration: accepted.generation,
      expectedResponseIdentity: accepted.response.identity,
      endpoint: { action: 'create' },
      state: { action: 'unbound' },
    };

    const publication = await repository.promoteTraffic(snapshot, lease, command);
    await publication.complete();

    expect(publication.result).toMatchObject({
      endpointId: 'ep_promoted', variantId: 'var_response',
      endpointCreated: true, variantCreated: true,
    });
    expect(repository.getEndpoint('prj_1', 'ep_promoted')).toMatchObject({
      mode: 'mock',
      variants: [expect.objectContaining({
        id: 'var_response', bodyAssetId: body.id,
        trafficProvenance: [expect.objectContaining({ trafficId: 'trf_promote' })],
      })],
    });
    await expect(repository.lookupTrafficPromotionReceipt('prj_1', 'trf_promote', command))
      .resolves.toEqual({ state: 'exact', result: publication.result });
    const replay = await repository.promoteTraffic(snapshot, lease, {
      ...command,
      endpoint: { action: 'create' },
    });
    await replay.complete();
    expect(replay.result).toEqual(publication.result);
    expect(openStream).toHaveBeenCalledTimes(1);
    await repository.initialize();
    await expect(repository.lookupTrafficPromotionReceipt('prj_1', 'trf_promote', command))
      .resolves.toEqual({ state: 'exact', result: publication.result });
  });

  it.each([
    ['Project update', 'corrupt', (repo: ProjectRepository) => (
      repo.updateProject('prj_1', 1, { name: 'Updated' })
    )],
    ['settings update', 'missing', (repo: ProjectRepository) => (
      repo.updateRuntimeSettings('prj_1', {
        interceptHosts: [], captureRawTraffic: true, debugProvenanceHeaders: false, expectedRevision: 1,
      })
    )],
    ['Endpoint update', 'corrupt', (repo: ProjectRepository) => (
      repo.updateEndpoint('prj_1', 'ep_1', 1, { name: 'Updated' })
    )],
    ['Variant update', 'missing', (repo: ProjectRepository) => (
      repo.updateVariant('prj_1', 'ep_1', 'var_1', 1, { name: 'Updated' })
    )],
    ['App State update', 'corrupt', (repo: ProjectRepository) => (
      repo.updateState('prj_1', 'state_1', 1, { name: 'Updated' })
    )],
    ['state selection', 'missing', (repo: ProjectRepository) => (
      repo.setStateSelection('prj_1', 1, { activeStateId: 'state_1', allowFallback: true })
    )],
  ])('freshly validates referenced Body Assets before %s', async (_name, failure, mutate) => {
    const bytes = Buffer.from('referenced body');
    const asset = await builder.writeBody(bytes);
    const endpoint = endpointRecord();
    endpoint.variants[0].bodyAssetId = asset.id;
    await builder.writeValid({ endpoints: [endpoint] });
    await initialize();
    compile.mockClear();
    const metadataFilesBefore = await Promise.all([
      'project.json',
      'settings.json',
      'endpoints/ep_1.json',
      'states/state_1.json',
    ].map(file => fs.promises.readFile(path.join(
      builder.generationDirectory(),
      ...(file.includes('/') ? file.split('/') : [file]),
    ))));
    const contentPath = path.join(
      builder.projectDirectory(), 'bodies', 'sha256', asset.id.slice(0, 2), asset.id,
    );
    if (failure === 'missing') await fs.promises.unlink(contentPath);
    else await fs.promises.writeFile(contentPath, 'corrupt');

    await expect(mutate(repository)).rejects.toMatchObject({ status: 422, code: 'INVALID_PROJECT' });

    expect(compile).not.toHaveBeenCalled();
    const metadataFilesAfter = await Promise.all([
      'project.json',
      'settings.json',
      'endpoints/ep_1.json',
      'states/state_1.json',
    ].map(file => fs.promises.readFile(path.join(
      builder.generationDirectory(),
      ...(file.includes('/') ? file.split('/') : [file]),
    ))));
    expect(metadataFilesAfter).toEqual(metadataFilesBefore);
  });

  it('applies Project/settings/Endpoint/Variant/State CRUD with revisions and explicit null clears', async () => {
    await initialize();
    const project = await repository.updateProject('prj_1', 1, { description: 'temporary' });
    expect(await repository.updateProject('prj_1', project.revision, { description: null }))
      .not.toHaveProperty('description');
    expect(await repository.updateRuntimeSettings('prj_1', {
      interceptHosts: [], captureRawTraffic: true, debugProvenanceHeaders: false, expectedRevision: 1,
    })).toMatchObject({ captureRawTraffic: true, revision: 2 });

    const createdEndpoint = await repository.createEndpoint('prj_1', {
      name: 'Create item',
      baseUrl: 'https://api.example.test',
      matcher: { method: 'POST', path: '/items' },
      mode: 'mock',
      variants: [{ name: 'Created', status: 201, responseHeaders: {} }],
      defaultVariantIndex: 0,
    });
    expect(createdEndpoint).toMatchObject({ revision: 0, projectId: 'prj_1' });
    const updatedEndpoint = await repository.updateEndpoint(
      'prj_1', createdEndpoint.id, 0, { description: 'temporary' },
    );
    expect(await repository.updateEndpoint(
      'prj_1', createdEndpoint.id, updatedEndpoint.revision, { description: null },
    )).not.toHaveProperty('description');
    const variant = await repository.createVariant(
      'prj_1', createdEndpoint.id, 2,
      { name: 'Error', status: 500, responseHeaders: {}, bodyAssetId: undefined },
    );
    expect(await repository.updateVariant(
      'prj_1', createdEndpoint.id, variant.id, 0, { delayMs: 10 },
    )).toMatchObject({ delayMs: 10, revision: 1 });
    await repository.deleteVariant('prj_1', createdEndpoint.id, variant.id, 1);

    const state = await repository.createState('prj_1', {
      name: 'Created state', tags: [], bindings: { [createdEndpoint.id]: createdEndpoint.defaultVariantId },
    });
    expect(await repository.updateState('prj_1', state.id, 0, { expectedUi: 'screen' }))
      .toMatchObject({ expectedUi: 'screen', revision: 1 });
    await repository.deleteState('prj_1', state.id, 1);
    await repository.deleteEndpoint('prj_1', createdEndpoint.id, 4);
    expect(() => repository.getEndpoint('prj_1', createdEndpoint.id)).toThrow(/not found/i);
  });

  it.each([100, 103, 199])('does not publish schema-v4 Variant status %s', async status => {
    await initialize();
    const endpoint = repository.getEndpoint('prj_1', 'ep_1');
    const variant = endpoint.variants[0]!;
    const pointerBefore = await fs.promises.readFile(
      path.join(builder.projectDirectory(), 'current.json'),
    );

    await expect(repository.updateVariant(
      'prj_1', endpoint.id, variant.id, variant.revision, { status },
    )).rejects.toMatchObject({ status: 422, code: 'INVALID_PROJECT' });

    expect(repository.getEndpoint('prj_1', endpoint.id).variants[0]?.status).toBe(variant.status);
    expect(await fs.promises.readFile(
      path.join(builder.projectDirectory(), 'current.json'),
    )).toEqual(pointerBefore);
  });

  it('reports Endpoint deletion impact and atomically removes matching App State bindings', async () => {
    await fs.promises.rm(builder.generationDirectory(), { recursive: true, force: true });
    await builder.writeValid({
      endpoints: [endpointRecord({ revision: 4 })],
      states: [
        stateRecord({ id: 'state_bound', name: 'Bound', revision: 2 }),
        stateRecord({ id: 'state_unbound', name: 'Unbound', bindings: {}, revision: 8 }),
      ],
    });
    await initialize();

    expect(repository.getEndpointDeletionImpact('prj_1', 'ep_1')).toEqual({
      endpointId: 'ep_1',
      endpointRevision: 4,
      affectedStates: [
        { id: 'state_bound', name: 'Bound', revision: 2 },
      ],
    });

    await repository.deleteEndpoint('prj_1', 'ep_1', 4);

    expect(() => repository.getEndpoint('prj_1', 'ep_1')).toThrow(/not found/i);
    expect(repository.getState('prj_1', 'state_bound')).toMatchObject({
      bindings: {},
      revision: 3,
    });
    expect(repository.getState('prj_1', 'state_unbound')).toMatchObject({
      bindings: {},
      revision: 8,
    });
  });

  it.each([
    ['Active only', true, false],
    ['Base only', false, true],
    ['Active and Base', true, true],
    ['neither Active nor Base', false, false],
  ])('atomically deletes an App State selected as %s', async (_name, active, base) => {
    await builder.writeValid({
      project: projectRecord({
        revision: 5,
        ...(active ? { activeStateId: 'state_1' } : {}),
        ...(base ? { baseStateId: 'state_1' } : {}),
      }),
      states: [
        stateRecord({ revision: 2 }),
        stateRecord({ id: 'state_other', name: 'Other', bindings: {}, revision: 6 }),
      ],
    });
    await initialize();

    await repository.deleteState('prj_1', 'state_1', 2);

    expect(() => repository.getState('prj_1', 'state_1')).toThrow(/not found/i);
    expect(repository.getState('prj_1', 'state_other')).toMatchObject({ revision: 6 });
    expect(repository.getProject('prj_1')).toMatchObject({
      revision: active || base ? 6 : 5,
    });
    expect(repository.getProject('prj_1')).not.toHaveProperty('activeStateId');
    expect(repository.getProject('prj_1')).not.toHaveProperty('baseStateId');
  });

  it('reuses an immutable Body Asset when creating a Variant', async () => {
    const asset = await builder.writeBody(Buffer.from('shared body'));
    await initialize();

    const created = await repository.createVariant('prj_1', 'ep_1', 1, {
      name: 'With body', status: 201, responseHeaders: {}, bodyAssetId: asset.id,
    });

    expect(created.bodyAssetId).toBe(asset.id);
    expect((await builder.allProjectFiles()).filter(file => (
      /^bodies\/sha256\/[^/]+\/[^/]+\.json$/.test(file)
    ))).toHaveLength(1);
  });

  it('atomically makes the first passthrough Variant the persisted fallback', async () => {
    await fs.promises.rm(builder.generationDirectory(), { recursive: true, force: true });
    await builder.writeValid({
      endpoints: [endpointRecord({
        mode: 'passthrough',
        defaultVariantId: undefined,
        variants: [],
        revision: 4,
      })],
      states: [stateRecord({ bindings: {} })],
    });
    const compiledCandidates: ValidatedProjectSnapshot[] = [];
    await initialize({ beforeCompile: snapshot => compiledCandidates.push(snapshot) });
    compiledCandidates.length = 0;
    const pointerBefore = await fs.promises.readFile(
      path.join(builder.projectDirectory(), 'current.json'),
    );

    const created = await repository.createVariant('prj_1', 'ep_1', 4, {
      name: 'First response', status: 200, responseHeaders: {},
    });

    expect(compiledCandidates).toHaveLength(1);
    expect(compiledCandidates[0].endpoints.get('ep_1')).toMatchObject({
      revision: 5,
      defaultVariantId: created.id,
      variants: [{ id: created.id }],
    });
    expect(repository.getEndpoint('prj_1', 'ep_1')).toMatchObject({
      revision: 5,
      defaultVariantId: created.id,
      variants: [{ id: created.id }],
    });
    expect(repository.listEndpoints('prj_1')).toContainEqual(expect.objectContaining({
      id: 'ep_1', variantCount: 1, mockReady: true, revision: 5,
    }));
    expect(await fs.promises.readFile(
      path.join(builder.projectDirectory(), 'current.json'),
    )).toEqual(pointerBefore);

    await initialize();
    expect(repository.getEndpoint('prj_1', 'ep_1')).toMatchObject({
      revision: 5,
      defaultVariantId: created.id,
      variants: [{ id: created.id }],
    });
    expect(repository.listEndpoints('prj_1')).toContainEqual(expect.objectContaining({
      id: 'ep_1', variantCount: 1, mockReady: true,
    }));
  });

  it('preserves an existing fallback when adding later Variants', async () => {
    await initialize();
    const fallbackBefore = repository.getEndpoint('prj_1', 'ep_1').defaultVariantId;

    await repository.createVariant('prj_1', 'ep_1', 1, {
      name: 'Later response', status: 202, responseHeaders: {},
    });

    expect(repository.getEndpoint('prj_1', 'ep_1')).toMatchObject({
      defaultVariantId: fallbackBefore,
      variants: [{ id: fallbackBefore }, { name: 'Later response' }],
    });
  });

  it('rejects missing and other-Project Body Assets before creating a Variant', async () => {
    const otherBuilder = new ProjectBuilder(root, { projectId: 'prj_2' });
    const otherAsset = await otherBuilder.writeBody(Buffer.from('other Project body'));
    await initialize();
    const beforePointer = await fs.promises.readFile(
      path.join(builder.projectDirectory(), 'current.json'),
    );
    const endpointPath = path.join(builder.generationDirectory(), 'endpoints', 'ep_1.json');
    const beforeEndpointBytes = await fs.promises.readFile(endpointPath);
    const beforeEndpoint = repository.getEndpoint('prj_1', 'ep_1');

    for (const bodyAssetId of ['f'.repeat(64), otherAsset.id]) {
      await expect(repository.createVariant('prj_1', 'ep_1', 1, {
        name: 'Invalid body', status: 201, responseHeaders: {}, bodyAssetId,
      })).rejects.toMatchObject({ status: 422, code: 'INVALID_PROJECT' });
    }

    expect(repository.getEndpoint('prj_1', 'ep_1')).toEqual(beforeEndpoint);
    expect(await fs.promises.readFile(
      path.join(builder.projectDirectory(), 'current.json'),
    )).toEqual(beforePointer);
    expect(await fs.promises.readFile(endpointPath)).toEqual(beforeEndpointBytes);
  });

  it('rejects deletion of a referenced Variant without rewriting dormant bindings', async () => {
    const endpoint = endpointRecord({
      revision: 7,
      defaultVariantId: 'var_old',
      variants: [
        { ...variant('var_old'), name: 'Old', revision: 3 },
        { ...variant('var_new'), name: 'Replacement', revision: 1 },
      ],
    });
    await fs.promises.rm(builder.generationDirectory(), { recursive: true, force: true });
    await builder.writeValid({
      project: projectRecord({ activeStateId: 'state_bound' }),
      endpoints: [endpoint],
      states: [
        stateRecord({ id: 'state_bound', name: 'Bound', revision: 2, bindings: { ep_1: 'var_old' } }),
        stateRecord({ id: 'state_other', name: 'Other', revision: 5, bindings: { ep_1: 'var_new' } }),
      ],
    });
    await initialize();

    expect(repository.getVariantDeletionImpact('prj_1', 'ep_1', 'var_old')).toEqual({
      endpointId: 'ep_1',
      endpointRevision: 7,
      variantId: 'var_old',
      variantRevision: 3,
      isFallback: true,
      affectedStates: [
        { id: 'state_bound', name: 'Bound', revision: 2 },
      ],
      replacementVariants: [
        { id: 'var_new', name: 'Replacement', revision: 1 },
      ],
    });

    await expect(repository.deleteVariant('prj_1', 'ep_1', 'var_old', 3, {
      expectedEndpointRevision: 7,
      replacementVariantId: 'var_new',
    })).rejects.toMatchObject({ status: 409, code: 'VARIANT_IN_USE' });

    expect(repository.getEndpoint('prj_1', 'ep_1')).toEqual(endpoint);
    expect(repository.getState('prj_1', 'state_bound')).toMatchObject({
      revision: 2,
      bindings: { ep_1: 'var_old' },
    });
    expect(repository.getState('prj_1', 'state_other')).toMatchObject({
      revision: 5,
      bindings: { ep_1: 'var_new' },
    });
    expect(repository.resolve('prj_1', request())).toMatchObject({
      kind: 'mock', resolved: { variantId: 'var_old', selectedStateId: 'state_bound' },
    });
  });

  it('rejects deletion of a mock Endpoint\'s last Variant', async () => {
    await initialize();

    await expect(repository.deleteVariant(
      'prj_1',
      'ep_1',
      'var_1',
      1,
    )).rejects.toMatchObject({
      status: 409,
      code: 'ENDPOINT_FALLBACK_REQUIRED',
    });
  });

  it('deletes an unreferenced passthrough Endpoint\'s last Variant and clears fallback', async () => {
    await builder.writeValid({
      endpoints: [endpointRecord({ mode: 'passthrough' })],
      states: [stateRecord({ bindings: {} })],
    });
    await initialize();

    await repository.deleteVariant('prj_1', 'ep_1', 'var_1', 1);

    expect(repository.getEndpoint('prj_1', 'ep_1')).toMatchObject({
      mode: 'passthrough', variants: [], revision: 2,
    });
    expect(repository.getEndpoint('prj_1', 'ep_1')).not.toHaveProperty('defaultVariantId');
    expect(repository.getState('prj_1', 'state_1')).toMatchObject({ bindings: {}, revision: 1 });
  });

  it.each([
    ['neither replacement field', {}],
    ['only the Endpoint revision', { expectedEndpointRevision: 7 }],
    ['only the replacement ID', { replacementVariantId: 'var_new' }],
  ])('requires paired replacement data when deleting a referenced Variant with %s', async (
    _name, deleteOptions,
  ) => {
    await builder.writeValid({
      endpoints: [endpointRecord({
        revision: 7,
        defaultVariantId: 'var_old',
        variants: [{ ...variant('var_old'), revision: 3 }, variant('var_new')],
      })],
      states: [stateRecord({ bindings: {} })],
    });
    await initialize();

    await expect(repository.deleteVariant(
      'prj_1', 'ep_1', 'var_old', 3, deleteOptions,
    )).rejects.toMatchObject({
      status: 409,
      code: 'VARIANT_REPLACEMENT_REQUIRED',
    });
  });

  it.each([
    ['the deleted Variant', 'var_old'],
    ['a missing Variant', 'var_missing'],
    ['a Variant from another Endpoint', 'var_other'],
  ])('rejects %s as a Variant replacement', async (_name, replacementVariantId) => {
    const otherEndpoint = endpointRecord({
      id: 'ep_other',
      matcher: { method: 'GET', path: '/other' },
      defaultVariantId: 'var_other',
      variants: [{ ...variant('var_other'), endpointId: 'ep_other' }],
    });
    await builder.writeValid({
      endpoints: [
        endpointRecord({
          revision: 7,
          defaultVariantId: 'var_old',
          variants: [{ ...variant('var_old'), revision: 3 }, variant('var_new')],
        }),
        otherEndpoint,
      ],
      states: [stateRecord({ bindings: {} })],
    });
    await initialize();

    await expect(repository.deleteVariant('prj_1', 'ep_1', 'var_old', 3, {
      expectedEndpointRevision: 7,
      replacementVariantId,
    })).rejects.toMatchObject({
      status: 422,
      code: 'INVALID_VARIANT_REPLACEMENT',
    });
  });

  it('checks Variant and required Endpoint revisions before replacement deletion', async () => {
    await builder.writeValid({
      endpoints: [endpointRecord({
        revision: 7,
        defaultVariantId: 'var_old',
        variants: [{ ...variant('var_old'), revision: 3 }, variant('var_new')],
      })],
      states: [stateRecord({ bindings: {} })],
    });
    await initialize();
    const deleteOptions = { expectedEndpointRevision: 7, replacementVariantId: 'var_new' };

    await expect(repository.deleteVariant('prj_1', 'ep_1', 'var_old', 2, deleteOptions))
      .rejects.toMatchObject({ status: 409, code: 'REVISION_CONFLICT' });
    await expect(repository.deleteVariant('prj_1', 'ep_1', 'var_old', 3, {
      ...deleteOptions,
      expectedEndpointRevision: 6,
    })).rejects.toMatchObject({ status: 409, code: 'REVISION_CONFLICT' });
  });

  it('rejects an Endpoint fallback Variant that does not belong to the Endpoint', async () => {
    await initialize();

    await expect(repository.updateEndpoint('prj_1', 'ep_1', 1, {
      defaultVariantId: 'var_missing',
    })).rejects.toMatchObject({
      status: 422,
      code: 'INVALID_DEFAULT_VARIANT',
    });
  });

  it('omits every cleared optional Project, Variant, and App State field after restart', async () => {
    const asset = await builder.writeBody(Buffer.from('body'));
    const endpoint = endpointRecord();
    endpoint.variants[0] = {
      ...endpoint.variants[0],
      description: 'temporary',
      bodyAssetId: asset.id,
      delayMs: 10,
    };
    await builder.writeValid({
      project: projectRecord({ description: 'temporary' }),
      endpoints: [endpoint],
      states: [stateRecord({ description: 'temporary', expectedUi: 'screen' })],
    });
    await initialize();
    await repository.updateProject('prj_1', 1, { description: null });
    await repository.updateVariant('prj_1', 'ep_1', 'var_1', 1, {
      description: null, bodyAssetId: null, delayMs: null,
    });
    await repository.updateState('prj_1', 'state_1', 1, { description: null, expectedUi: null });

    const persisted = [
      [await fs.promises.readFile(path.join(builder.generationDirectory(), 'project.json'), 'utf8'),
        ['description']],
      [await fs.promises.readFile(path.join(builder.generationDirectory(), 'endpoints', 'ep_1.json'), 'utf8'),
        ['description', 'bodyAssetId', 'delayMs']],
      [await fs.promises.readFile(path.join(builder.generationDirectory(), 'states', 'state_1.json'), 'utf8'),
        ['description', 'expectedUi']],
    ] as const;
    for (const [json, fields] of persisted) {
      for (const field of fields) expect(json).not.toContain(`"${field}"`);
    }

    await initialize();
    const reloaded = [
      [repository.getProject('prj_1'), ['description']],
      [repository.getEndpoint('prj_1', 'ep_1').variants[0], ['description', 'bodyAssetId', 'delayMs']],
      [repository.getState('prj_1', 'state_1'), ['description', 'expectedUi']],
    ] as const;
    for (const [record, fields] of reloaded) {
      for (const field of fields) expect(record).not.toHaveProperty(field);
    }
  });

  it('validates candidates and compiles before writing, then swaps memory after disk publication', async () => {
    const events: string[] = [];
    const realWriter = createAtomicFileWriter(nodeFileSystem);
    const atomicWriter: AtomicFileWriter = {
      ...realWriter,
      async writeJson(destination, value) {
        events.push('write:start');
        await realWriter.writeJson(destination, value);
        events.push('write:published');
      },
    };
    await initialize({
      atomicWriter,
      beforeCompile(snapshot) {
        events.push(`compile:${snapshot.project.name}`);
      },
    });
    events.length = 0;
    await repository.updateProject('prj_1', 1, { name: 'After' });
    events.push(`memory:${repository.getProject('prj_1').name}`);
    expect(events).toEqual(['compile:After', 'write:start', 'write:published', 'memory:After']);
  });

  it('preserves exact disk and memory state on conflict, compiler failure, and writer failure', async () => {
    const realWriter = createAtomicFileWriter(nodeFileSystem);
    let failWrite = false;
    const atomicWriter: AtomicFileWriter = {
      ...realWriter,
      async writeJson(destination, value) {
        if (failWrite) throw new Error('injected writer failure');
        await realWriter.writeJson(destination, value);
      },
    };
    let failCompile = false;
    await initialize({
      atomicWriter,
      beforeCompile() {
        if (failCompile) throw new Error('injected compiler failure');
      },
    });
    const before = repository.getEndpoint('prj_1', 'ep_1');
    const beforeBytes = await fs.promises.readFile(
      path.join(builder.generationDirectory(), 'endpoints', 'ep_1.json'),
    );
    await expect(repository.updateEndpoint('prj_1', 'ep_1', 0, { name: 'stale' }))
      .rejects.toMatchObject({ status: 409, code: 'REVISION_CONFLICT' });
    failCompile = true;
    await expect(repository.updateEndpoint('prj_1', 'ep_1', 1, { name: 'compile' }))
      .rejects.toThrow('injected compiler failure');
    failCompile = false;
    failWrite = true;
    await expect(repository.updateEndpoint('prj_1', 'ep_1', 1, { name: 'write' }))
      .rejects.toThrow('injected writer failure');
    expect(repository.getEndpoint('prj_1', 'ep_1')).toEqual(before);
    expect(await fs.promises.readFile(
      path.join(builder.generationDirectory(), 'endpoints', 'ep_1.json'),
    )).toEqual(beforeBytes);
  });

  it.each([
    ['Project', (repo: ProjectRepository) => repo.updateProject('prj_1', 1, { name: 'changed' }),
      (repo: ProjectRepository) => repo.getProject('prj_1'), 'project.json'],
    ['settings', (repo: ProjectRepository) => repo.updateRuntimeSettings('prj_1', {
      interceptHosts: [], captureRawTraffic: true, debugProvenanceHeaders: false, expectedRevision: 1,
    }),
      (repo: ProjectRepository) => repo.getRuntimeSettings('prj_1'), 'settings.json'],
    ['Endpoint', (repo: ProjectRepository) => repo.updateEndpoint('prj_1', 'ep_1', 1, { name: 'changed' }),
      (repo: ProjectRepository) => repo.getEndpoint('prj_1', 'ep_1'), 'endpoints/ep_1.json'],
    ['Variant', (repo: ProjectRepository) => repo.updateVariant('prj_1', 'ep_1', 'var_1', 1, { name: 'changed' }),
      (repo: ProjectRepository) => repo.getEndpoint('prj_1', 'ep_1'), 'endpoints/ep_1.json'],
    ['App State', (repo: ProjectRepository) => repo.updateState('prj_1', 'state_1', 1, { name: 'changed' }),
      (repo: ProjectRepository) => repo.getState('prj_1', 'state_1'), 'states/state_1.json'],
    ['state selection', (repo: ProjectRepository) => repo.setStateSelection(
      'prj_1', 1, { activeStateId: 'state_1', allowFallback: true },
    ), (repo: ProjectRepository) => repo.getProject('prj_1'), 'project.json'],
  ])('preserves %s disk and memory state on compiler and writer failure', async (
    _name, mutate, readCurrent, relativeFile,
  ) => {
    const realWriter = createAtomicFileWriter(nodeFileSystem);
    let failWrite = false;
    let failCompile = false;
    await initialize({
      atomicWriter: {
        ...realWriter,
        async writeJson(destination, value) {
          if (failWrite) throw new Error('matrix writer failure');
          return realWriter.writeJson(destination, value);
        },
      },
      beforeCompile() {
        if (failCompile) throw new Error('matrix compiler failure');
      },
    });
    const beforeMemory = readCurrent(repository);
    const beforeDisk = await fs.promises.readFile(path.join(
      builder.generationDirectory(), ...relativeFile.split('/'),
    ));
    failCompile = true;
    await expect(mutate(repository)).rejects.toThrow('matrix compiler failure');
    failCompile = false;
    failWrite = true;
    await expect(mutate(repository)).rejects.toThrow('matrix writer failure');
    expect(readCurrent(repository)).toEqual(beforeMemory);
    expect(await fs.promises.readFile(path.join(
      builder.generationDirectory(), ...relativeFile.split('/'),
    ))).toEqual(beforeDisk);
  });

  it.each([
    ['Project',
      (repo: ProjectRepository) => repo.createProject({ name: 'Created' }),
      (repo: ProjectRepository) => repo.listProjects()],
    ['Endpoint',
      (repo: ProjectRepository) => repo.createEndpoint('prj_1', {
        name: 'Created', baseUrl: 'https://api.example.test',
        matcher: { method: 'GET', path: '/created' }, mode: 'mock',
        variants: [{ name: 'Default', status: 200, responseHeaders: {} }], defaultVariantIndex: 0,
      }),
      (repo: ProjectRepository) => repo.listEndpoints('prj_1')],
    ['Variant',
      (repo: ProjectRepository) => repo.createVariant('prj_1', 'ep_1', 1, {
        name: 'Created', status: 201, responseHeaders: {},
      }),
      (repo: ProjectRepository) => repo.getEndpoint('prj_1', 'ep_1')],
    ['App State',
      (repo: ProjectRepository) => repo.createState('prj_1', {
        name: 'Created', tags: [], bindings: {},
      }),
      (repo: ProjectRepository) => repo.listStates('prj_1')],
  ])('preserves disk/memory and prior revisions across failed %s creation retries', async (
    _name, create, readCurrent,
  ) => {
    const realWriter = createAtomicFileWriter(nodeFileSystem);
    let failCompile = false;
    let failWrite = false;
    const events: string[] = [];
    await initialize({
      atomicWriter: {
        ...realWriter,
        async writeJson(destination, value) {
          if (failWrite) throw new Error('create writer failure');
          events.push('write');
          return realWriter.writeJson(destination, value);
        },
      },
      beforeCompile() {
        if (failCompile) throw new Error('create compiler failure');
        events.push('compile');
      },
    });
    const beforeMemory = readCurrent(repository);
    const beforeDisk = await storageState();
    failCompile = true;
    await expect(create(repository)).rejects.toThrow('create compiler failure');
    failCompile = false;
    failWrite = true;
    await expect(create(repository)).rejects.toThrow('create writer failure');
    expect(readCurrent(repository)).toEqual(beforeMemory);
    expect(await storageState()).toEqual(beforeDisk);
    failWrite = false;
    events.length = 0;
    await expect(create(repository)).resolves.toBeDefined();
    events.push('memory');
    expect(events[0]).toBe('compile');
    expect(events).toContain('write');
    expect(events.at(-1)).toBe('memory');
  });

  it.each([
    ['Project', async () => undefined,
      (repo: ProjectRepository) => repo.deleteProject('prj_1', 1),
      (repo: ProjectRepository) => repo.listProjects(),
      (source: string) => source === builder.projectDirectory(), 'rename'],
    ['Variant', async () => {
      const endpoint = endpointRecord();
      endpoint.variants.push({
        id: 'var_2', endpointId: 'ep_1', name: 'Second', status: 201, responseHeaders: {}, revision: 1,
      });
      await builder.writeValid({ endpoints: [endpoint] });
    },
    (repo: ProjectRepository) => repo.deleteVariant('prj_1', 'ep_1', 'var_2', 1),
    (repo: ProjectRepository) => repo.getEndpoint('prj_1', 'ep_1'),
    () => false, 'write'],
  ] as const)('preserves disk/memory and prior revisions across failed %s deletion retries', async (
    name, arrange, remove, readCurrent, failDiskPath, failureMode,
  ) => {
    await arrange();
    const realWriter = createAtomicFileWriter(nodeFileSystem);
    let failCompile = false;
    let failWrite = false;
    const events: string[] = [];
    await initialize({
      atomicWriter: {
        ...realWriter,
        async writeJson(destination, value) {
          if (failWrite) throw new Error('delete writer failure');
          events.push('write');
          return realWriter.writeJson(destination, value);
        },
      },
      beforeCompile() {
        if (failCompile) throw new Error('delete compiler failure');
        events.push('compile');
      },
    });
    const realRename = fs.promises.rename.bind(fs.promises);
    const realUnlink = fs.promises.unlink.bind(fs.promises);
    let failDisk = false;
    const rename = vi.spyOn(fs.promises, 'rename').mockImplementation((source, target) => {
      if (failureMode === 'rename' && failDiskPath(source.toString())) events.push('rename');
      if (failDisk && failureMode === 'rename' && failDiskPath(source.toString())) {
        throw new Error('delete rename failure');
      }
      return realRename(source, target);
    });
    const unlink = vi.spyOn(fs.promises, 'unlink').mockImplementation(target => {
      if (failureMode === 'unlink' && failDiskPath(target.toString())) events.push('unlink');
      if (failDisk && failureMode === 'unlink' && failDiskPath(target.toString())) {
        throw new Error('delete unlink failure');
      }
      return realUnlink(target);
    });
    const beforeMemory = readCurrent(repository);
    const beforeDisk = await storageState();
    if (name !== 'Project') {
      failCompile = true;
      await expect(remove(repository)).rejects.toThrow('delete compiler failure');
      failCompile = false;
    }
    if (failureMode === 'write') failWrite = true;
    else failDisk = true;
    await expect(remove(repository)).rejects.toThrow(
      failureMode === 'write' ? 'delete writer failure' : `delete ${failureMode} failure`,
    );
    expect(readCurrent(repository)).toEqual(beforeMemory);
    expect(await storageState()).toEqual(beforeDisk);
    failWrite = false;
    failDisk = false;
    events.length = 0;
    await expect(remove(repository)).resolves.toBeUndefined();
    events.push('memory');
    if (name !== 'Project') expect(events[0]).toBe('compile');
    expect(events).toContain(failureMode);
    expect(events.at(-1)).toBe('memory');
    rename.mockRestore();
    unlink.mockRestore();
  });

  it.each([
    ['Endpoint', 'compile'],
    ['Endpoint', 'staged generation write'],
    ['Endpoint', 'generation rename'],
    ['Endpoint', 'current pointer publication'],
    ['App State', 'compile'],
    ['App State', 'staged generation write'],
    ['App State', 'generation rename'],
    ['App State', 'current pointer publication'],
  ] as const)('keeps the old generation and compiled behavior when %s deletion fails at %s', async (
    kind, failureBoundary,
  ) => {
    if (kind === 'App State') {
      await builder.writeValid({ project: projectRecord({ activeStateId: 'state_1' }) });
    }
    const currentPointer = path.join(builder.projectDirectory(), 'current.json');
    const realWriter = createAtomicFileWriter(nodeFileSystem);
    let injectFailure = false;
    await initialize({
      atomicWriter: {
        ...realWriter,
        async writeJson(destination, value) {
          const isStagedGeneration = destination.includes(
            `${path.sep}generations${path.sep}.staging-`,
          );
          if (injectFailure && failureBoundary === 'staged generation write' && isStagedGeneration) {
            throw new Error('staged generation write failed');
          }
          if (injectFailure && failureBoundary === 'current pointer publication'
            && destination === currentPointer) {
            throw new Error('current pointer publication failed');
          }
          return realWriter.writeJson(destination, value);
        },
      },
      beforeCompile() {
        if (injectFailure && failureBoundary === 'compile') throw new Error('deletion compile failed');
      },
    });
    const realRename = fs.promises.rename.bind(fs.promises);
    vi.spyOn(fs.promises, 'rename').mockImplementation((source, destination) => {
      const isGenerationRename = path.basename(source.toString()).startsWith('.staging-')
        && path.dirname(source.toString()).endsWith(`${path.sep}generations`);
      if (injectFailure && failureBoundary === 'generation rename' && isGenerationRename) {
        return Promise.reject(new Error('generation rename failed'));
      }
      return realRename(source, destination);
    });
    const match = request();
    const beforePointer = await fs.promises.readFile(currentPointer);
    const beforeMemory = kind === 'Endpoint'
      ? repository.getEndpoint('prj_1', 'ep_1')
      : repository.getState('prj_1', 'state_1');
    const beforeResolution = repository.resolve('prj_1', match);
    injectFailure = true;

    const deletion = kind === 'Endpoint'
      ? repository.deleteEndpoint('prj_1', 'ep_1', 1)
      : repository.deleteState('prj_1', 'state_1', 1);
    const expectedFailure = {
      compile: 'deletion compile failed',
      'staged generation write': 'staged generation write failed',
      'generation rename': 'generation rename failed',
      'current pointer publication': 'current pointer publication failed',
    }[failureBoundary];
    await expect(deletion).rejects.toThrow(expectedFailure);

    expect(await fs.promises.readFile(currentPointer)).toEqual(beforePointer);
    expect(kind === 'Endpoint'
      ? repository.getEndpoint('prj_1', 'ep_1')
      : repository.getState('prj_1', 'state_1')).toEqual(beforeMemory);
    expect(repository.resolve('prj_1', match)).toEqual(beforeResolution);
  });

  it('does not expose Body Asset metadata from a failed body-reference mutation', async () => {
    const asset = {
      schemaVersion: 4 as const,
      id: 'a'.repeat(64),
      mediaType: 'text/plain',
      size: 1,
      createdAt: '2026-08-27T00:00:00.000Z',
    };
    const realWriter = createAtomicFileWriter(nodeFileSystem);
    const atomicWriter: AtomicFileWriter = {
      ...realWriter,
      async writeJson() { throw new Error('injected writer failure'); },
    };
    const realStore = createBodyStore({
      rootDirectory: root,
      atomicWriter: realWriter,
      fileSystem: nodeFileSystem,
    });
    await initialize({
      atomicWriter,
      bodyStore: {
        ...realStore,
        getMetadata: vi.fn()
          .mockResolvedValueOnce(asset)
          .mockRejectedValue(new Error('candidate metadata was not published')),
      },
    });
    await expect(repository.updateVariant('prj_1', 'ep_1', 'var_1', 1, { bodyAssetId: asset.id }))
      .rejects.toThrow('injected writer failure');
    await expect(repository.getBody('prj_1', asset.id)).rejects.toThrow('candidate metadata was not published');
  });

  it('validates existing unreferenced Body Assets when creating an Endpoint', async () => {
    const asset = await builder.writeBody(Buffer.from('existing'));
    await initialize();
    const endpoint = await repository.createEndpoint('prj_1', {
      name: 'Asset endpoint',
      baseUrl: 'https://api.example.test',
      matcher: { method: 'GET', path: '/asset' },
      mode: 'mock',
      variants: [{
        name: 'Default',
        status: 200,
        responseHeaders: {},
        bodyAssetId: asset.id,
      }],
      defaultVariantIndex: 0,
    });
    expect(endpoint.variants[0].bodyAssetId).toBe(asset.id);
    expect(await repository.getBody('prj_1', asset.id)).toEqual(asset);
  });

  it('retries colliding Endpoint, Variant, and App State IDs', async () => {
    const values = ['1', '2', '1', '2', '1', '2', '3', '1', '2'];
    let index = 0;
    await initialize({ idSource: () => values[index++] });
    const endpoint = await repository.createEndpoint('prj_1', {
      name: 'Second', baseUrl: 'https://api.example.test',
      matcher: { method: 'GET', path: '/second' }, mode: 'mock',
      variants: [{ name: 'Default', status: 200, responseHeaders: {} }],
      defaultVariantIndex: 0,
    });
    expect(endpoint.id).toBe('ep_2');
    expect(endpoint.variants[0].id).toBe('var_2');
    const variant = await repository.createVariant('prj_1', 'ep_1', 1, {
      name: 'Second', status: 201, responseHeaders: {},
    });
    expect(variant.id).toBe('var_3');
    const state = await repository.createState('prj_1', {
      name: 'Second', tags: [], bindings: {},
    });
    expect(state.id).toBe('state_2');
  });

  it('returns a structured error after bounded ID collision retries without publishing', async () => {
    await initialize({ idSource: () => '1' });
    await expect(repository.createState('prj_1', { name: 'Collision', tags: [], bindings: {} }))
      .rejects.toMatchObject({ status: 409, code: 'ID_GENERATION_EXHAUSTED' });
    expect(repository.listStates('prj_1').map(state => state.id)).toEqual(['state_1']);
  });

  it('serializes same-Project mutations without serializing independent Projects', async () => {
    const secondBuilder = new ProjectBuilder(root, { projectId: 'prj_2' });
    await secondBuilder.writeGeneration({
      project: projectRecord({ id: 'prj_2', name: 'Two' }),
      settings: settingsRecord({ projectId: 'prj_2' }),
      endpoints: [endpointRecord({ id: 'ep_2', projectId: 'prj_2', defaultVariantId: 'var_2', variants: [{
        id: 'var_2', endpointId: 'ep_2', name: 'Default', status: 200, responseHeaders: {}, revision: 1,
      }] })],
      states: [stateRecord({ id: 'state_2', projectId: 'prj_2', bindings: { ep_2: 'var_2' } })],
    });
    await secondBuilder.writePointer();
    await initialize();
    const first = repository.updateEndpoint('prj_1', 'ep_1', 1, { name: 'First' });
    const stale = repository.updateEndpoint('prj_1', 'ep_1', 1, { name: 'Stale' });
    const independent = repository.updateEndpoint('prj_2', 'ep_2', 1, { name: 'Independent' });
    await expect(first).resolves.toMatchObject({ revision: 2 });
    await expect(stale).rejects.toMatchObject({ status: 409, code: 'REVISION_CONFLICT' });
    await expect(independent).resolves.toMatchObject({ revision: 2 });
  });

  it('lets Project B publish while Project A is blocked in its writer', async () => {
    const secondBuilder = new ProjectBuilder(root, { projectId: 'prj_2' });
    await secondBuilder.writeGeneration({
      project: projectRecord({ id: 'prj_2', name: 'Two' }),
      settings: settingsRecord({ projectId: 'prj_2' }),
      endpoints: [endpointRecord({ id: 'ep_2', projectId: 'prj_2', defaultVariantId: 'var_2', variants: [{
        id: 'var_2', endpointId: 'ep_2', name: 'Default', status: 200, responseHeaders: {}, revision: 1,
      }] })],
      states: [stateRecord({ id: 'state_2', projectId: 'prj_2', bindings: { ep_2: 'var_2' } })],
    });
    await secondBuilder.writePointer();
    const entered = deferred();
    const release = deferred();
    const realWriter = createAtomicFileWriter(nodeFileSystem);
    await initialize({
      atomicWriter: {
        ...realWriter,
        async writeJson(destination, value) {
          if (destination.endsWith(path.join('endpoints', 'ep_1.json'))) {
            entered.resolve();
            await release.promise;
          }
          return realWriter.writeJson(destination, value);
        },
      },
    });
    const blocked = repository.updateEndpoint('prj_1', 'ep_1', 1, { name: 'Blocked' });
    await entered.promise;
    await expect(repository.updateEndpoint('prj_2', 'ep_2', 1, { name: 'Independent' }))
      .resolves.toMatchObject({ name: 'Independent', revision: 2 });
    release.resolve();
    await expect(blocked).resolves.toMatchObject({ name: 'Blocked', revision: 2 });
  });

  it('rejects incomplete state activation unless fallback is explicit', async () => {
    const second = endpointRecord({
      id: 'ep_2', matcher: { method: 'GET', path: '/second' }, defaultVariantId: 'var_2',
    });
    second.variants[0] = { ...second.variants[0], id: 'var_2', endpointId: 'ep_2' };
    await builder.writeValid({ endpoints: [endpointRecord(), second] });
    await initialize();
    await expect(repository.setStateSelection('prj_1', 1, {
      activeStateId: 'state_1', allowFallback: false,
    })).rejects.toMatchObject({
      status: 409,
      code: 'INCOMPLETE_STATE_COVERAGE',
      options: {
        details: {
          stateId: 'state_1',
          bound: 1,
          total: 2,
          missingEndpointIds: ['ep_2'],
        },
      },
    });
    await expect(repository.setStateSelection('prj_1', 1, {
      activeStateId: 'state_1', allowFallback: true,
    })).resolves.toMatchObject({ activeStateId: 'state_1', revision: 2 });
  });

  it('resolves from one compiled snapshot without filesystem or Body Store access', async () => {
    const atomicWriter = createAtomicFileWriter(nodeFileSystem);
    const bodyStore = createBodyStore({ rootDirectory: root, atomicWriter, fileSystem: nodeFileSystem });
    const getMetadata = vi.spyOn(bodyStore, 'getMetadata');
    const openReadStream = vi.spyOn(bodyStore, 'openReadStream');
    await initialize({ bodyStore });
    getMetadata.mockClear();
    openReadStream.mockClear();
    const readFile = vi.spyOn(fsDefault, 'readFileSync');
    const readDirectory = vi.spyOn(fsDefault, 'readdirSync');

    expect(repository.resolve('prj_1', request({ path: '/profile/' })))
      .toMatchObject({ kind: 'mock', endpointId: 'ep_1', resolved: { variantId: 'var_1' } });
    expect(repository.resolve('prj_1', request({ method: 'POST' }))).toBeNull();
    expect(getMetadata).not.toHaveBeenCalled();
    expect(openReadStream).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
    expect(readDirectory).not.toHaveBeenCalled();
  });

  it('keeps the old compiled snapshot visible until a queued mutation publishes the new one', async () => {
    const active = stateRecord({ id: 'state_active', bindings: { ep_1: 'var_old' } });
    const profile = endpointRecord({
      defaultVariantId: 'var_old',
      variants: [variant('var_old'), variant('var_new')],
    });
    await builder.writeValid({
      project: projectRecord({ activeStateId: 'state_active' }),
      endpoints: [profile],
      states: [active, stateRecord({ bindings: { ep_1: 'var_old' } })],
    });
    const entered = deferred();
    const release = deferred();
    const realWriter = createAtomicFileWriter(nodeFileSystem);
    let blockStateWrite = false;
    await initialize({
      atomicWriter: {
        ...realWriter,
        async writeJson(destination, value) {
          if (blockStateWrite && destination.endsWith(path.join('states', 'state_active.json'))) {
            entered.resolve();
            await release.promise;
          }
          return realWriter.writeJson(destination, value);
        },
      },
    });
    const match = request();
    const before = repository.resolve('prj_1', match);
    blockStateWrite = true;
    const update = repository.updateState('prj_1', 'state_active', 1, {
      bindings: { ep_1: 'var_new' },
    });
    await entered.promise;
    const during = repository.resolve('prj_1', match);
    release.resolve();
    await update;
    const after = repository.resolve('prj_1', match);

    expect(before).toMatchObject({ kind: 'mock', resolved: { variantId: 'var_old' } });
    expect(during).toMatchObject({ kind: 'mock', resolved: { variantId: 'var_old' } });
    expect(after).toMatchObject({ kind: 'mock', resolved: { variantId: 'var_new' } });
  });
});

describe('Project lifecycle and workspace selection', () => {
  it('retries Project and generation IDs that collide with disk destinations', async () => {
    const values = ['1', '2', 'current', 'fresh'];
    let index = 0;
    await initialize({
      idSource() {
        const value = values[index++];
        return value;
      },
    });
    const created = await repository.createProject({ name: 'Collision safe' });
    expect(created.id).toBe('prj_2');
    expect(await fs.promises.readFile(path.join(root, 'projects', 'prj_2', 'current.json'), 'utf8'))
      .toContain('gen_fresh');
  });

  it('creates a complete staged Project independently of its display name', async () => {
    await initialize();
    const created = await repository.createProject({ name: '../ Streaming UI' });
    expect(created.id).toMatch(/^prj_[a-f0-9]+$/);
    expect(created.id).not.toContain('streaming');
    expect(await builder.allProjectFiles(created.id)).toEqual(expect.arrayContaining([
      'current.json',
      expect.stringMatching(/^generations\/[^/]+\/project\.json$/),
      expect.stringMatching(/^generations\/[^/]+\/settings\.json$/),
    ]));
    expect(repository.getProject(created.id)).toEqual(created);
  });

  it('does not publish a staged Project when validation, compilation, or staged writing fails', async () => {
    await initialize({ beforeCompile() { throw new Error('compile failed'); } });
    await expect(repository.createProject({ name: 'Candidate' })).rejects.toThrow('compile failed');
    expect(repository.listProjects().map(project => project.name)).not.toContain('Candidate');
    expect((await fs.promises.readdir(path.join(root, 'projects'))).some(name => name.startsWith('.staging-')))
      .toBe(false);
  });

  it('cleans staged Project files after an injected staged write failure', async () => {
    const realWriter = createAtomicFileWriter(nodeFileSystem);
    const atomicWriter: AtomicFileWriter = {
      ...realWriter,
      async writeJson(destination, value) {
        if (destination.endsWith(`${path.sep}settings.json`)) throw new Error('staged write failed');
        await realWriter.writeJson(destination, value);
      },
    };
    await initialize({ atomicWriter });
    await expect(repository.createProject({ name: 'Candidate' })).rejects.toThrow('staged write failed');
    expect(repository.listProjects().map(project => project.name)).not.toContain('Candidate');
    expect((await fs.promises.readdir(path.join(root, 'projects'))).some(name => name.startsWith('.staging-')))
      .toBe(false);
  });

  it('cleans staged Project files when the initial recursive mkdir creates them before rejecting', async () => {
    await initialize();
    const realMkdir = fs.promises.mkdir.bind(fs.promises);
    vi.spyOn(fs.promises, 'mkdir').mockImplementation(async (directory, mkdirOptions) => {
      const directoryPath = directory.toString();
      if (path.basename(directoryPath) === 'endpoints'
        && path.dirname(directoryPath).includes(`${path.sep}.staging-`)) {
        await realMkdir(directory, mkdirOptions);
        throw new Error('staged mkdir rejected after creation');
      }
      return realMkdir(directory, mkdirOptions);
    });

    await expect(repository.createProject({ name: 'Candidate' }))
      .rejects.toThrow('staged mkdir rejected after creation');
    expect(repository.listProjects().map(project => project.name)).not.toContain('Candidate');
    expect((await fs.promises.readdir(path.join(root, 'projects'))).some(name => name.startsWith('.staging-')))
      .toBe(false);

    vi.restoreAllMocks();
    const restarted = await initialize();
    expect(restarted.diagnostics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'INCOMPLETE_PROJECT_STAGING' }),
    ]));
  });

  it('cleans and does not publish a staged Project after final directory rename failure', async () => {
    await initialize();
    const realRename = fs.promises.rename.bind(fs.promises);
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (path.dirname(from.toString()) === path.join(root, 'projects')
        && path.basename(from.toString()).startsWith('.staging-')) {
        throw new Error('staged rename failed');
      }
      await realRename(from, to);
    });
    await expect(repository.createProject({ name: 'Candidate' })).rejects.toThrow('staged rename failed');
    expect(repository.listProjects().map(project => project.name)).not.toContain('Candidate');
    expect((await fs.promises.readdir(path.join(root, 'projects'))).some(name => name.startsWith('.staging-')))
      .toBe(false);
  });

  it('persists active selection, checks workspace revisions, supports null clear, and rejects active deletion', async () => {
    await initialize();
    const selected = await repository.setActiveProject('prj_1', 0);
    expect(selected).toEqual({ schemaVersion: 4, activeProjectId: 'prj_1', revision: 1 });
    await expect(repository.setActiveProject(null, 0))
      .rejects.toMatchObject({ status: 409, code: 'REVISION_CONFLICT' });
    await expect(repository.deleteProject('prj_1', 1))
      .rejects.toMatchObject({ status: 409, code: 'ACTIVE_PROJECT' });
    expect((await initialize()).getWorkspaceState()).toEqual(selected);
    await repository.setActiveProject(null, 1);
    await repository.deleteProject('prj_1', 1);
    expect(repository.getWorkspaceState()).toEqual({ schemaVersion: 4, revision: 2 });
    expect((await fs.promises.readdir(path.join(root, 'trash')))[0]).toContain('prj_1');
  });

  it('serializes active selection with deletion so workspace cannot select a deleted Project', async () => {
    const realWriter = createAtomicFileWriter(nodeFileSystem);
    const workspaceWriteStarted = deferred();
    const releaseWorkspaceWrite = deferred();
    const atomicWriter: AtomicFileWriter = {
      ...realWriter,
      async writeJson(destination, value) {
        if (destination === path.join(root, 'workspace.json')) {
          workspaceWriteStarted.resolve();
          await releaseWorkspaceWrite.promise;
        }
        await realWriter.writeJson(destination, value);
      },
    };
    await initialize({ atomicWriter });
    const selection = repository.setActiveProject('prj_1', 0);
    await workspaceWriteStarted.promise;
    const deletion = repository.deleteProject('prj_1', 1);
    releaseWorkspaceWrite.resolve();
    await expect(selection).resolves.toMatchObject({ activeProjectId: 'prj_1' });
    await expect(deletion).rejects.toMatchObject({ status: 409, code: 'ACTIVE_PROJECT' });
    expect(repository.getProject('prj_1').id).toBe('prj_1');
  });

  it('preserves source storage and memory after a failed trash rename', async () => {
    await initialize();
    const realRename = fs.promises.rename.bind(fs.promises);
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (from.toString() === builder.projectDirectory()) throw new Error('trash rename failed');
      await realRename(from, to);
    });
    await expect(repository.deleteProject('prj_1', 1)).rejects.toThrow('trash rename failed');
    expect(repository.getProject('prj_1').id).toBe('prj_1');
    expect(await fs.promises.stat(builder.projectDirectory())).toSatisfy(stats => stats.isDirectory());
  });
});

describe('Body and static file delegation', () => {
  it('delegates immutable Body Asset put/get/open without inlining bytes in summaries', async () => {
    await initialize();
    const bytes = Buffer.from([0, 255, 1]);
    const asset = await repository.putBody(
      'prj_1', Readable.from(bytes), { mediaType: 'application/octet-stream' }, { maxBytes: 3 },
    );
    expect(await repository.getBody('prj_1', asset.id)).toEqual(asset);
    expect(await consume(repository.openBody('prj_1', asset.id))).toEqual(bytes);
    expect(JSON.stringify(repository.listEndpoints('prj_1'))).not.toContain(bytes.toString('hex'));
  });

  it('gets an unreferenced Body Asset through BodyStore after restart', async () => {
    const asset = await builder.writeBody(Buffer.from('unreferenced'));
    await initialize();
    expect(await repository.getBody('prj_1', asset.id)).toEqual(asset);
  });

  it('freshly detects Body Asset corruption after prior successful access', async () => {
    const bytes = Buffer.from('cached then corrupt');
    const asset = await builder.writeBody(bytes);
    await initialize();
    expect(await repository.getBody('prj_1', asset.id)).toEqual(asset);
    await fs.promises.writeFile(
      path.join(builder.projectDirectory(), 'bodies', 'sha256', asset.id.slice(0, 2), asset.id),
      'corrupt',
    );
    await expect(repository.getBody('prj_1', asset.id))
      .rejects.toMatchObject({ status: 422, code: 'ASSET_INTEGRITY_ERROR' });
  });

  it('atomically preserves exact binary and zero-byte static files across restart', async () => {
    await initialize();
    const bytes = Buffer.from([0, 255, 1, 254]);
    expect(await repository.putStaticFile('prj_1', 'posters\\home.bin', Readable.from(bytes), {
      mediaType: 'application/octet-stream', maxBytes: bytes.length,
    })).toEqual({ path: 'posters/home.bin', size: 4, mediaType: 'application/octet-stream' });
    await repository.putStaticFile('prj_1', 'empty.txt', Readable.from([]), {
      mediaType: 'text/plain', maxBytes: 0,
    });
    expect(await consume(repository.openStaticFile('prj_1', 'posters/home.bin'))).toEqual(bytes);
    await initialize();
    expect(repository.listStaticFiles('prj_1')).toEqual([
      { path: 'empty.txt', size: 0, mediaType: 'text/plain' },
      { path: 'posters/home.bin', size: 4, mediaType: 'application/octet-stream' },
    ]);
  });

  it('persists custom static media types in a reserved manifest across restart', async () => {
    await initialize();
    await repository.putStaticFile('prj_1', 'downloads/data.bin', Readable.from('value'), {
      mediaType: 'application/vnd.mockmate.fixture', maxBytes: 5,
    });
    await initialize();
    expect(repository.listStaticFiles('prj_1')).toEqual([{
      path: 'downloads/data.bin', size: 5, mediaType: 'application/vnd.mockmate.fixture',
    }]);
    expect(repository.listStaticFiles('prj_1').map(file => file.path)).not.toContain('.mockmate-static.json');
  });

  it('does not open an out-of-band file absent from committed static metadata', async () => {
    await initialize();
    await fs.promises.writeFile(path.join(builder.projectDirectory(), 'static', 'stray.bin'), 'stray');

    expect(repository.listStaticFiles('prj_1')).toEqual([]);
    await expect(consume(repository.openStaticFile('prj_1', 'stray.bin')))
      .rejects.toMatchObject({ status: 404, code: 'STATIC_FILE_NOT_FOUND' });
    expect(repository.listStaticFiles('prj_1')).toEqual([]);
  });

  it('rejects a size-changing replacement without changing committed list state', async () => {
    await initialize();
    await repository.putStaticFile('prj_1', 'file.bin', Readable.from('old'), {
      mediaType: 'application/original', maxBytes: 3,
    });
    await fs.promises.writeFile(path.join(builder.projectDirectory(), 'static', 'file.bin'), 'larger');

    expect(repository.listStaticFiles('prj_1')).toEqual([
      { path: 'file.bin', size: 3, mediaType: 'application/original' },
    ]);
    await expect(consume(repository.openStaticFile('prj_1', 'file.bin')))
      .rejects.toMatchObject({ status: 422, code: 'STATIC_FILE_INTEGRITY_ERROR' });
    expect(repository.listStaticFiles('prj_1')).toEqual([
      { path: 'file.bin', size: 3, mediaType: 'application/original' },
    ]);
  });

  it.each(['put', 'delete'] as const)(
    'keeps committed %s cleanup residue hidden and recovers it on restart',
    async operation => {
      await initialize();
      await repository.putStaticFile('prj_1', 'file.bin', Readable.from('old'), {
        mediaType: 'application/old', maxBytes: 3,
      });
      const realRm = fs.promises.rm.bind(fs.promises);
      const rm = vi.spyOn(fs.promises, 'rm').mockImplementation((target, options) => {
        if (target.toString().includes(`${path.sep}.mockmate-static-transactions${path.sep}committed-`)) {
          return Promise.reject(Object.assign(new Error('cleanup denied'), { code: 'EACCES' }));
        }
        return realRm(target, options);
      });

      if (operation === 'put') {
        await expect(repository.putStaticFile('prj_1', 'file.bin', Readable.from('new'), {
          mediaType: 'application/new', maxBytes: 3,
        })).resolves.toEqual({ path: 'file.bin', size: 3, mediaType: 'application/new' });
        expect(repository.listStaticFiles('prj_1')).toEqual([
          { path: 'file.bin', size: 3, mediaType: 'application/new' },
        ]);
      } else {
        await expect(repository.deleteStaticFile('prj_1', 'file.bin')).resolves.toBeUndefined();
        expect(repository.listStaticFiles('prj_1')).toEqual([]);
      }
      expect(await staticTransactionEntries()).toEqual([expect.stringMatching(/^committed-/)]);
      expect(repository.listStaticFiles('prj_1').some(file => file.path.includes('.mockmate-static'))).toBe(false);

      rm.mockRestore();
      await initialize();
      expect(await staticTransactionEntries()).toEqual([]);
      if (operation === 'put') {
        expect(await consume(repository.openStaticFile('prj_1', 'file.bin'))).toEqual(Buffer.from('new'));
        expect(repository.listStaticFiles('prj_1')).toEqual([
          { path: 'file.bin', size: 3, mediaType: 'application/new' },
        ]);
      } else {
        expect(repository.listStaticFiles('prj_1')).toEqual([]);
      }
    },
  );

  it('retains a pending put when manifest failure restore cannot unlink the destination', async () => {
    const realWriter = createAtomicFileWriter(nodeFileSystem);
    let failManifest = false;
    await initialize({
      atomicWriter: {
        ...realWriter,
        async writeJson(destination, value) {
          if (failManifest && destination.endsWith(`${path.sep}.mockmate-static.json`)) {
            throw new Error('manifest publication failed');
          }
          return realWriter.writeJson(destination, value);
        },
      },
    });
    failManifest = true;
    const destination = path.join(builder.projectDirectory(), 'static', 'new.bin');
    const realUnlink = fs.promises.unlink.bind(fs.promises);
    const unlink = vi.spyOn(fs.promises, 'unlink').mockImplementation(target => {
      if (target.toString() === destination) {
        return Promise.reject(Object.assign(new Error('unlink denied'), { code: 'EACCES' }));
      }
      return realUnlink(target);
    });
    await expect(repository.putStaticFile('prj_1', 'new.bin', Readable.from('new'), {
      mediaType: 'application/new', maxBytes: 3,
    })).rejects.toMatchObject({ status: 500, code: 'STATIC_TRANSACTION_INCOMPLETE' });
    expect(repository.listStaticFiles('prj_1')).toEqual([]);
    expect(await staticTransactionEntries()).toEqual([expect.stringMatching(/^pending-/)]);
    expect(await hasTransactionPointer()).toBe(true);

    unlink.mockRestore();
    await initialize();
    expect(repository.listStaticFiles('prj_1')).toEqual([]);
    expect(await staticTransactionEntries()).toEqual([]);
    expect(await hasTransactionPointer()).toBe(false);
    await expect(consume(repository.openStaticFile('prj_1', 'new.bin')))
      .rejects.toMatchObject({ status: 404, code: 'STATIC_FILE_NOT_FOUND' });
  });

  it('recovers a pending replacement before the next mutation after previous-content restore failure', async () => {
    const realWriter = createAtomicFileWriter(nodeFileSystem);
    let failManifest = false;
    await initialize({
      atomicWriter: {
        ...realWriter,
        async writeJson(destination, value) {
          if (failManifest && destination.endsWith(`${path.sep}.mockmate-static.json`)) {
            throw new Error('manifest publication failed');
          }
          return realWriter.writeJson(destination, value);
        },
      },
    });
    await repository.putStaticFile('prj_1', 'file.bin', Readable.from('old'), {
      mediaType: 'application/old', maxBytes: 3,
    });
    failManifest = true;
    const destination = path.join(builder.projectDirectory(), 'static', 'file.bin');
    const realRename = fs.promises.rename.bind(fs.promises);
    const rename = vi.spyOn(fs.promises, 'rename').mockImplementation((source, target) => {
      if (source.toString().endsWith(`${path.sep}previous`) && target.toString() === destination) {
        return Promise.reject(Object.assign(new Error('restore denied'), { code: 'EACCES' }));
      }
      return realRename(source, target);
    });
    await expect(repository.putStaticFile('prj_1', 'file.bin', Readable.from('new'), {
      mediaType: 'application/new', maxBytes: 3,
    })).rejects.toMatchObject({ status: 500, code: 'STATIC_TRANSACTION_INCOMPLETE' });
    expect(repository.listStaticFiles('prj_1')).toEqual([
      { path: 'file.bin', size: 3, mediaType: 'application/old' },
    ]);
    expect(await hasTransactionPointer()).toBe(true);
    rename.mockRestore();
    failManifest = false;

    await repository.putStaticFile('prj_1', 'other.bin', Readable.from('other'), {
      mediaType: 'application/other', maxBytes: 5,
    });
    expect(await consume(repository.openStaticFile('prj_1', 'file.bin'))).toEqual(Buffer.from('old'));
    expect(repository.listStaticFiles('prj_1')).toEqual([
      { path: 'file.bin', size: 3, mediaType: 'application/old' },
      { path: 'other.bin', size: 5, mediaType: 'application/other' },
    ]);
    expect(await staticTransactionEntries()).toEqual([]);
    expect(await hasTransactionPointer()).toBe(false);
  });

  it('recovers exact deleted bytes and media on restart after previous-content restore failure', async () => {
    const realWriter = createAtomicFileWriter(nodeFileSystem);
    let failManifest = false;
    await initialize({
      atomicWriter: {
        ...realWriter,
        async writeJson(destination, value) {
          if (failManifest && destination.endsWith(`${path.sep}.mockmate-static.json`)) {
            throw new Error('manifest publication failed');
          }
          return realWriter.writeJson(destination, value);
        },
      },
    });
    const bytes = Buffer.from([0, 255, 2]);
    await repository.putStaticFile('prj_1', 'file.bin', Readable.from(bytes), {
      mediaType: 'application/prior', maxBytes: bytes.length,
    });
    failManifest = true;
    const destination = path.join(builder.projectDirectory(), 'static', 'file.bin');
    const realRename = fs.promises.rename.bind(fs.promises);
    const rename = vi.spyOn(fs.promises, 'rename').mockImplementation((source, target) => {
      if (source.toString().endsWith(`${path.sep}previous`) && target.toString() === destination) {
        return Promise.reject(Object.assign(new Error('restore denied'), { code: 'EACCES' }));
      }
      return realRename(source, target);
    });
    await expect(repository.deleteStaticFile('prj_1', 'file.bin'))
      .rejects.toMatchObject({ status: 500, code: 'STATIC_TRANSACTION_INCOMPLETE' });
    expect(repository.listStaticFiles('prj_1')).toEqual([
      { path: 'file.bin', size: 3, mediaType: 'application/prior' },
    ]);
    rename.mockRestore();

    await initialize();
    expect(await consume(repository.openStaticFile('prj_1', 'file.bin'))).toEqual(bytes);
    expect(repository.listStaticFiles('prj_1')).toEqual([
      { path: 'file.bin', size: 3, mediaType: 'application/prior' },
    ]);
    expect(await staticTransactionEntries()).toEqual([]);
  });

  it('does not recover a genuine pending transaction through a nested symlink ancestor', async () => {
    const external = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mockmate-external-target-'));
    try {
      const { staticRoot, pendingDirectory } = await retainPendingNestedReplacement();
      const parent = path.join(staticRoot, 'link');
      await fs.promises.rm(parent, { recursive: true });
      await fs.promises.writeFile(path.join(external, 'victim.bin'), 'external');
      await fs.promises.symlink(external, parent);
      const externalBefore = await storageState(external);
      const previousBefore = await fs.promises.readFile(path.join(pendingDirectory, 'previous'));
      const journalBefore = await fs.promises.readFile(path.join(pendingDirectory, 'transaction.json'));
      const manifestPath = path.join(staticRoot, '.mockmate-static.json');
      const manifestBefore = await fs.promises.readFile(manifestPath);
      const pointerPath = path.join(staticRoot, STATIC_TRANSACTION_POINTER);
      const pointerBefore = await fs.promises.readFile(pointerPath);
      const target = path.join(parent, 'victim.bin');
      const targetMutations: string[] = [];
      const realUnlink = fs.promises.unlink.bind(fs.promises);
      const realRename = fs.promises.rename.bind(fs.promises);
      vi.spyOn(fs.promises, 'unlink').mockImplementation(filePath => {
        if (filePath.toString() === target) targetMutations.push('unlink');
        return realUnlink(filePath);
      });
      vi.spyOn(fs.promises, 'rename').mockImplementation((source, destination) => {
        if (destination.toString() === target) targetMutations.push('rename');
        return realRename(source, destination);
      });

      const result = await initialize();

      expect(result.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ projectId: 'prj_1', code: 'INVALID_STATIC_TRANSACTION' }),
      ]));
      expect(repository.listProjects()).toEqual([]);
      expect(targetMutations).toEqual([]);
      expect(await storageState(external)).toEqual(externalBefore);
      expect(await fs.promises.readFile(path.join(pendingDirectory, 'previous'))).toEqual(previousBefore);
      expect(await fs.promises.readFile(path.join(pendingDirectory, 'transaction.json'))).toEqual(journalBefore);
      expect(await fs.promises.readFile(manifestPath)).toEqual(manifestBefore);
      expect(await fs.promises.readFile(pointerPath)).toEqual(pointerBefore);
    } finally {
      await fs.promises.rm(external, { recursive: true, force: true });
    }
  });

  it('recreates safe missing parents while recovering a genuine pending transaction', async () => {
    const { staticRoot } = await retainPendingNestedReplacement();
    await fs.promises.rm(path.join(staticRoot, 'link'), { recursive: true });

    await initialize();

    expect(await consume(repository.openStaticFile('prj_1', 'link/victim.bin'))).toEqual(Buffer.from('old'));
    expect(repository.listStaticFiles('prj_1')).toEqual([
      { path: 'link/victim.bin', size: 3, mediaType: 'application/prior' },
    ]);
    expect(await staticTransactionEntries()).toEqual([]);
    expect(await hasTransactionPointer()).toBe(false);
  });

  it.each([
    ['put', 'root'],
    ['put', 'preparing'],
    ['delete', 'root'],
    ['delete', 'preparing'],
  ] as const)(
    'sanitizes first-use %s transaction %s mkdir failures without visible residue',
    async (operation, failurePoint) => {
      await initialize();
      if (operation === 'delete') {
        await repository.putStaticFile('prj_1', 'file.bin', Readable.from('old'), {
          mediaType: 'application/prior', maxBytes: 3,
        });
      }
      const transactionRoot = path.join(
        builder.projectDirectory(), 'static', '.mockmate-static-transactions',
      );
      await fs.promises.rm(transactionRoot, { recursive: true, force: true });
      const beforeList = repository.listStaticFiles('prj_1');
      const realMkdir = fs.promises.mkdir.bind(fs.promises);
      vi.spyOn(fs.promises, 'mkdir').mockImplementation(async (target, options) => {
        const targetPath = target.toString();
        if (failurePoint === 'root' && targetPath === transactionRoot) {
          throw Object.assign(new Error('/private/transaction/root denied'), { code: 'EACCES' });
        }
        if (failurePoint === 'preparing'
          && path.dirname(targetPath) === transactionRoot
          && path.basename(targetPath).startsWith('preparing-')) {
          await realMkdir(target, options as never);
          throw Object.assign(new Error('/private/preparing/path denied'), { code: 'EACCES' });
        }
        return realMkdir(target, options as never) as never;
      });

      let failure: unknown;
      try {
        if (operation === 'put') {
          await repository.putStaticFile('prj_1', 'file.bin', Readable.from('new'), {
            mediaType: 'application/new', maxBytes: 3,
          });
        } else {
          await repository.deleteStaticFile('prj_1', 'file.bin');
        }
      } catch (error) {
        failure = error;
      }

      expect(failure).toMatchObject({
        status: 500, code: 'STATIC_IO_ERROR', message: 'Static storage operation failed',
      });
      expect((failure as Error).message).not.toContain('/private/');
      expect(repository.listStaticFiles('prj_1')).toEqual(beforeList);
      expect(await staticTransactionEntries()).toEqual([]);
      expect(await hasTransactionPointer()).toBe(false);
      if (operation === 'delete') {
        expect(await consume(repository.openStaticFile('prj_1', 'file.bin'))).toEqual(Buffer.from('old'));
      }
    },
  );

  it('waits for static mutation ownership before opening committed bytes', async () => {
    const entered = deferred();
    const release = deferred();
    const realWriter = createAtomicFileWriter(nodeFileSystem);
    let blockManifest = false;
    await initialize({
      atomicWriter: {
        ...realWriter,
        async writeJson(destination, value) {
          if (blockManifest && destination.endsWith(`${path.sep}.mockmate-static.json`)) {
            entered.resolve();
            await release.promise;
          }
          return realWriter.writeJson(destination, value);
        },
      },
    });
    await repository.putStaticFile('prj_1', 'file.bin', Readable.from('old'), {
      mediaType: 'application/old', maxBytes: 3,
    });
    blockManifest = true;
    const mutation = repository.putStaticFile('prj_1', 'file.bin', Readable.from('new'), {
      mediaType: 'application/new', maxBytes: 3,
    });
    await entered.promise;
    const reading = consume(repository.openStaticFile('prj_1', 'file.bin'));
    let settled = false;
    void reading.finally(() => { settled = true; });
    await new Promise(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(repository.listStaticFiles('prj_1')).toEqual([
      { path: 'file.bin', size: 3, mediaType: 'application/old' },
    ]);
    release.resolve();
    await mutation;
    expect(await reading).toEqual(Buffer.from('new'));
  });

  it('acquires the static file handle before a later mutation can start', async () => {
    const realWriter = createAtomicFileWriter(nodeFileSystem);
    let trackMutation = false;
    let mutationStarted = false;
    await initialize({
      atomicWriter: {
        ...realWriter,
        async writeStream(destination, source, guard) {
          if (trackMutation && destination.endsWith(`${path.sep}next`)) mutationStarted = true;
          return realWriter.writeStream(destination, source, guard);
        },
      },
    });
    await repository.putStaticFile('prj_1', 'file.bin', Readable.from('old'), {
      mediaType: 'application/old', maxBytes: 3,
    });
    const target = path.join(builder.projectDirectory(), 'static', 'file.bin');
    const entered = deferred();
    const release = deferred();
    const realOpen = fs.promises.open.bind(fs.promises);
    const open = vi.spyOn(fs.promises, 'open').mockImplementation(async (filePath, flags, mode) => {
      if (filePath.toString() === target && typeof flags === 'number' && (flags & fs.constants.O_RDONLY) === 0) {
        entered.resolve();
        await release.promise;
      }
      return realOpen(filePath, flags, mode);
    });
    const reading = consume(repository.openStaticFile('prj_1', 'file.bin'));
    await entered.promise;
    trackMutation = true;
    const mutation = repository.putStaticFile('prj_1', 'file.bin', Readable.from('new'), {
      mediaType: 'application/new', maxBytes: 3,
    });
    let mutationSettled = false;
    void mutation.finally(() => { mutationSettled = true; });
    for (let attempt = 0; attempt < 20 && !mutationStarted; attempt += 1) {
      await new Promise(resolve => setImmediate(resolve));
    }
    const startedBeforeRelease = mutationStarted;
    const settledBeforeRelease = mutationSettled;
    expect(repository.listStaticFiles('prj_1')).toEqual([
      { path: 'file.bin', size: 3, mediaType: 'application/old' },
    ]);
    release.resolve();
    const bytes = await reading;
    await mutation;
    expect(startedBeforeRelease).toBe(false);
    expect(settledBeforeRelease).toBe(false);
    expect(bytes).toEqual(Buffer.from('old'));
    open.mockRestore();
  });

  it('cancels a static stream while it waits for mutation ownership', async () => {
    const entered = deferred();
    const release = deferred();
    const realWriter = createAtomicFileWriter(nodeFileSystem);
    let blockManifest = false;
    await initialize({
      atomicWriter: {
        ...realWriter,
        async writeJson(destination, value) {
          if (blockManifest && destination.endsWith(`${path.sep}.mockmate-static.json`)) {
            entered.resolve();
            await release.promise;
          }
          return realWriter.writeJson(destination, value);
        },
      },
    });
    await repository.putStaticFile('prj_1', 'file.bin', Readable.from('old'), {
      mediaType: 'application/old', maxBytes: 3,
    });
    blockManifest = true;
    const mutation = repository.putStaticFile('prj_1', 'file.bin', Readable.from('new'), {
      mediaType: 'application/new', maxBytes: 3,
    });
    await entered.promise;
    const open = vi.spyOn(fs.promises, 'open');
    const stream = repository.openStaticFile('prj_1', 'file.bin');
    const reading = consume(stream);
    await new Promise(resolve => setImmediate(resolve));
    stream.destroy(new Error('cancelled while waiting'));
    await expect(reading).rejects.toThrow('cancelled while waiting');
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
    release.resolve();
    await mutation;
  });

  it.each([
    '.mockmate-static-transaction.json',
    '.mockmate-static-transactions',
    '.mockmate-static-transactions/txn/previous',
  ])(
    'rejects reserved static transaction path %j',
    async relativePath => {
      await initialize();
      await expect(repository.putStaticFile('prj_1', relativePath, Readable.from('x'), {
        mediaType: 'text/plain', maxBytes: 1,
      })).rejects.toMatchObject({ status: 400, code: 'INVALID_STATIC_PATH' });
    },
  );

  it('never traverses or mutates an external tree through a symlinked static root', async () => {
    const external = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mockmate-external-static-'));
    try {
      const transactionId = 'fabricated';
      const transactionRoot = path.join(external, '.mockmate-static-transactions');
      const pending = path.join(transactionRoot, `pending-${transactionId}`);
      const after = {
        schemaVersion: 4,
        files: [{ path: 'outside.bin', size: 3, mediaType: 'application/external' }],
      };
      await fs.promises.mkdir(pending, { recursive: true });
      await fs.promises.writeFile(path.join(external, 'outside.bin'), 'new');
      await fs.promises.writeFile(path.join(external, '.mockmate-static.json'), JSON.stringify(after));
      await fs.promises.writeFile(path.join(pending, 'transaction.json'), JSON.stringify({
        schemaVersion: 4,
        transactionId,
        operation: 'put',
        path: 'outside.bin',
        before: { schemaVersion: 4, files: [] },
        after,
      }));
      const before = await storageState(external);
      const projectStatic = path.join(builder.projectDirectory(), 'static');
      await fs.promises.rm(projectStatic, { recursive: true });
      await fs.promises.symlink(external, projectStatic);
      const realReadFile = fs.promises.readFile.bind(fs.promises);
      const realReaddir = fs.promises.readdir.bind(fs.promises);
      const inspections: string[] = [];
      vi.spyOn(fs.promises, 'readFile').mockImplementation((target, options) => {
        if (target.toString().startsWith(`${projectStatic}${path.sep}`)) inspections.push(target.toString());
        return realReadFile(target, options as never) as never;
      });
      vi.spyOn(fs.promises, 'readdir').mockImplementation((target, options) => {
        if (target.toString().startsWith(`${projectStatic}${path.sep}`)) inspections.push(target.toString());
        return realReaddir(target, options as never) as never;
      });

      const result = await initialize();

      expect(result.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({
          projectId: 'prj_1', severity: 'blocking', code: 'INVALID_STATIC_FILE',
          file: 'projects/prj_1/static',
        }),
      ]));
      expect(JSON.stringify(result.diagnostics)).not.toContain(external);
      expect(repository.listProjects()).toEqual([]);
      expect(compile).not.toHaveBeenCalled();
      expect(inspections).toEqual([]);
      expect(await storageState(external)).toEqual(before);
    } finally {
      await fs.promises.rm(external, { recursive: true, force: true });
    }
  });

  it.each(['pending', 'preparing'] as const)(
    'does not mutate an unreferenced well-shaped %s transaction',
    async state => {
      const journal: TestStaticTransaction = {
        schemaVersion: 4,
        transactionId: 'stray',
        operation: 'put',
        path: 'stray.bin',
        before: { schemaVersion: 4, files: [] },
        after: {
          schemaVersion: 4,
          files: [{ path: 'stray.bin', size: 3, mediaType: 'application/stray' }],
        },
      };
      const staticRoot = path.join(builder.projectDirectory(), 'static');
      if (state === 'pending') {
        await fs.promises.writeFile(path.join(staticRoot, 'stray.bin'), 'new');
        await fs.promises.writeFile(path.join(staticRoot, '.mockmate-static.json'), JSON.stringify(journal.after));
      }
      await writeStaticTransactionState(state, journal);
      const before = await storageState(staticRoot);

      const result = await initialize();

      expect(result.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ projectId: 'prj_1', code: 'INVALID_STATIC_TRANSACTION' }),
      ]));
      expect(repository.listProjects()).toEqual([]);
      expect(await storageState(staticRoot)).toEqual(before);
    },
  );

  it.each(['malformed', 'stale', 'digest mismatch'] as const)(
    'does not mutate transaction state for a %s active pointer',
    async kind => {
      const journal: TestStaticTransaction = {
        schemaVersion: 4,
        transactionId: 'bound',
        operation: 'put',
        path: 'bound.bin',
        before: { schemaVersion: 4, files: [] },
        after: {
          schemaVersion: 4,
          files: [{ path: 'bound.bin', size: 3, mediaType: 'application/bound' }],
        },
      };
      const staticRoot = path.join(builder.projectDirectory(), 'static');
      await fs.promises.writeFile(path.join(staticRoot, 'bound.bin'), 'new');
      await fs.promises.writeFile(path.join(staticRoot, '.mockmate-static.json'), JSON.stringify(journal.after));
      await writeStaticTransactionState('pending', journal);
      await writeTransactionPointer(kind === 'malformed'
        ? { schemaVersion: 4 }
        : kind === 'stale'
          ? transactionPointer(journal, { transactionId: 'missing' })
          : transactionPointer(journal, { journalSha256: '0'.repeat(64) }));
      const before = await storageState(staticRoot);

      const result = await initialize();

      expect(result.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ projectId: 'prj_1', code: 'INVALID_STATIC_TRANSACTION' }),
      ]));
      expect(repository.listProjects()).toEqual([]);
      expect(await storageState(staticRoot)).toEqual(before);
    },
  );

  it('does not mutate either transaction when duplicate pending states exist', async () => {
    const first: TestStaticTransaction = {
      schemaVersion: 4,
      transactionId: 'first',
      operation: 'put',
      path: 'first.bin',
      before: { schemaVersion: 4, files: [] },
      after: {
        schemaVersion: 4,
        files: [{ path: 'first.bin', size: 3, mediaType: 'application/first' }],
      },
    };
    const second: TestStaticTransaction = {
      ...first,
      transactionId: 'second',
      path: 'second.bin',
      after: {
        schemaVersion: 4,
        files: [{ path: 'second.bin', size: 3, mediaType: 'application/second' }],
      },
    };
    await writeStaticTransactionState('pending', first);
    await writeStaticTransactionState('pending', second);
    await writeTransactionPointer(transactionPointer(first));
    const staticRoot = path.join(builder.projectDirectory(), 'static');
    const before = await storageState(staticRoot);

    const result = await initialize();

    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ projectId: 'prj_1', code: 'INVALID_STATIC_TRANSACTION' }),
    ]));
    expect(repository.listProjects()).toEqual([]);
    expect(await storageState(staticRoot)).toEqual(before);
  });

  it('accepts a pointer-bound committed after-state and only cleans reserved residue', async () => {
    const journal: TestStaticTransaction = {
      schemaVersion: 4,
      transactionId: 'committed',
      operation: 'put',
      path: 'committed.bin',
      before: { schemaVersion: 4, files: [] },
      after: {
        schemaVersion: 4,
        files: [{ path: 'committed.bin', size: 3, mediaType: 'application/committed' }],
      },
    };
    const staticRoot = path.join(builder.projectDirectory(), 'static');
    await fs.promises.writeFile(path.join(staticRoot, 'committed.bin'), 'new');
    await fs.promises.writeFile(path.join(staticRoot, '.mockmate-static.json'), JSON.stringify(journal.after));
    await writeStaticTransactionState('committed', journal);
    await writeTransactionPointer(transactionPointer(journal));

    await initialize();

    expect(repository.listStaticFiles('prj_1')).toEqual([
      { path: 'committed.bin', size: 3, mediaType: 'application/committed' },
    ]);
    expect(await consume(repository.openStaticFile('prj_1', 'committed.bin'))).toEqual(Buffer.from('new'));
    expect(await staticTransactionEntries()).toEqual([]);
    expect(await hasTransactionPointer()).toBe(false);
  });

  it('blocks malformed and symlinked static transaction trees without following them', async () => {
    const transactionRoot = path.join(
      builder.projectDirectory(), 'static', '.mockmate-static-transactions',
    );
    await fs.promises.mkdir(path.join(transactionRoot, 'pending-malformed'), { recursive: true });
    await fs.promises.writeFile(path.join(transactionRoot, 'pending-malformed', 'transaction.json'), '{}');
    await fs.promises.mkdir(path.join(transactionRoot, 'pending-unsafe'), { recursive: true });
    await fs.promises.writeFile(
      path.join(transactionRoot, 'pending-unsafe', 'transaction.json'),
      JSON.stringify({
        schemaVersion: 4,
        transactionId: 'unsafe',
        operation: 'put',
        path: '../escape',
        before: { schemaVersion: 4, files: [] },
        after: { schemaVersion: 4, files: [] },
      }),
    );
    await fs.promises.symlink(root, path.join(transactionRoot, 'committed-symlink'));
    const result = await initialize();
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ projectId: 'prj_1', code: 'INVALID_STATIC_TRANSACTION' }),
    ]));
    expect(repository.listProjects()).toEqual([]);
  });

  it('classifies manifest read failures as sanitized static I/O diagnostics', async () => {
    const manifest = path.join(builder.projectDirectory(), 'static', '.mockmate-static.json');
    const realReadFile = fs.promises.readFile.bind(fs.promises);
    vi.spyOn(fs.promises, 'readFile').mockImplementation((target, options) => {
      if (target.toString() === manifest) {
        return Promise.reject(Object.assign(new Error('private manifest path'), { code: 'EACCES' }));
      }
      return realReadFile(target, options as never) as never;
    });
    const result = await initialize();
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ projectId: 'prj_1', code: 'STATIC_IO_ERROR' }),
    ]));
    expect(result.diagnostics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ projectId: 'prj_1', code: 'INVALID_STATIC_METADATA' }),
    ]));
  });

  it.each([
    ['missing', async (staticRoot: string) => fs.promises.unlink(path.join(staticRoot, '.mockmate-static.json'))],
    ['malformed', async (staticRoot: string) => fs.promises.writeFile(
      path.join(staticRoot, '.mockmate-static.json'), '{',
    )],
    ['inconsistent', async (staticRoot: string) => fs.promises.writeFile(
      path.join(staticRoot, '.mockmate-static.json'),
      JSON.stringify({
        schemaVersion: 4,
        files: [{ path: 'missing.bin', size: 1, mediaType: 'application/octet-stream' }],
      }),
    )],
  ])('retains a blocking diagnostic for %s static metadata', async (_kind, mutate) => {
    const staticRoot = path.join(builder.projectDirectory(), 'static');
    await mutate(staticRoot);
    const result = await initialize();
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ projectId: 'prj_1', code: 'INVALID_STATIC_METADATA' }),
    ]));
    expect(repository.listProjects()).toEqual([]);
  });

  it('rejects ambiguous literal-backslash physical static paths during loading', async () => {
    const staticRoot = path.join(builder.projectDirectory(), 'static');
    await fs.promises.writeFile(path.join(staticRoot, 'nested\\file.txt'), 'value');
    await fs.promises.writeFile(path.join(staticRoot, '.mockmate-static.json'), JSON.stringify({
      schemaVersion: 4,
      files: [{ path: 'nested/file.txt', size: 5, mediaType: 'text/plain' }],
    }));
    const result = await initialize();
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ projectId: 'prj_1', code: 'INVALID_STATIC_METADATA' }),
    ]));
  });

  it('enforces static size limits and preserves an existing file on overflow', async () => {
    await initialize();
    await repository.putStaticFile('prj_1', 'file.bin', Readable.from('old'), {
      mediaType: 'application/octet-stream', maxBytes: 3,
    });
    await expect(repository.putStaticFile('prj_1', 'file.bin', Readable.from('toolarge'), {
      mediaType: 'application/octet-stream', maxBytes: 3,
    })).rejects.toMatchObject({ status: 413, code: 'STATIC_FILE_TOO_LARGE' });
    expect(await consume(repository.openStaticFile('prj_1', 'file.bin'))).toEqual(Buffer.from('old'));
  });

  it('preserves static disk and memory state after replacement publication failure', async () => {
    const realWriter = createAtomicFileWriter(nodeFileSystem);
    let failReplacement = false;
    const atomicWriter: AtomicFileWriter = {
      ...realWriter,
      async writeStream(destination, source, guard) {
        if (failReplacement && destination.endsWith(`${path.sep}next`)) {
          throw new Error('static replacement failed');
        }
        return realWriter.writeStream(destination, source, guard);
      },
    };
    await initialize({ atomicWriter });
    await repository.putStaticFile('prj_1', 'file.bin', Readable.from('old'), {
      mediaType: 'application/octet-stream', maxBytes: 3,
    });
    failReplacement = true;
    await expect(repository.putStaticFile('prj_1', 'file.bin', Readable.from('new'), {
      mediaType: 'text/plain', maxBytes: 3,
    })).rejects.toThrow('static replacement failed');
    expect(await consume(repository.openStaticFile('prj_1', 'file.bin'))).toEqual(Buffer.from('old'));
    expect(repository.listStaticFiles('prj_1')).toEqual([
      { path: 'file.bin', size: 3, mediaType: 'application/octet-stream' },
    ]);
  });

  it('restores prior static bytes and metadata when manifest publication fails', async () => {
    const realWriter = createAtomicFileWriter(nodeFileSystem);
    let failManifest = false;
    const atomicWriter: AtomicFileWriter = {
      ...realWriter,
      async writeJson(destination, value) {
        if (failManifest && destination.endsWith(`${path.sep}.mockmate-static.json`)) {
          throw new Error('manifest publication failed');
        }
        return realWriter.writeJson(destination, value);
      },
    };
    await initialize({ atomicWriter });
    await repository.putStaticFile('prj_1', 'file.bin', Readable.from('old'), {
      mediaType: 'application/old', maxBytes: 3,
    });
    failManifest = true;
    await expect(repository.putStaticFile('prj_1', 'file.bin', Readable.from('new'), {
      mediaType: 'application/new', maxBytes: 3,
    })).rejects.toThrow('manifest publication failed');
    expect(await consume(repository.openStaticFile('prj_1', 'file.bin'))).toEqual(Buffer.from('old'));
    expect(repository.listStaticFiles('prj_1')).toEqual([
      { path: 'file.bin', size: 3, mediaType: 'application/old' },
    ]);
  });

  it('restores a deleted static file when manifest publication fails', async () => {
    const realWriter = createAtomicFileWriter(nodeFileSystem);
    let failManifest = false;
    const atomicWriter: AtomicFileWriter = {
      ...realWriter,
      async writeJson(destination, value) {
        if (failManifest && destination.endsWith(`${path.sep}.mockmate-static.json`)) {
          throw new Error('manifest publication failed');
        }
        return realWriter.writeJson(destination, value);
      },
    };
    await initialize({ atomicWriter });
    await repository.putStaticFile('prj_1', 'file.bin', Readable.from('old'), {
      mediaType: 'application/old', maxBytes: 3,
    });
    failManifest = true;
    await expect(repository.deleteStaticFile('prj_1', 'file.bin'))
      .rejects.toThrow('manifest publication failed');
    expect(await consume(repository.openStaticFile('prj_1', 'file.bin'))).toEqual(Buffer.from('old'));
    expect(repository.listStaticFiles('prj_1')).toEqual([
      { path: 'file.bin', size: 3, mediaType: 'application/old' },
    ]);
  });

  it.each(['', '.', '../escape', '/absolute', 'C:\\absolute', 'a/../escape', 'nul\0file', '.mockmate-static.json'])(
    'rejects unsafe static path %j',
    async relativePath => {
      await initialize();
      await expect(repository.putStaticFile('prj_1', relativePath, Readable.from('x'), {
        mediaType: 'text/plain', maxBytes: 1,
      })).rejects.toMatchObject({ status: 400, code: 'INVALID_STATIC_PATH' });
    },
  );

  it('rejects static symlinks/special entries and returns structured missing read/delete errors', async () => {
    await initialize();
    const staticRoot = path.join(builder.projectDirectory(), 'static');
    await fs.promises.mkdir(staticRoot, { recursive: true });
    await fs.promises.symlink(root, path.join(staticRoot, 'link'));
    await expect(repository.putStaticFile('prj_1', 'link/escape', Readable.from('x'), {
      mediaType: 'text/plain', maxBytes: 1,
    })).rejects.toMatchObject({ code: 'INVALID_STATIC_PATH' });
    await expect(consume(repository.openStaticFile('prj_1', 'missing')))
      .rejects.toMatchObject({ status: 404, code: 'STATIC_FILE_NOT_FOUND' });
    await expect(repository.deleteStaticFile('prj_1', 'missing'))
      .rejects.toMatchObject({ status: 404, code: 'STATIC_FILE_NOT_FOUND' });
  });

  it.each(['put', 'open', 'delete'] as const)(
    'maps %s static filesystem failures to structured errors',
    async operation => {
      await initialize();
      if (operation !== 'put') {
        await repository.putStaticFile('prj_1', 'file.bin', Readable.from('x'), {
          mediaType: 'application/octet-stream', maxBytes: 1,
        });
      }
      const target = path.join(builder.projectDirectory(), 'static', 'file.bin');
      const realLstat = fs.promises.lstat.bind(fs.promises);
      vi.spyOn(fs.promises, 'lstat').mockImplementation(filePath => {
        if (filePath.toString() === target) {
          return Promise.reject(Object.assign(new Error('private detail'), { code: 'EACCES' }));
        }
        return realLstat(filePath);
      });
      const result = operation === 'put'
        ? repository.putStaticFile('prj_1', 'file.bin', Readable.from('x'), {
          mediaType: 'application/octet-stream', maxBytes: 1,
        })
        : operation === 'open'
          ? consume(repository.openStaticFile('prj_1', 'file.bin'))
          : repository.deleteStaticFile('prj_1', 'file.bin');
      await expect(result).rejects.toMatchObject({ status: 500, code: 'STATIC_IO_ERROR' });
      await expect(result).rejects.not.toThrow('private detail');
    },
  );

  it('deletes static files by normalized path', async () => {
    await initialize();
    await repository.putStaticFile('prj_1', 'nested/file.txt', Readable.from('value'), {
      mediaType: 'text/plain', maxBytes: 5,
    });
    await repository.deleteStaticFile('prj_1', 'nested\\file.txt');
    expect(repository.listStaticFiles('prj_1')).toEqual([]);
  });
});

describe('Project repository import preview and commit', () => {
  const tokenKey = Buffer.alloc(32, 6);
  const variableKey = Buffer.alloc(32, 7);

  async function initializeImport(
    overrides: Parameters<typeof initialize>[0] = {},
  ): Promise<ProjectRepository> {
    return initialize({
      importTokenKey: tokenKey,
      importVariableDigestKey: variableKey,
      ...overrides,
    });
  }

  it('previews statelessly and deterministically while variables resolve provisional members', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const atomicWriter = createAtomicFileWriter(nodeFileSystem);
    const bodyStore = createBodyStore({ rootDirectory: root, atomicWriter, fileSystem: nodeFileSystem });
    const beginImport = vi.spyOn(bodyStore, 'beginImport');
    await initializeImport({ bodyStore, atomicWriter });
    const before = await storageState();

    const first = repository.previewImport('prj_1', {
      source: { type: 'curl', text: "curl -X GET 'https://api.example.test/users'" },
    });
    const equivalent = repository.previewImport('prj_1', {
      source: { type: 'curl', text: 'curl --request GET https://api.example.test/users' },
    });
    const collection = importCollection([
      importItem('Tenant', 'https://{{tenant}}.example.test/users'),
    ]);
    const unresolved = repository.previewImport('prj_1', {
      source: { type: 'postman', collection },
    });
    const resolved = repository.previewImport('prj_1', {
      source: { type: 'postman', collection },
      variables: { tenant: 'one' },
    });

    expect(equivalent.items).toEqual(first.items);
    expect(equivalent.snapshotToken).toBe(first.snapshotToken);
    expect(unresolved).toMatchObject({
      items: [],
      unresolvedMembers: [{ name: 'Tenant' }],
      unresolvedVariables: [{ name: 'tenant' }],
    });
    expect(resolved).toMatchObject({
      unresolvedMembers: [],
      unresolvedVariables: [],
      items: [{ memberIds: [unresolved.unresolvedMembers[0].id] }],
    });
    expect(beginImport).not.toHaveBeenCalled();
    expect(await storageState()).toEqual(before);
  });

  it.each([
    ['changed source', (preview: ReturnType<ProjectRepository['previewImport']>, input: ImportPreviewRequest) => ({
      ...commitRequest(preview, input),
      source: { type: 'curl' as const, text: 'curl https://api.example.test/changed' },
    })],
    ['unknown selected ID', (preview: ReturnType<ProjectRepository['previewImport']>, input: ImportPreviewRequest) => ({
      ...commitRequest(preview, input), selectedItemIds: ['unknown'],
    })],
    ['duplicate selected ID', (preview: ReturnType<ProjectRepository['previewImport']>, input: ImportPreviewRequest) => {
      const request = commitRequest(preview, input);
      return { ...request, selectedItemIds: [...request.selectedItemIds, request.selectedItemIds[0]] };
    }],
    ['unknown action ID', (preview: ReturnType<ProjectRepository['previewImport']>, input: ImportPreviewRequest) => {
      const request = commitRequest(preview, input);
      return { ...request, actions: [{ ...request.actions[0], itemId: 'unknown' }] };
    }],
    ['duplicate action ID', (preview: ReturnType<ProjectRepository['previewImport']>, input: ImportPreviewRequest) => {
      const request = commitRequest(preview, input);
      return { ...request, actions: [...request.actions, request.actions[0]] };
    }],
    ['missing action', (preview: ReturnType<ProjectRepository['previewImport']>, input: ImportPreviewRequest) => ({
      ...commitRequest(preview, input), actions: [],
    })],
    ['extra action', (preview: ReturnType<ProjectRepository['previewImport']>, input: ImportPreviewRequest) => {
      const request = commitRequest(preview, input);
      return { ...request, selectedItemIds: [], actions: request.actions };
    }],
    ['disallowed merge', (preview: ReturnType<ProjectRepository['previewImport']>, input: ImportPreviewRequest) => {
      const request = commitRequest(preview, input);
      return { ...request, actions: [{ itemId: preview.items[0].id, action: 'merge' as const, endpointId: 'ep_1' }] };
    }],
    ['disallowed skip cardinality', (preview: ReturnType<ProjectRepository['previewImport']>, input: ImportPreviewRequest) => {
      const request = commitRequest(preview, input);
      return { ...request, actions: [{ itemId: preview.items[0].id, action: 'skip' as const }, ...request.actions] };
    }],
  ])('rejects %s as an invalid replay selection before staging', async (_name, mutate) => {
    const atomicWriter = createAtomicFileWriter(nodeFileSystem);
    const bodyStore = createBodyStore({ rootDirectory: root, atomicWriter, fileSystem: nodeFileSystem });
    const beginImport = vi.spyOn(bodyStore, 'beginImport');
    await initializeImport({ atomicWriter, bodyStore });
    const input: ImportPreviewRequest = {
      source: { type: 'curl', text: 'curl https://api.example.test/new' },
    };
    const preview = repository.previewImport('prj_1', input);

    await expect(repository.commitImport('prj_1', mutate(preview, input)))
      .rejects.toMatchObject({ status: 422, code: 'IMPORT_SELECTION_INVALID' });
    expect(beginImport).not.toHaveBeenCalled();
  });

  it('rejects changed variables, invalid selected items, stale targets, and overlap without confirmation', async () => {
    const overlapping = endpointRecord({
      id: 'ep_overlap',
      defaultVariantId: 'var_overlap',
      baseUrl: 'https://api.example.test',
      matcher: { method: 'GET', path: '/users/*a' },
      variants: [{
        id: 'var_overlap', endpointId: 'ep_overlap', name: 'Default', status: 200,
        responseHeaders: {}, revision: 0,
      }],
    });
    await builder.writeValid({ endpoints: [endpointRecord(), overlapping] });
    await initializeImport();

    const collection = importCollection([importItem('Variable', 'https://{{host}}/users')]);
    const variableInput: ImportPreviewRequest = {
      source: { type: 'postman', collection }, variables: { host: 'one.example.test' },
    };
    const variablePreview = repository.previewImport('prj_1', variableInput);
    await expect(repository.commitImport('prj_1', {
      ...commitRequest(variablePreview, variableInput), variables: { host: 'two.example.test' },
    })).rejects.toMatchObject({ code: 'IMPORT_SELECTION_INVALID' });

    const invalidInput: ImportPreviewRequest = {
      source: { type: 'curl', text: 'curl -X CONNECT https://api.example.test/tunnel' },
    };
    const invalidPreview = repository.previewImport('prj_1', invalidInput);
    await expect(repository.commitImport('prj_1', {
      ...commitRequest(invalidPreview, invalidInput, []),
      selectedItemIds: [invalidPreview.items[0].id],
      actions: [{ itemId: invalidPreview.items[0].id, action: 'skip' }],
    })).rejects.toMatchObject({ code: 'IMPORT_SELECTION_INVALID' });

    const exactInput: ImportPreviewRequest = {
      source: { type: 'curl', text: 'curl https://api.example.test/profile' },
    };
    const exactEndpoint = endpointRecord({ matcher: { method: 'GET', path: '/profile' } });
    await builder.writeGeneration({ generationId: 'gen_exact', endpoints: [exactEndpoint, overlapping] });
    await builder.writePointer('gen_exact');
    await repository.reloadProject('prj_1');
    const exactPreview = repository.previewImport('prj_1', exactInput);
    await expect(repository.commitImport('prj_1', {
      ...commitRequest(exactPreview, exactInput, []),
      selectedItemIds: [exactPreview.items[0].id],
      actions: [{ itemId: exactPreview.items[0].id, action: 'merge', endpointId: 'ep_overlap' }],
    })).rejects.toMatchObject({ code: 'IMPORT_SELECTION_INVALID' });

    const overlapInput: ImportPreviewRequest = {
      source: { type: 'curl', text: 'curl https://api.example.test/users/a*' },
    };
    const overlapPreview = repository.previewImport('prj_1', overlapInput);
    expect(overlapPreview.items[0].overlaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ confirmationRequired: true }),
    ]));
    await expect(repository.commitImport('prj_1', {
      ...commitRequest(overlapPreview, overlapInput),
      actions: [{ itemId: overlapPreview.items[0].id, action: 'create' }],
    })).rejects.toMatchObject({ code: 'IMPORT_SELECTION_INVALID' });
  });

  it('checks unresolved variables before selection and rejects empty or effective skip commits', async () => {
    await initializeImport();
    const unresolvedInput: ImportPreviewRequest = {
      source: {
        type: 'postman',
        collection: importCollection([importItem('Unresolved', 'https://{{host}}/users')]),
      },
    };
    const unresolved = repository.previewImport('prj_1', unresolvedInput);
    await expect(repository.commitImport('prj_1', {
      ...unresolvedInput,
      snapshotToken: unresolved.snapshotToken,
      selectedItemIds: ['unknown'],
      actions: [],
    })).rejects.toMatchObject({ status: 422, code: 'IMPORT_VARIABLES_REQUIRED' });

    const createInput: ImportPreviewRequest = {
      source: { type: 'curl', text: 'curl https://api.example.test/new' },
    };
    const createPreview = repository.previewImport('prj_1', createInput);
    await expect(repository.commitImport('prj_1', commitRequest(createPreview, createInput, [])))
      .rejects.toMatchObject({ status: 422, code: 'IMPORT_NO_CHANGES' });

    const exactInput: ImportPreviewRequest = {
      source: { type: 'curl', text: 'curl https://api.example.test/profile' },
    };
    await repository.updateEndpoint('prj_1', 'ep_1', 1, {
      matcher: { method: 'GET', path: '/profile' },
    });
    const exactPreview = repository.previewImport('prj_1', exactInput);
    await expect(repository.commitImport('prj_1', {
      ...commitRequest(exactPreview, exactInput, []),
      selectedItemIds: [exactPreview.items[0].id],
      actions: [{ itemId: exactPreview.items[0].id, action: 'merge', endpointId: 'ep_1' }],
    })).rejects.toMatchObject({ status: 422, code: 'IMPORT_NO_CHANGES' });
  });

  it('constructs one candidate with deterministic create, merge, fallback, revision, and skip semantics', async () => {
    const existing = endpointRecord({
      id: 'ep_existing',
      projectId: 'prj_1',
      matcher: { method: 'GET', path: '/profile' },
      defaultVariantId: 'var_fallback',
      revision: 8,
      variants: [
        {
          id: 'var_fallback', endpointId: 'ep_existing', name: 'Result', status: 200,
          responseHeaders: {}, revision: 4,
        },
        {
          id: 'var_existing', endpointId: 'ep_existing', name: 'RESULT (3)', status: 202,
          responseHeaders: {}, revision: 2,
        },
      ],
    });
    const project = projectRecord({ name: 'Untouched', revision: 11 });
    const settings = settingsRecord({ revision: 5, interceptHosts: ['keep.test'] });
    const state = stateRecord({ bindings: { ep_existing: 'var_fallback' }, revision: 6 });
    await builder.writeValid({
      generationId: 'gen_import',
      project,
      settings,
      endpoints: [existing],
      states: [state],
    });
    const ids = ['new', 'one', 'two', 'merged', 'generation'];
    let idIndex = 0;
    await initializeImport({ idSource: () => ids[idIndex++] });
    const beforeProject = repository.getProject('prj_1');
    const beforeSettings = repository.getRuntimeSettings('prj_1');
    const beforeState = repository.getState('prj_1', 'state_1');
    const beforeWorkspace = repository.getWorkspaceState();
    const input: ImportPreviewRequest = {
      source: {
        type: 'postman',
        collection: importCollection([
          importItem('Created endpoint', 'https://api.example.test/new', [
            savedResponse('First', 201, 'same'),
            savedResponse('first', 201, 'same'),
          ]),
          importItem('Merged endpoint', 'https://api.example.test/profile', [
            savedResponse('result', 201, 'merged'),
          ]),
          importItem('Unselected', 'https://api.example.test/unselected'),
          importItem('Explicit skip', 'https://api.example.test/explicit'),
          importItem('Invalid', 'https://api.example.test/invalid', [], 'CONNECT'),
        ]),
      },
    };
    const preview = repository.previewImport('prj_1', input);
    const [createdItem, mergedItem, unselectedItem, explicitItem, invalidItem] = preview.items;
    const request = commitRequest(preview, input, [
      { itemId: createdItem.id, action: 'create' },
      { itemId: mergedItem.id, action: 'merge', endpointId: 'ep_existing' },
      { itemId: explicitItem.id, action: 'skip' },
    ]);

    const result = await repository.commitImport('prj_1', request);

    expect(result).toEqual({
      createdEndpointIds: ['ep_new'],
      updatedEndpointIds: ['ep_existing'],
      createdVariantIds: ['var_one', 'var_two', 'var_merged'],
      skippedItemIds: [unselectedItem.id, explicitItem.id],
    });
    expect(result.createdEndpointIds[0]).not.toBe(createdItem.id);
    expect(result.createdVariantIds).not.toContain(createdItem.id);
    expect(result.skippedItemIds).not.toContain(invalidItem.id);
    expect(repository.getEndpoint('prj_1', 'ep_new')).toMatchObject({
      baseUrl: 'https://api.example.test',
      mode: 'mock',
      revision: 0,
      defaultVariantId: 'var_one',
      variants: [
        { id: 'var_one', name: 'First', revision: 0, bodyAssetId: expect.any(String) },
        { id: 'var_two', name: 'first (2)', revision: 0, bodyAssetId: expect.any(String) },
      ],
    });
    expect(repository.getEndpoint('prj_1', 'ep_existing')).toMatchObject({
      defaultVariantId: 'var_fallback',
      revision: 9,
      variants: [
        { id: 'var_fallback', revision: 4 },
        { id: 'var_existing', revision: 2 },
        { id: 'var_merged', name: 'result (2)', revision: 0 },
      ],
    });
    expect(repository.getProject('prj_1')).toEqual(beforeProject);
    expect(repository.getRuntimeSettings('prj_1')).toEqual(beforeSettings);
    expect(repository.getState('prj_1', 'state_1')).toEqual(beforeState);
    expect(repository.getWorkspaceState()).toEqual(beforeWorkspace);
  });

  it('publishes the exact previewed empty cURL fallback', async () => {
    const ids = ['empty', 'fallback', 'generation'];
    let index = 0;
    await initializeImport({ idSource: () => ids[index++] });
    const input: ImportPreviewRequest = {
      source: { type: 'curl', text: 'curl https://api.example.test/empty' },
    };
    const preview = repository.previewImport('prj_1', input);

    const result = await repository.commitImport('prj_1', commitRequest(preview, input));

    const endpoint = repository.getEndpoint('prj_1', result.createdEndpointIds[0]);
    expect(endpoint.variants).toEqual([{
      id: result.createdVariantIds[0],
      endpointId: endpoint.id,
      name: 'Default',
      status: 200,
      responseHeaders: {},
      revision: 0,
    }]);
    expect(preview.items[0].responses).toEqual([expect.objectContaining({
      name: 'Default', status: 200, responseHeaders: {}, body: { kind: 'none' },
    })]);
  });

  it('marks import-relevant mutation stale before target validation', async () => {
    await builder.writeValid({ endpoints: [endpointRecord({
      matcher: { method: 'GET', path: '/profile' },
    })] });
    await initializeImport();
    const input: ImportPreviewRequest = {
      source: {
        type: 'postman',
        collection: importCollection([importItem('Profile', 'https://api.example.test/profile', [
          savedResponse('Created', 201, 'new'),
        ])]),
      },
    };
    const preview = repository.previewImport('prj_1', input);
    await repository.updateVariant('prj_1', 'ep_1', 'var_1', 1, { status: 201 });

    await expect(repository.commitImport('prj_1', {
      ...commitRequest(preview, input),
      actions: [{ itemId: preview.items[0].id, action: 'merge', endpointId: 'not-previewed' }],
    })).rejects.toMatchObject({ status: 409, code: 'IMPORT_PREVIEW_STALE' });
  });

  it('reports a disappeared preview merge target as stale before action admissibility', async () => {
    await builder.writeValid({ endpoints: [endpointRecord({
      matcher: { method: 'GET', path: '/profile' },
    })] });
    await initializeImport();
    const input: ImportPreviewRequest = {
      source: {
        type: 'postman',
        collection: importCollection([importItem('Profile', 'https://api.example.test/profile', [
          savedResponse('Created', 201, 'new'),
        ])]),
      },
    };
    const preview = repository.previewImport('prj_1', input);
    const request = commitRequest(preview, input);
    await repository.updateEndpoint('prj_1', 'ep_1', 1, {
      matcher: { method: 'GET', path: '/moved' },
    });

    await expect(repository.commitImport('prj_1', request))
      .rejects.toMatchObject({ status: 409, code: 'IMPORT_PREVIEW_STALE' });
  });

  it.each([
    ['an invalid selected item', (
      preview: ReturnType<ProjectRepository['previewImport']>,
    ): ImportCommitRequest['actions'] => [{
      itemId: preview.items.find(item => item.errors.length > 0)!.id,
      action: 'skip',
    }]],
    ['a malformed action', (
      preview: ReturnType<ProjectRepository['previewImport']>,
    ): ImportCommitRequest['actions'] => [{
      itemId: preview.items.find(item => item.errors.length === 0)!.id,
      action: 'create',
      unexpected: true,
    } as unknown as ImportCommitRequest['actions'][number]]],
    ['a disallowed action', (
      preview: ReturnType<ProjectRepository['previewImport']>,
    ): ImportCommitRequest['actions'] => [{
      itemId: preview.items.find(item => item.errors.length === 0)!.id,
      action: 'merge',
      endpointId: 'ep_1',
    }]],
  ])('reports canonical staleness before rejecting %s', async (_name, actionsFor) => {
    await initializeImport();
    const input: ImportPreviewRequest = {
      source: {
        type: 'postman',
        collection: importCollection([
          importItem('Valid', 'https://api.example.test/new'),
          importItem('Invalid', 'https://api.example.test/invalid', [], 'CONNECT'),
        ]),
      },
    };
    const preview = repository.previewImport('prj_1', input);
    const actions = actionsFor(preview);
    const request = commitRequest(preview, input, actions);
    await repository.updateVariant('prj_1', 'ep_1', 'var_1', 1, { status: 201 });

    await expect(repository.commitImport('prj_1', request))
      .rejects.toMatchObject({ status: 409, code: 'IMPORT_PREVIEW_STALE' });
  });

  it('rejects a non-previewed merge target after a valid token', async () => {
    await builder.writeValid({ endpoints: [endpointRecord({
      matcher: { method: 'GET', path: '/profile' },
    })] });
    await initializeImport();
    const input: ImportPreviewRequest = {
      source: {
        type: 'postman',
        collection: importCollection([importItem('Profile', 'https://api.example.test/profile', [
          savedResponse('Created', 201, 'new'),
        ])]),
      },
    };
    const preview = repository.previewImport('prj_1', input);

    await expect(repository.commitImport('prj_1', {
      ...commitRequest(preview, input),
      actions: [{ itemId: preview.items[0].id, action: 'merge', endpointId: 'ep_other' }],
    })).rejects.toMatchObject({ status: 422, code: 'IMPORT_SELECTION_INVALID' });
  });

  it.each([
    ['App State bindings', async () => repository.updateState('prj_1', 'state_1', 1, { bindings: {} })],
    ['Project display', async () => repository.updateProject('prj_1', 1, { name: 'Renamed' })],
    ['workspace', async () => repository.setActiveProject('prj_1', 0)],
    ['settings', async () => repository.updateRuntimeSettings('prj_1', {
      interceptHosts: [], captureRawTraffic: true, debugProvenanceHeaders: false, expectedRevision: 1,
    })],
  ])('keeps a preview valid after %s changes', async (_name, mutate) => {
    await builder.writeValid({ endpoints: [endpointRecord({
      matcher: { method: 'GET', path: '/profile' },
    })] });
    await initializeImport();
    const input: ImportPreviewRequest = {
      source: {
        type: 'postman',
        collection: importCollection([importItem('Profile', 'https://api.example.test/profile', [
          savedResponse('Created', 201, 'new'),
        ])]),
      },
    };
    const preview = repository.previewImport('prj_1', input);
    await mutate();

    await expect(repository.commitImport('prj_1', commitRequest(preview, input)))
      .resolves.toMatchObject({ updatedEndpointIds: ['ep_1'] });
  });

  type CanonicalMutationContext = {
    endpoint: EndpointDetail;
    bodyAsset: BodyAsset;
    alternateBodyAsset: BodyAsset;
  };
  const canonicalMutations: Array<[
    string,
    (context: CanonicalMutationContext) => void,
  ]> = [
    ['Endpoint origin', ({ endpoint }) => { endpoint.baseUrl = 'https://api.example.test:8443'; }],
    ['Endpoint matcher', ({ endpoint }) => { endpoint.matcher.path = '/changed'; }],
    ['Endpoint repeated query', ({ endpoint }) => { endpoint.matcher.query = {
      a: [
        { operator: 'equals', value: '1' },
        { operator: 'equals', value: '1' },
      ],
    }; }],
    ['Endpoint name', ({ endpoint }) => { endpoint.name = 'Renamed endpoint'; }],
    ['Endpoint default', ({ endpoint }) => { endpoint.defaultVariantId = 'var_2'; }],
    ['Endpoint revision', ({ endpoint }) => { endpoint.revision += 1; }],
    ['Variant membership', ({ endpoint }) => { endpoint.variants.push({
      id: 'var_3', endpointId: endpoint.id, name: 'Third', status: 203,
      responseHeaders: {}, revision: 0,
    }); }],
    ['Variant name', ({ endpoint }) => { endpoint.variants[0].name = 'Renamed variant'; }],
    ['Variant status', ({ endpoint }) => { endpoint.variants[0].status = 202; }],
    ['Variant headers', ({ endpoint }) => { endpoint.variants[0].responseHeaders = { changed: 'yes' }; }],
    ['Variant body', ({ endpoint, alternateBodyAsset }) => {
      endpoint.variants[0].bodyAssetId = alternateBodyAsset.id;
    }],
    ['Variant revision', ({ endpoint }) => { endpoint.variants[0].revision += 1; }],
    ['Variant delay', ({ endpoint }) => { endpoint.variants[0].delayMs = 25; }],
    ['Body Asset immutable metadata', ({ bodyAsset }) => { bodyAsset.mediaType = 'text/plain'; }],
  ];

  it.each(canonicalMutations)('marks %s changes stale independently', async (_name, mutate) => {
    const bodyAsset = await builder.writeBody(Buffer.from('canonical-body'));
    const alternateBodyAsset = await builder.writeBody(Buffer.from('alternate-body'));
    const endpoint = endpointRecord({
      matcher: { method: 'GET', path: '/profile' },
      defaultVariantId: 'var_1',
      variants: [
        {
          id: 'var_1', endpointId: 'ep_1', name: 'Default', status: 200,
          responseHeaders: { original: 'yes' }, bodyAssetId: bodyAsset.id, revision: 1,
        },
        {
          id: 'var_2', endpointId: 'ep_1', name: 'Alternate', status: 201,
          responseHeaders: {}, revision: 2,
        },
      ],
    });
    await builder.writeValid({ endpoints: [endpoint] });
    await initializeImport();
    const input: ImportPreviewRequest = {
      source: {
        type: 'postman',
        collection: importCollection([importItem('Profile', 'https://api.example.test/profile', [
          savedResponse('Imported', 204, 'new'),
        ])]),
      },
    };
    const preview = repository.previewImport('prj_1', input);
    const changedEndpoint = structuredClone(endpoint);
    const changedBodyAsset = structuredClone(bodyAsset);
    mutate({ endpoint: changedEndpoint, bodyAsset: changedBodyAsset, alternateBodyAsset });
    const metadataPath = path.join(
      builder.projectDirectory(), 'bodies', 'sha256', bodyAsset.id.slice(0, 2), `${bodyAsset.id}.json`,
    );
    await fs.promises.writeFile(metadataPath, JSON.stringify(changedBodyAsset));
    await builder.writeGeneration({ generationId: 'gen_mutated', endpoints: [changedEndpoint] });
    await builder.writePointer('gen_mutated');
    await repository.reloadProject('prj_1');

    await expect(repository.commitImport('prj_1', commitRequest(preview, input)))
      .rejects.toMatchObject({ status: 409, code: 'IMPORT_PREVIEW_STALE' });
  });

  it.each([
    ['Endpoint allocation exhaustion', 1, () => () => '1'],
    ['Variant allocation exhaustion', 1, () => {
      let call = 0;
      return () => call++ === 0 ? 'fresh' : '1';
    }],
    ['candidate-wide Endpoint collision', 2, () => () => 'same'],
    ['candidate-wide Variant collision', 2, () => {
      const values = ['first', 'same', 'second'];
      let call = 0;
      return () => values[call++] ?? 'same';
    }],
  ] as const)('maps %s to ID_COLLISION without mutations', async (_name, itemCount, idSourceFactory) => {
    const atomicWriter = createAtomicFileWriter(nodeFileSystem);
    const bodyStore = createBodyStore({ rootDirectory: root, atomicWriter, fileSystem: nodeFileSystem });
    await initializeImport({ atomicWriter, bodyStore, idSource: idSourceFactory() });
    const input: ImportPreviewRequest = {
      source: {
        type: 'postman',
        collection: importCollection(Array.from({ length: itemCount }, (_, index) => (
          importItem(`Item ${index}`, `https://api.example.test/item-${index}`)
        ))),
      },
    };
    const preview = repository.previewImport('prj_1', input);
    const before = await storageState();

    await expect(repository.commitImport('prj_1', commitRequest(preview, input)))
      .rejects.toMatchObject({ status: 409, code: 'ID_COLLISION' });
    expect(repository.listEndpoints('prj_1').map(endpoint => endpoint.id)).toEqual(['ep_1']);
    expect(await storageState()).toEqual(before);
  });

  it('increments an existing Endpoint revision once for multiple merged additions', async () => {
    await builder.writeValid({ endpoints: [endpointRecord({
      matcher: { method: 'GET', path: '/profile' },
      revision: 7,
    })] });
    const ids = ['first', 'second', 'generation'];
    let index = 0;
    await initializeImport({ idSource: () => ids[index++] });
    const input: ImportPreviewRequest = {
      source: {
        type: 'postman',
        collection: importCollection([importItem('Profile', 'https://api.example.test/profile', [
          savedResponse('First', 201, 'one'),
          savedResponse('Second', 202, 'two'),
        ])]),
      },
    };
    const preview = repository.previewImport('prj_1', input);

    const result = await repository.commitImport('prj_1', commitRequest(preview, input));

    expect(result.createdVariantIds).toEqual(['var_first', 'var_second']);
    expect(repository.getEndpoint('prj_1', 'ep_1')).toMatchObject({
      revision: 8,
      variants: [{ id: 'var_1' }, { id: 'var_first' }, { id: 'var_second' }],
    });
  });

  it('merges into the canonical exact target', async () => {
    const matcher = { method: 'GET', path: '/profile' };
    const first = endpointRecord({ matcher });
    await builder.writeValid({ endpoints: [first] });
    const ids = ['merged', 'generation'];
    let index = 0;
    await initializeImport({ idSource: () => ids[index++] });
    const beforeFirst = repository.getEndpoint('prj_1', 'ep_1');
    const input: ImportPreviewRequest = {
      source: {
        type: 'postman',
        collection: importCollection([importItem('Profile', 'https://api.example.test/profile', [
          savedResponse('Imported', 204, 'new'),
        ])]),
      },
    };
    const preview = repository.previewImport('prj_1', input);
    expect(preview.items[0].exactTargets.map(target => target.endpointId)).toEqual(['ep_1']);

    const result = await repository.commitImport('prj_1', commitRequest(preview, input, [{
      itemId: preview.items[0].id, action: 'merge', endpointId: 'ep_1',
    }]));

    expect(result).toMatchObject({ updatedEndpointIds: ['ep_1'], createdVariantIds: ['var_merged'] });
    expect(repository.getEndpoint('prj_1', 'ep_1')).toMatchObject({
      revision: beforeFirst.revision + 1,
      variants: [{ id: 'var_1' }, { id: 'var_merged' }],
    });
  });

  it('publishes one multi-item create plus merge candidate exactly once in transaction order', async () => {
    await builder.writeValid({ endpoints: [endpointRecord({
      matcher: { method: 'GET', path: '/profile' },
      revision: 7,
    })] });
    const events: string[] = [];
    const realWriter = createAtomicFileWriter(nodeFileSystem);
    const realStore = createBodyStore({ rootDirectory: root, atomicWriter: realWriter, fileSystem: nodeFileSystem });
    let metadataValidations = 0;
    let promotions = 0;
    let completions = 0;
    let memoryPublications = 0;
    const bodyStore: BodyStore = {
      ...realStore,
      async beginImport(projectId) {
        const transaction = await realStore.beginImport(projectId);
        return {
          ...transaction,
          async getMetadata(assetId) {
            metadataValidations += 1;
            if (metadataValidations === 1) events.push('validate-staged-metadata');
            return transaction.getMetadata(assetId);
          },
          async promote() {
            promotions += 1;
            events.push('promote-assets');
            return transaction.promote();
          },
          async rollback() {
            events.push('rollback-assets');
            return transaction.rollback();
          },
          async complete() {
            expect(repository.getEndpoint('prj_1', 'ep_created')).toMatchObject({
              revision: 0,
              variants: [{ id: 'var_created', revision: 0 }],
            });
            expect(repository.getEndpoint('prj_1', 'ep_1')).toMatchObject({
              revision: 8,
              variants: [{ id: 'var_1' }, { id: 'var_merged', revision: 0 }],
            });
            memoryPublications += 1;
            events.push('publish-memory');
            completions += 1;
            events.push('complete-assets');
            await transaction.complete();
          },
        };
      },
    };
    const stagedGenerations = new Set<string>();
    let pointerPublications = 0;
    const atomicWriter: AtomicFileWriter = {
      ...realWriter,
      async writeJson(destination, value) {
        const stagingMarker = `${path.sep}generations${path.sep}.staging-`;
        const markerIndex = destination.indexOf(stagingMarker);
        if (markerIndex >= 0) {
          const relative = destination.slice(markerIndex + stagingMarker.length);
          const stagingRoot = destination.slice(0, markerIndex + stagingMarker.length)
            + relative.split(path.sep)[0];
          if (stagedGenerations.size === 0) events.push('write-generation');
          stagedGenerations.add(stagingRoot);
        }
        const result = await realWriter.writeJson(destination, value);
        if (destination === path.join(builder.projectDirectory(), 'current.json')) {
          pointerPublications += 1;
          events.push('publish-pointer');
        }
        return result;
      },
    };
    const generationRenames: Array<{ source: string; destination: string }> = [];
    let candidateCompilations = 0;
    const ids = ['created', 'created', 'merged', 'generation'];
    let index = 0;
    await initializeImport({
      atomicWriter,
      bodyStore,
      idSource: () => ids[index++],
      beforeCompile(snapshot) {
        if (snapshot.endpoints.has('ep_created')) {
          candidateCompilations += 1;
          events.push('compile-candidate');
        }
      },
    });
    const realRename = fs.promises.rename.bind(fs.promises);
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (source, destination) => {
      await realRename(source, destination);
      if (path.basename(source.toString()).startsWith('.staging-')
        && path.dirname(source.toString()).endsWith(`${path.sep}generations`)) {
        generationRenames.push({ source: source.toString(), destination: destination.toString() });
        events.push('rename-generation');
      }
    });
    const input: ImportPreviewRequest = {
      source: {
        type: 'postman',
        collection: importCollection([
          importItem('Created', 'https://api.example.test/created', [
            savedResponse('Created response', 201, 'created-body'),
          ]),
          importItem('Profile', 'https://api.example.test/profile', [
            savedResponse('Merged response', 202, 'merged-body'),
          ]),
        ]),
      },
    };
    const preview = repository.previewImport('prj_1', input);

    const result = await repository.commitImport('prj_1', commitRequest(preview, input));
    const pointerAfterCommit = await fs.promises.readFile(
      path.join(builder.projectDirectory(), 'current.json'),
    );
    await Promise.reject(new Error('simulated response failure')).catch(() => undefined);

    expect(events).toEqual([
      'validate-staged-metadata',
      'compile-candidate',
      'write-generation',
      'rename-generation',
      'promote-assets',
      'publish-pointer',
      'publish-memory',
      'complete-assets',
    ]);
    expect(events).not.toContain('rollback-assets');
    expect(result).toEqual({
      createdEndpointIds: ['ep_created'],
      updatedEndpointIds: ['ep_1'],
      createdVariantIds: ['var_created', 'var_merged'],
      skippedItemIds: [],
    });
    expect(candidateCompilations).toBe(1);
    expect(metadataValidations).toBe(2);
    expect(stagedGenerations.size).toBe(1);
    expect(generationRenames).toEqual([{
      source: [...stagedGenerations][0],
      destination: path.join(builder.projectDirectory(), 'generations', 'gen_generation'),
    }]);
    expect(pointerPublications).toBe(1);
    expect(memoryPublications).toBe(1);
    expect(promotions).toBe(1);
    expect(completions).toBe(1);
    expect(await fs.promises.readFile(path.join(builder.projectDirectory(), 'current.json')))
      .toEqual(pointerAfterCommit);
  });

  it('does not replace a published result or roll back assets when completion cleanup throws', async () => {
    const realWriter = createAtomicFileWriter(nodeFileSystem);
    const realStore = createBodyStore({ rootDirectory: root, atomicWriter: realWriter, fileSystem: nodeFileSystem });
    const rollback = vi.fn<BodyImportTransaction['rollback']>();
    const bodyStore: BodyStore = {
      ...realStore,
      async beginImport(projectId) {
        const transaction = await realStore.beginImport(projectId);
        rollback.mockImplementation(() => transaction.rollback());
        return {
          ...transaction,
          rollback,
          async complete() {
            await transaction.complete();
            throw new Error('post-pointer completion failed');
          },
        };
      },
    };
    const ids = ['endpoint', 'variant', 'generation'];
    let index = 0;
    await initializeImport({
      atomicWriter: realWriter,
      bodyStore,
      idSource: () => ids[index++],
    });
    const beforePointer = await fs.promises.readFile(
      path.join(builder.projectDirectory(), 'current.json'),
    );
    const input: ImportPreviewRequest = {
      source: {
        type: 'postman',
        collection: importCollection([importItem('Body', 'https://api.example.test/body', [
          savedResponse('Body', 200, 'bytes'),
        ])]),
      },
    };
    const preview = repository.previewImport('prj_1', input);

    await expect(repository.commitImport('prj_1', commitRequest(preview, input)))
      .resolves.toMatchObject({
        createdEndpointIds: ['ep_endpoint'],
        createdVariantIds: ['var_variant'],
      });

    expect(rollback).not.toHaveBeenCalled();
    expect(await fs.promises.readFile(path.join(builder.projectDirectory(), 'current.json')))
      .not.toEqual(beforePointer);
    expect(repository.getEndpoint('prj_1', 'ep_endpoint').id).toBe('ep_endpoint');
    expect(await fs.promises.readdir(path.join(builder.projectDirectory(), 'generations')))
      .toContain('gen_generation');
  });

  it('rolls back staged assets when candidate compilation fails before generation writes', async () => {
    const realWriter = createAtomicFileWriter(nodeFileSystem);
    const realStore = createBodyStore({ rootDirectory: root, atomicWriter: realWriter, fileSystem: nodeFileSystem });
    const rollback = vi.fn<BodyImportTransaction['rollback']>();
    const bodyStore: BodyStore = {
      ...realStore,
      async beginImport(projectId) {
        const transaction = await realStore.beginImport(projectId);
        rollback.mockImplementation(() => transaction.rollback());
        return { ...transaction, rollback };
      },
    };
    const ids = ['endpoint', 'variant', 'generation'];
    let index = 0;
    await initializeImport({
      atomicWriter: realWriter,
      bodyStore,
      idSource: () => ids[index++],
      beforeCompile(snapshot) {
        if (snapshot.endpoints.has('ep_endpoint')) throw new Error('candidate compile failed');
      },
    });
    const beforePointer = await fs.promises.readFile(
      path.join(builder.projectDirectory(), 'current.json'),
    );
    const input: ImportPreviewRequest = {
      source: {
        type: 'postman',
        collection: importCollection([importItem('Body', 'https://api.example.test/body', [
          savedResponse('Body', 200, 'bytes'),
        ])]),
      },
    };
    const preview = repository.previewImport('prj_1', input);

    await expect(repository.commitImport('prj_1', commitRequest(preview, input)))
      .rejects.toThrow('candidate compile failed');

    expect(rollback).toHaveBeenCalledTimes(1);
    expect(await fs.promises.readFile(path.join(builder.projectDirectory(), 'current.json')))
      .toEqual(beforePointer);
    expect(repository.listEndpoints('prj_1').map(endpoint => endpoint.id)).toEqual(['ep_1']);
  });

  it.each([
    ['candidate referential validation', false],
    ['body staging', false],
    ['generation writing', false],
    ['generation rename', false],
    ['body promotion', false],
    ['pointer publication', false],
    ['body staging with rollback cleanup failure', true],
  ] as const)('preserves import state when %s fails', async (boundary, rollbackFails) => {
    const deduplicatedBytes = Buffer.from('deduplicated-body');
    const operationBytes = Buffer.from('operation-owned-body');
    const deduplicatedAsset = await builder.writeBody(deduplicatedBytes);
    const operationAssetId = createHash('sha256').update(operationBytes).digest('hex');
    const operationFailure = new Error(`${boundary} failed`);
    const cleanupFailure = new Error('rollback cleanup failed');
    const finalGeneration = path.join(builder.projectDirectory(), 'generations', 'gen_generation');
    const generationCleanup = vi.fn<FileSystem['rm']>();
    const fileSystem: FileSystem = {
      ...nodeFileSystem,
      async rm(target, rmOptions) {
        if (target === finalGeneration) generationCleanup(target, rmOptions);
        return nodeFileSystem.rm(target, rmOptions);
      },
    };
    const realWriter = createAtomicFileWriter(nodeFileSystem);
    const atomicWriter: AtomicFileWriter = {
      ...realWriter,
      async writeJson(destination, value) {
        if (boundary === 'generation writing'
          && destination.includes(`${path.sep}generations${path.sep}.staging-`)) {
          throw operationFailure;
        }
        if (boundary === 'pointer publication'
          && destination === path.join(builder.projectDirectory(), 'current.json')) {
          throw operationFailure;
        }
        return realWriter.writeJson(destination, value);
      },
    };
    const realStore = createBodyStore({ rootDirectory: root, atomicWriter, fileSystem: nodeFileSystem });
    const rollback = vi.fn<BodyImportTransaction['rollback']>();
    const bodyStore: BodyStore = {
      ...realStore,
      async beginImport(projectId) {
        const transaction = await realStore.beginImport(projectId);
        rollback.mockImplementation(async () => {
          await transaction.rollback();
          if (rollbackFails) throw cleanupFailure;
        });
        return {
          ...transaction,
          async stage(bytes, metadata) {
            const asset = await transaction.stage(bytes, metadata);
            if ((boundary === 'body staging' || rollbackFails) && bytes.equals(operationBytes)) {
              throw operationFailure;
            }
            return asset;
          },
          async getMetadata(assetId) {
            if (boundary === 'candidate referential validation' && assetId === operationAssetId) {
              throw operationFailure;
            }
            return transaction.getMetadata(assetId);
          },
          async promote() {
            await transaction.promote();
            if (boundary === 'body promotion') throw operationFailure;
          },
          rollback,
        };
      },
    };
    const ids = ['endpoint', 'deduplicated', 'owned', 'generation'];
    let idIndex = 0;
    await initializeImport({
      atomicWriter,
      bodyStore,
      fileSystem,
      idSource: () => ids[idIndex++],
    });
    if (boundary === 'generation rename') {
      const realRename = fs.promises.rename.bind(fs.promises);
      vi.spyOn(fs.promises, 'rename').mockImplementation((source, destination) => {
        if (path.basename(source.toString()).startsWith('.staging-')
          && path.dirname(source.toString()).endsWith(`${path.sep}generations`)) {
          return Promise.reject(operationFailure);
        }
        return realRename(source, destination);
      });
    }
    const before = {
      project: repository.getProject('prj_1'),
      settings: repository.getRuntimeSettings('prj_1'),
      endpoints: repository.listEndpoints('prj_1').map(endpoint => repository.getEndpoint('prj_1', endpoint.id)),
      state: repository.getState('prj_1', 'state_1'),
      workspace: repository.getWorkspaceState(),
      pointer: await fs.promises.readFile(path.join(builder.projectDirectory(), 'current.json')),
      generations: (await fs.promises.readdir(path.join(builder.projectDirectory(), 'generations'))).sort(),
    };
    const input: ImportPreviewRequest = {
      source: {
        type: 'postman',
        collection: importCollection([importItem('Bodies', 'https://api.example.test/bodies', [
          savedResponse('Deduplicated', 200, deduplicatedBytes.toString()),
          savedResponse('Owned', 201, operationBytes.toString()),
        ])]),
      },
    };
    const preview = repository.previewImport('prj_1', input);

    const commit = repository.commitImport('prj_1', commitRequest(preview, input));
    if (boundary === 'candidate referential validation') {
      await expect(commit).rejects.toMatchObject({ status: 422, code: 'INVALID_PROJECT' });
    } else {
      await expect(commit).rejects.toBe(operationFailure);
    }

    expect(rollback).toHaveBeenCalledTimes(1);
    expect(repository.getProject('prj_1')).toEqual(before.project);
    expect(repository.getRuntimeSettings('prj_1')).toEqual(before.settings);
    expect(repository.listEndpoints('prj_1').map(endpoint => repository.getEndpoint('prj_1', endpoint.id)))
      .toEqual(before.endpoints);
    expect(repository.getState('prj_1', 'state_1')).toEqual(before.state);
    expect(repository.getWorkspaceState()).toEqual(before.workspace);
    expect(await fs.promises.readFile(path.join(builder.projectDirectory(), 'current.json')))
      .toEqual(before.pointer);
    expect((await fs.promises.readdir(path.join(builder.projectDirectory(), 'generations'))).sort())
      .toEqual(before.generations);
    expect(generationCleanup).toHaveBeenCalledTimes(
      boundary === 'body promotion' || boundary === 'pointer publication' ? 1 : 0,
    );
    expect(await repository.getBody('prj_1', deduplicatedAsset.id)).toEqual(deduplicatedAsset);
    expect(await consume(repository.openBody('prj_1', deduplicatedAsset.id))).toEqual(deduplicatedBytes);
    await expect(repository.getBody('prj_1', operationAssetId))
      .rejects.toMatchObject({ status: 404, code: 'BODY_ASSET_NOT_FOUND' });
  });

  it('preserves the operation error and rolls back bodies when final-generation cleanup fails', async () => {
    const operationBytes = Buffer.from('operation-owned-body');
    const operationAssetId = createHash('sha256').update(operationBytes).digest('hex');
    const operationFailure = new Error('body promotion failed');
    const cleanupFailure = new Error('final generation cleanup failed');
    const realWriter = createAtomicFileWriter(nodeFileSystem);
    const realStore = createBodyStore({ rootDirectory: root, atomicWriter: realWriter, fileSystem: nodeFileSystem });
    const rollback = vi.fn<BodyImportTransaction['rollback']>();
    const bodyStore: BodyStore = {
      ...realStore,
      async beginImport(projectId) {
        const transaction = await realStore.beginImport(projectId);
        rollback.mockImplementation(() => transaction.rollback());
        return {
          ...transaction,
          async promote() {
            await transaction.promote();
            throw operationFailure;
          },
          rollback,
        };
      },
    };
    const finalGeneration = path.join(builder.projectDirectory(), 'generations', 'gen_generation');
    const cleanup = vi.fn<FileSystem['rm']>();
    const fileSystem: FileSystem = {
      ...nodeFileSystem,
      async rm(target, rmOptions) {
        if (target === finalGeneration) {
          cleanup(target, rmOptions);
          throw cleanupFailure;
        }
        return nodeFileSystem.rm(target, rmOptions);
      },
    };
    const ids = ['endpoint', 'variant', 'generation'];
    let idIndex = 0;
    await initializeImport({
      atomicWriter: realWriter,
      bodyStore,
      fileSystem,
      idSource: () => ids[idIndex++],
    });
    const beforePointer = await fs.promises.readFile(path.join(builder.projectDirectory(), 'current.json'));
    const input: ImportPreviewRequest = {
      source: {
        type: 'postman',
        collection: importCollection([importItem('Body', 'https://api.example.test/body', [
          savedResponse('Body', 200, operationBytes.toString()),
        ])]),
      },
    };
    const preview = repository.previewImport('prj_1', input);

    await expect(repository.commitImport('prj_1', commitRequest(preview, input)))
      .rejects.toBe(operationFailure);

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(await fs.promises.readFile(path.join(builder.projectDirectory(), 'current.json')))
      .toEqual(beforePointer);
    expect(await fs.promises.readdir(finalGeneration)).not.toHaveLength(0);
    await expect(repository.getBody('prj_1', operationAssetId))
      .rejects.toMatchObject({ status: 404, code: 'BODY_ASSET_NOT_FOUND' });
  });
});
