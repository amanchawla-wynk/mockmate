import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable, Writable } from 'node:stream';

import type {
  AppState,
  BodyAsset,
  EndpointDetail,
  EndpointSummary,
  Project,
  ProjectRuntimeSettings,
} from '../domain/model';
import { normalizeHttpOrigin } from '../domain/http-origin';
import { createAtomicFileWriter } from '../repository/atomic-write';
import { createBodyStore } from '../repository/body-store';
import type { ResolvedMock } from '../repository/compile-project';
import { nodeFileSystem } from '../repository/file-system';
import {
  createProjectRepository,
  type ProjectRepository,
} from '../repository/project-repository';
import {
  writeResolvedResponse,
  type ResponseBodyRepository,
  type ResponseWriterTarget,
} from '../services/response-writer';

export const LARGE_PROJECT_SHAPE = {
  endpoints: 500,
  variantsPerEndpoint: 5,
  distinctBodies: 20,
  bodyBytes: 10 * 1024 * 1024,
} as const;

const FIXED_TIME = '2026-08-27T00:00:00.000Z';
const PERFORMANCE_ROOT_PREFIX = 'mockmate-performance-';

export function percentile95(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1];
}

export async function measureThirtyWarmRuns(
  run: () => unknown | Promise<unknown>,
): Promise<number[]> {
  await run();
  const durations: number[] = [];
  for (let index = 0; index < 30; index += 1) {
    const started = performance.now();
    await run();
    durations.push(performance.now() - started);
  }
  return durations;
}

export interface LargeProjectHarness {
  repository: ProjectRepository;
  smallBodySummaries: EndpointSummary[];
  largeBodySummaries: EndpointSummary[];
  fixtureEvidence: {
    smallBodyAssets: BodyAsset[];
    largeBodyAssets: BodyAsset[];
    fullState: AppState;
    partialState: AppState;
  };
  bodyAccess: { openReadStreamCalls: number; wholeBodyReadCalls: number };
  maximumObservedChunkBytes: number;
  consumeTenMiBResponseIntoCountingSink(): Promise<number>;
  exerciseWholeBodyReadControl(): Promise<void>;
  dispose(): Promise<void>;
}

interface CountingResponseTarget extends ResponseWriterTarget {
  readonly observedBytes: number;
  readonly maximumChunkBytes: number;
}

function createCountingResponseTarget(): CountingResponseTarget {
  let observedBytes = 0;
  let maximumChunkBytes = 0;
  const target = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      const chunkBytes = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
      observedBytes += chunkBytes;
      maximumChunkBytes = Math.max(maximumChunkBytes, chunkBytes);
      callback();
    },
  }) as CountingResponseTarget;
  Object.defineProperties(target, {
    observedBytes: { get: () => observedBytes },
    maximumChunkBytes: { get: () => maximumChunkBytes },
  });
  target.status = () => undefined;
  target.setHeader = () => undefined;
  return target;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, JSON.stringify(value));
}

function bodyPath(rootDirectory: string, projectId: string, assetId: string): string {
  return path.join(
    rootDirectory,
    'projects',
    projectId,
    'bodies',
    'sha256',
    assetId.slice(0, 2),
  );
}

async function writeBodies(
  rootDirectory: string,
  projectId: string,
  count: number,
  size: number,
): Promise<BodyAsset[]> {
  const assets: BodyAsset[] = [];
  for (let index = 0; index < count; index += 1) {
    const bytes = Buffer.alloc(size, index);
    const id = createHash('sha256').update(bytes).digest('hex');
    const asset: BodyAsset = {
      schemaVersion: 4,
      id,
      mediaType: 'application/octet-stream',
      size: bytes.length,
      createdAt: FIXED_TIME,
    };
    const directory = bodyPath(rootDirectory, projectId, id);
    await fs.promises.mkdir(directory, { recursive: true });
    await Promise.all([
      fs.promises.writeFile(path.join(directory, id), bytes),
      writeJson(path.join(directory, `${id}.json`), asset),
    ]);
    assets.push(asset);
  }
  return assets;
}

function createEndpoints(
  projectId: string,
  bodyIds: readonly string[],
  shape: typeof LARGE_PROJECT_SHAPE,
): EndpointDetail[] {
  return Array.from({ length: shape.endpoints }, (_, endpointIndex) => {
    const endpointSuffix = endpointIndex.toString().padStart(3, '0');
    const endpointId = `ep_${endpointSuffix}`;
    const variants = Array.from({ length: shape.variantsPerEndpoint }, (_, variantIndex) => ({
      id: `var_${endpointSuffix}_${variantIndex}`,
      endpointId,
      name: `Variant ${variantIndex}`,
      status: 200,
      responseHeaders: {},
      bodyAssetId: bodyIds[
        (endpointIndex * shape.variantsPerEndpoint + variantIndex) % bodyIds.length
      ],
      revision: 1,
    }));
    return {
      schemaVersion: 4,
      id: endpointId,
      projectId,
      name: `Endpoint ${endpointSuffix}`,
      baseUrl: 'http://api.test',
      matcher: {
        method: 'GET',
        path: endpointIndex === 0 ? '/playback/authorize' : `/fixture/${endpointSuffix}`,
      },
      mode: 'mock',
      defaultVariantId: variants[0].id,
      variants,
      revision: 1,
    };
  });
}

function createStates(projectId: string, endpoints: readonly EndpointDetail[]): AppState[] {
  return [
    {
      schemaVersion: 4,
      id: 'state_full',
      projectId,
      name: 'Full coverage',
      tags: ['performance'],
      bindings: Object.fromEntries(endpoints.map(endpoint => [endpoint.id, endpoint.variants[1].id])),
      revision: 1,
    },
    {
      schemaVersion: 4,
      id: 'state_partial',
      projectId,
      name: 'Partial coverage',
      tags: ['performance'],
      bindings: Object.fromEntries(endpoints
        .filter((_, index) => index % 2 === 0)
        .map(endpoint => [endpoint.id, endpoint.variants[2].id])),
      revision: 1,
    },
  ];
}

async function writeProject(
  rootDirectory: string,
  projectId: string,
  bodySize: number,
  shape: typeof LARGE_PROJECT_SHAPE,
): Promise<void> {
  const generationId = 'gen_performance';
  const generationDirectory = path.join(
    rootDirectory,
    'projects',
    projectId,
    'generations',
    generationId,
  );
  const assets = await writeBodies(rootDirectory, projectId, shape.distinctBodies, bodySize);
  const endpoints = createEndpoints(projectId, assets.map(asset => asset.id), shape);
  const project: Project = {
    schemaVersion: 4,
    id: projectId,
    name: 'Performance fixture',
    appStateMode: 'enabled',
    activeStateId: 'state_full',
    revision: 1,
    createdAt: FIXED_TIME,
    updatedAt: FIXED_TIME,
  };
  const settings: ProjectRuntimeSettings = {
    schemaVersion: 4,
    projectId,
    interceptHosts: [],
    captureRawTraffic: false,
    debugProvenanceHeaders: false,
    revision: 1,
  };

  await Promise.all([
    writeJson(path.join(generationDirectory, 'project.json'), project),
    writeJson(path.join(generationDirectory, 'settings.json'), settings),
    writeJson(path.join(rootDirectory, 'projects', projectId, 'current.json'), {
      schemaVersion: 4,
      generationId,
    }),
    writeJson(path.join(rootDirectory, 'projects', projectId, 'static', '.mockmate-static.json'), {
      schemaVersion: 4,
      files: [],
    }),
    ...endpoints.map(endpoint => writeJson(
      path.join(generationDirectory, 'endpoints', `${endpoint.id}.json`),
      endpoint,
    )),
    ...createStates(projectId, endpoints).map(state => writeJson(
      path.join(generationDirectory, 'states', `${state.id}.json`),
      state,
    )),
  ]);
}

async function removePerformanceRoot(rootDirectory: string): Promise<void> {
  if (!path.basename(rootDirectory).startsWith(PERFORMANCE_ROOT_PREFIX)) {
    throw new Error(`Refusing to remove unsafe performance root: ${rootDirectory}`);
  }
  await fs.promises.rm(rootDirectory, { recursive: true, force: true });
}

function requireResolved(value: ResolvedMock | null): ResolvedMock {
  if (!value?.bodyAssetId) throw new Error('Performance fixture did not resolve a body response');
  return value;
}

function resolvedTenMiBResponse(repository: ProjectRepository): ResolvedMock {
  const decision = repository.resolve('prj_large', {
    origin: normalizeHttpOrigin('http://api.test'),
    method: 'GET',
    path: '/playback/authorize',
    query: { ok: true, entries: [] },
    headers: {},
  });
  return requireResolved(decision?.kind === 'mock' ? decision.resolved : null);
}

async function loadBodyAssets(
  repository: ProjectRepository,
  projectId: string,
  summaries: readonly EndpointSummary[],
): Promise<BodyAsset[]> {
  const ids = new Set(summaries.flatMap(summary => repository
    .getEndpoint(projectId, summary.id)
    .variants
    .flatMap(variant => variant.bodyAssetId ?? [])));
  const assets: BodyAsset[] = [];
  for (const id of ids) assets.push(await repository.getBody(projectId, id));
  return assets;
}

export async function createLargeProject(
  shape: typeof LARGE_PROJECT_SHAPE,
): Promise<LargeProjectHarness> {
  const rootDirectory = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), PERFORMANCE_ROOT_PREFIX),
  );
  try {
    await writeJson(path.join(rootDirectory, 'workspace.json'), {
      schemaVersion: 4,
      activeProjectId: 'prj_large',
      revision: 1,
    });
    await writeProject(rootDirectory, 'prj_small', 1, shape);
    await writeProject(rootDirectory, 'prj_large', shape.bodyBytes, shape);

    const atomicWriter = createAtomicFileWriter(nodeFileSystem);
    const repository = createProjectRepository({
      rootDirectory,
      atomicWriter,
      bodyStore: createBodyStore({
        rootDirectory,
        atomicWriter,
        fileSystem: nodeFileSystem,
      }),
    });
    const diagnostics = await repository.initialize();
    if (diagnostics.diagnostics.length > 0) {
      throw new Error(`Performance fixture failed to initialize: ${JSON.stringify(diagnostics.diagnostics)}`);
    }

    const smallBodySummaries = repository.listEndpoints('prj_small');
    const largeBodySummaries = repository.listEndpoints('prj_large');
    const fixtureEvidence = {
      smallBodyAssets: await loadBodyAssets(repository, 'prj_small', smallBodySummaries),
      largeBodyAssets: await loadBodyAssets(repository, 'prj_large', largeBodySummaries),
      fullState: repository.getState('prj_large', 'state_full'),
      partialState: repository.getState('prj_large', 'state_partial'),
    };
    const bodyAccess = { openReadStreamCalls: 0, wholeBodyReadCalls: 0 };
    let maximumObservedChunkBytes = 0;
    let disposed = false;
    const getBody: ResponseBodyRepository['getBody'] = (...arguments_) => (
      repository.getBody(...arguments_)
    );
    const streamingBodies: ResponseBodyRepository = {
      getBody,
      openBody: (...arguments_: Parameters<ProjectRepository['openBody']>): Readable => {
        bodyAccess.openReadStreamCalls += 1;
        const source = repository.openBody(...arguments_);
        if (!(source instanceof Readable)) {
          throw new TypeError('Performance body source must be a Node.js Readable stream');
        }
        return source;
      },
    };
    const wholeBodyControl: ResponseBodyRepository = {
      getBody,
      openBody: (): Readable => {
        bodyAccess.wholeBodyReadCalls += 1;
        throw new Error('Whole-body reads are forbidden by the performance gate');
      },
    };

    return {
      repository,
      smallBodySummaries,
      largeBodySummaries,
      fixtureEvidence,
      bodyAccess,
      get maximumObservedChunkBytes() {
        return maximumObservedChunkBytes;
      },
      async consumeTenMiBResponseIntoCountingSink(): Promise<number> {
        const target = createCountingResponseTarget();
        await writeResolvedResponse(
          target,
          resolvedTenMiBResponse(repository),
          streamingBodies,
        );
        maximumObservedChunkBytes = Math.max(
          maximumObservedChunkBytes,
          target.maximumChunkBytes,
        );
        return target.observedBytes;
      },
      async exerciseWholeBodyReadControl(): Promise<void> {
        await writeResolvedResponse(
          createCountingResponseTarget(),
          resolvedTenMiBResponse(repository),
          wholeBodyControl,
        );
      },
      async dispose(): Promise<void> {
        if (disposed) return;
        await removePerformanceRoot(rootDirectory);
        disposed = true;
      },
    };
  } catch (error) {
    await removePerformanceRoot(rootDirectory);
    throw error;
  }
}
