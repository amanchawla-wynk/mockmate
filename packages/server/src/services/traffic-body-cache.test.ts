import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import { TRAFFIC_LIMITS, type TrafficBodyDescriptor } from '../domain/traffic';
import { nodeFileSystem, type FileSystem } from '../repository/file-system';
import { createTestStorageDirectory } from '../test-support/test-storage';
import { createTrafficBodyBudgetManager } from './traffic-body-budget';
import {
  createTrafficBodyCache,
  type TrafficBodyCache,
  type TrafficBodyCacheOptions,
  type TrafficBodyDescriptorPublication,
} from './traffic-body-cache';

const caches: TrafficBodyCache[] = [];
const roots: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.allSettled(caches.splice(0).map(cache => cache.dispose()));
  await Promise.all(roots.splice(0).map(root => fs.promises.rm(root, {
    recursive: true,
    force: true,
  })));
});

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>(settle => { resolve = settle; });
  return { promise, resolve };
}

async function consume(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function bodyPath(root: string, projectId: string, sha256: string): string {
  return path.join(
    root,
    'traffic-cache',
    'projects',
    projectId,
    'sha256',
    sha256.slice(0, 2),
    sha256,
  );
}

async function createCache(options: {
  runtimeNamespace?: string;
  root?: string;
  fileSystem?: FileSystem;
  projectRetainedBytes?: number;
  processRetainedBytes?: number;
  publishDescriptor?(publication: TrafficBodyDescriptorPublication): Promise<boolean> | boolean;
  onDescriptorPublicationError?(
    publication: TrafficBodyDescriptorPublication,
    error: unknown,
  ): Promise<void> | void;
  budgets?: ReturnType<typeof createTrafficBodyBudgetManager>;
} = {}): Promise<{
    cache: TrafficBodyCache;
    root: string;
    budgets: ReturnType<typeof createTrafficBodyBudgetManager>;
  }> {
  const root = options.root ?? await createTestStorageDirectory('traffic-cache-');
  if (!roots.includes(root)) roots.push(root);
  const budgets = options.budgets ?? createTrafficBodyBudgetManager({
    ...TRAFFIC_LIMITS,
    projectActiveSidecars: 16,
    processActiveSidecars: 32,
    projectTemporaryBytes: 64,
    processTemporaryBytes: 128,
    projectRetainedBytes: options.projectRetainedBytes ?? 6,
    processRetainedBytes: options.processRetainedBytes ?? 12,
  });
  const publicationOptions = options.publishDescriptor === undefined ? {} : {
    publishDescriptor: options.publishDescriptor,
    onDescriptorPublicationError: options.onDescriptorPublicationError ?? (() => {
      throw new Error('Unexpected descriptor publication failure');
    }),
  };
  const cache = createTrafficBodyCache({
    rootDirectory: root,
    runtimeNamespace: options.runtimeNamespace ?? `runtime_${caches.length}`,
    budgets,
    fileSystem: options.fileSystem ?? nodeFileSystem,
    ...publicationOptions,
  });
  caches.push(cache);
  await cache.initialize();
  return { cache, root, budgets };
}

async function finalize(
  cache: TrafficBodyCache,
  root: string,
  input: {
    bytes: Buffer;
    projectId?: string;
    trafficId?: string;
    generation?: string;
    side?: 'request' | 'response';
    sha256?: string;
    temporaryPath?: string;
  },
): Promise<TrafficBodyDescriptor> {
  const temporaryPath = input.temporaryPath ?? (input.bytes.length === 0
    ? undefined
    : path.join(root, 'traffic-cache', 'incoming', `.capture-${crypto.randomUUID()}`));
  if (temporaryPath !== undefined && input.temporaryPath === undefined) {
    await fs.promises.writeFile(temporaryPath, input.bytes);
  }
  return cache.finalize({
    projectId: input.projectId ?? 'prj_1',
    trafficId: input.trafficId ?? `traffic_${crypto.randomUUID()}`,
    generation: input.generation ?? `generation_${crypto.randomUUID()}`,
    side: input.side ?? 'response',
    ...(temporaryPath === undefined ? {} : { temporaryPath }),
    sha256: input.sha256 ?? digest(input.bytes),
    byteCount: input.bytes.length,
    mediaType: 'application/octet-stream',
  });
}

describe('Traffic body cache publication', () => {
  it('rejects a configured publisher without an error owner at construction', async () => {
    const root = await createTestStorageDirectory('traffic-cache-');
    roots.push(root);
    const options = {
      rootDirectory: root,
      runtimeNamespace: 'runtime_missing_publication_owner',
      budgets: createTrafficBodyBudgetManager(TRAFFIC_LIMITS),
      fileSystem: nodeFileSystem,
      publishDescriptor() {
        return true;
      },
    } as TrafficBodyCacheOptions;

    expect(() => createTrafficBodyCache(options))
      .toThrow('Traffic body descriptor publication error owner is required');
  });

  it('fsyncs and atomically publishes complete bytes before availability, then deduplicates', async () => {
    let syncCalls = 0;
    let linkCalls = 0;
    const fileSystem: FileSystem = {
      ...nodeFileSystem,
      async open(filePath, flags, mode) {
        const handle = await nodeFileSystem.open(filePath, flags, mode);
        return new Proxy(handle, {
          get(target, property, receiver) {
            if (property === 'sync') {
              return async () => {
                syncCalls += 1;
                await target.sync();
              };
            }
            const value = Reflect.get(target, property, receiver) as unknown;
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      },
      async link(existingPath, newPath) {
        linkCalls += 1;
        await nodeFileSystem.link(existingPath, newPath);
      },
    };
    const { cache, root, budgets } = await createCache({ fileSystem });
    const bytes = Buffer.from('exact');

    const first = await finalize(cache, root, {
      bytes,
      trafficId: 'traffic_1',
      generation: 'generation_1',
    });
    const second = await finalize(cache, root, {
      bytes,
      trafficId: 'traffic_2',
      generation: 'generation_2',
    });

    expect(first).toMatchObject({
      state: 'available',
      observedSize: bytes.length,
      retainedSize: bytes.length,
      sha256: digest(bytes),
    });
    expect(second).toEqual(first);
    expect(await fs.promises.readFile(bodyPath(root, 'prj_1', digest(bytes)))).toEqual(bytes);
    expect(linkCalls).toBe(2);
    expect(syncCalls).toBeGreaterThanOrEqual(3);
    expect(budgets.snapshot().retainedBytes).toBe(bytes.length);

    const firstLease = await cache.acquire('prj_1', 'traffic_1', 'generation_1', 'response');
    const secondLease = await cache.acquire('prj_1', 'traffic_2', 'generation_2', 'response');
    expect(await consume(firstLease!.openStream())).toEqual(bytes);
    expect(await consume(secondLease!.openStream())).toEqual(bytes);
    await firstLease!.release();
    await secondLease!.release();
  });

  it('evicts the oldest unleased Project reference and publishes an evicted descriptor', async () => {
    const publications: TrafficBodyDescriptorPublication[] = [];
    const { cache, root } = await createCache({
      publishDescriptor(publication) {
        publications.push(publication);
        return true;
      },
    });
    await finalize(cache, root, {
      bytes: Buffer.from('aaaa'),
      trafficId: 'traffic_oldest',
      generation: 'generation_oldest',
    });
    await finalize(cache, root, {
      bytes: Buffer.from('bb'),
      trafficId: 'traffic_newer',
      generation: 'generation_newer',
    });

    const newest = await finalize(cache, root, {
      bytes: Buffer.from('ccc'),
      trafficId: 'traffic_newest',
      generation: 'generation_newest',
    });

    expect(newest.state).toBe('available');
    expect(publications).toEqual([expect.objectContaining({
      projectId: 'prj_1',
      trafficId: 'traffic_oldest',
      generation: 'generation_oldest',
      descriptor: expect.objectContaining({ state: 'evicted', reason: 'retention_evicted' }),
    })]);
    expect(await cache.acquire('prj_1', 'traffic_oldest', 'generation_oldest', 'response'))
      .toBeUndefined();
    const remaining = await cache.acquire(
      'prj_1',
      'traffic_newer',
      'generation_newer',
      'response',
    );
    expect(remaining).toBeDefined();
    await remaining!.release();
  });

  it('publishes concurrent evictions in cache transition order without holding the state queue', async () => {
    const firstPublicationStarted = deferred();
    const secondPublicationStarted = deferred();
    const releaseFirstPublication = deferred();
    const publications: string[] = [];
    const { cache, root } = await createCache({
      projectRetainedBytes: 4,
      processRetainedBytes: 4,
      async publishDescriptor(publication) {
        publications.push(publication.trafficId);
        if (publication.trafficId === 'traffic_first') {
          firstPublicationStarted.resolve();
          await releaseFirstPublication.promise;
        }
        if (publication.trafficId === 'traffic_second') secondPublicationStarted.resolve();
        return true;
      },
    });
    await finalize(cache, root, {
      bytes: Buffer.from('aaaa'),
      trafficId: 'traffic_first',
      generation: 'generation_first',
    });

    const second = finalize(cache, root, {
      bytes: Buffer.from('bbbb'),
      trafficId: 'traffic_second',
      generation: 'generation_second',
    });
    await firstPublicationStarted.promise;
    const third = finalize(cache, root, {
      bytes: Buffer.from('cccc'),
      trafficId: 'traffic_third',
      generation: 'generation_third',
    });
    const overtook = await Promise.race([
      secondPublicationStarted.promise.then(() => true),
      new Promise<false>(resolve => setTimeout(() => resolve(false), 100)),
    ]);

    expect(overtook).toBe(false);
    expect(publications).toEqual(['traffic_first']);
    releaseFirstPublication.resolve();
    await Promise.all([second, third]);
    expect(publications).toEqual(['traffic_first', 'traffic_second']);
  });

  it('returns retained_budget_exceeded when every local candidate is leased and never evicts another Project', async () => {
    const publications: TrafficBodyDescriptorPublication[] = [];
    const { cache, root } = await createCache({
      publishDescriptor(publication) {
        publications.push(publication);
        return true;
      },
    });
    await finalize(cache, root, {
      bytes: Buffer.from('aaaaaa'),
      trafficId: 'traffic_leased',
      generation: 'generation_leased',
    });
    await finalize(cache, root, {
      bytes: Buffer.from('bbbbbb'),
      projectId: 'prj_2',
      trafficId: 'traffic_foreign',
      generation: 'generation_foreign',
    });
    const lease = await cache.acquire('prj_1', 'traffic_leased', 'generation_leased', 'response');

    const rejected = await finalize(cache, root, {
      bytes: Buffer.from('c'),
      trafficId: 'traffic_rejected',
      generation: 'generation_rejected',
    });

    expect(rejected).toMatchObject({
      state: 'unavailable',
      reason: 'retained_budget_exceeded',
      observedSize: 1,
    });
    expect(publications).toEqual([]);
    const foreign = await cache.acquire('prj_2', 'traffic_foreign', 'generation_foreign', 'response');
    expect(await consume(foreign!.openStream())).toEqual(Buffer.from('bbbbbb'));
    await foreign!.release();
    await lease!.release();
  });

  it('verifies temporary bytes before evicting existing retained evidence', async () => {
    const publications: TrafficBodyDescriptorPublication[] = [];
    const { cache, root } = await createCache({
      publishDescriptor(publication) {
        publications.push(publication);
        return true;
      },
    });
    const retained = Buffer.from('aaaaaa');
    await finalize(cache, root, {
      bytes: retained,
      trafficId: 'traffic_retained',
      generation: 'generation_retained',
    });
    const mismatched = Buffer.from('x');

    const descriptor = await finalize(cache, root, {
      bytes: mismatched,
      sha256: digest(Buffer.from('y')),
      trafficId: 'traffic_mismatched',
      generation: 'generation_mismatched',
    });

    expect(descriptor).toMatchObject({ state: 'unavailable', reason: 'capture_io_failed' });
    expect(publications).toEqual([]);
    const retainedLease = await cache.acquire(
      'prj_1',
      'traffic_retained',
      'generation_retained',
      'response',
    );
    expect(await consume(retainedLease!.openStream())).toEqual(retained);
    await retainedLease!.release();
  });

  it('removes a newly linked canonical file when durability sync fails', async () => {
    let failDirectorySync = false;
    const fileSystem: FileSystem = {
      ...nodeFileSystem,
      async open(filePath, flags, mode) {
        const handle = await nodeFileSystem.open(filePath, flags, mode);
        if (!failDirectorySync || path.basename(path.dirname(filePath)) !== 'sha256') return handle;
        const stats = await nodeFileSystem.lstat(filePath);
        if (!stats.isDirectory()) return handle;
        return new Proxy(handle, {
          get(target, property, receiver) {
            if (property === 'sync') {
              return async () => {
                const error = new Error('directory sync failed') as NodeJS.ErrnoException;
                error.code = 'EIO';
                throw error;
              };
            }
            const value = Reflect.get(target, property, receiver) as unknown;
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      },
    };
    const { cache, root, budgets } = await createCache({
      fileSystem,
      projectRetainedBytes: 20,
      processRetainedBytes: 20,
    });
    const bytes = Buffer.from('durable');
    failDirectorySync = true;

    const descriptor = await finalize(cache, root, {
      bytes,
      trafficId: 'traffic_sync_failure',
      generation: 'generation_sync_failure',
    });

    expect(descriptor).toMatchObject({ state: 'unavailable', reason: 'capture_io_failed' });
    await expect(fs.promises.stat(bodyPath(root, 'prj_1', digest(bytes))))
      .rejects.toMatchObject({ code: 'ENOENT' });
    expect(budgets.snapshot().retainedBytes).toBe(0);
  });

  it('closes the validated temporary handle when its second fstat and cleanup close fail', async () => {
    const publications: TrafficBodyDescriptorPublication[] = [];
    let failedHandle: fs.promises.FileHandle | undefined;
    let failedPath = '';
    let failedHandleCloseCalls = 0;
    let linkCalls = 0;
    const fileSystem: FileSystem = {
      ...nodeFileSystem,
      async open(filePath, flags, mode) {
        const handle = await nodeFileSystem.open(filePath, flags, mode);
        if (!path.basename(filePath).startsWith('.capture-')) return handle;
        let statCalls = 0;
        return new Proxy(handle, {
          get(target, property, receiver) {
            if (property === 'stat') {
              return async () => {
                statCalls += 1;
                if (statCalls === 2) {
                  failedHandle = target;
                  failedPath = filePath;
                  throw new Error(`second fstat failed ${filePath}`);
                }
                return target.stat();
              };
            }
            if (property === 'close') {
              return async () => {
                if (target === failedHandle) {
                  failedHandleCloseCalls += 1;
                  await target.close();
                  throw new Error(`cleanup close failed ${filePath}`);
                }
                await target.close();
              };
            }
            const value = Reflect.get(target, property, receiver) as unknown;
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      },
      async link(existingPath, newPath) {
        linkCalls += 1;
        await nodeFileSystem.link(existingPath, newPath);
      },
    };
    const { cache, root, budgets } = await createCache({
      fileSystem,
      projectRetainedBytes: 20,
      processRetainedBytes: 20,
      publishDescriptor(publication) {
        publications.push(publication);
        return true;
      },
    });
    const bytes = Buffer.from('second-fstat');

    const descriptor = await finalize(cache, root, {
      bytes,
      trafficId: 'traffic_second_fstat_failure',
      generation: 'generation_second_fstat_failure',
    });

    expect(descriptor).toMatchObject({ state: 'unavailable', reason: 'capture_io_failed' });
    expect(JSON.stringify(descriptor)).not.toContain(root);
    expect(failedPath).not.toBe('');
    expect(failedHandleCloseCalls).toBe(1);
    await expect(failedHandle!.stat()).rejects.toMatchObject({ code: 'EBADF' });
    await expect(fs.promises.stat(failedPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.promises.stat(bodyPath(root, 'prj_1', digest(bytes))))
      .rejects.toMatchObject({ code: 'ENOENT' });
    expect(linkCalls).toBe(0);
    expect(publications).toEqual([]);
    expect(budgets.snapshot()).toEqual({
      activeSidecars: 0,
      queuedBytes: 0,
      temporaryBytes: 0,
      retainedBytes: 0,
      runtimes: {},
    });
  });

  it.each([
    ['directory open', 'EISDIR'],
    ['directory sync', 'EINVAL'],
  ] as const)('continues when %s reports documented unsupported code %s', async (operation, code) => {
    const fileSystem: FileSystem = {
      ...nodeFileSystem,
      async open(filePath, flags, mode) {
        const stats = await nodeFileSystem.lstat(filePath);
        if (stats.isDirectory() && operation === 'directory open') {
          const error = new Error(`unsupported ${filePath}`) as NodeJS.ErrnoException;
          error.code = code;
          throw error;
        }
        const handle = await nodeFileSystem.open(filePath, flags, mode);
        if (!stats.isDirectory() || operation !== 'directory sync') return handle;
        return new Proxy(handle, {
          get(target, property, receiver) {
            if (property === 'sync') {
              return async () => {
                const error = new Error(`unsupported ${filePath}`) as NodeJS.ErrnoException;
                error.code = code;
                throw error;
              };
            }
            const value = Reflect.get(target, property, receiver) as unknown;
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      },
    };
    const { cache, root } = await createCache({ fileSystem });
    const bytes = Buffer.from('sync');

    await expect(finalize(cache, root, {
      bytes,
      trafficId: `traffic_${operation}`,
      generation: `generation_${operation}`,
    })).resolves.toMatchObject({ state: 'available', sha256: digest(bytes) });
  });

  it('never claims a source replacement linked before ownership correlation', async () => {
    const publications: TrafficBodyDescriptorPublication[] = [];
    const replacement = Buffer.from('evil');
    const fileSystem: FileSystem = {
      ...nodeFileSystem,
      async link(existingPath, newPath) {
        await nodeFileSystem.unlink(existingPath);
        await fs.promises.writeFile(existingPath, replacement);
        await nodeFileSystem.link(existingPath, newPath);
      },
    };
    const { cache, root, budgets } = await createCache({
      fileSystem,
      publishDescriptor(publication) {
        publications.push(publication);
        return true;
      },
    });
    const expected = Buffer.from('safe');

    await expect(finalize(cache, root, {
      bytes: expected,
      trafficId: 'traffic_leaf_race',
      generation: 'generation_leaf_race',
    })).resolves.toMatchObject({ state: 'unavailable', reason: 'capture_io_failed' });
    await expect(fs.promises.readFile(bodyPath(root, 'prj_1', digest(expected))))
      .resolves.toEqual(replacement);
    expect(publications).toEqual([]);
    expect(budgets.snapshot()).toEqual({
      activeSidecars: 0,
      queuedBytes: 0,
      temporaryBytes: 0,
      retainedBytes: 0,
      runtimes: {},
    });
  });

  it('owns and rolls back the canonical when the source path is replaced after linking', async () => {
    const publications: TrafficBodyDescriptorPublication[] = [];
    const sourceReplacement = Buffer.from('evil');
    const fileSystem: FileSystem = {
      ...nodeFileSystem,
      async link(existingPath, newPath) {
        await nodeFileSystem.link(existingPath, newPath);
        await nodeFileSystem.unlink(existingPath);
        await fs.promises.writeFile(existingPath, sourceReplacement);
      },
    };
    const { cache, root, budgets } = await createCache({
      fileSystem,
      publishDescriptor(publication) {
        publications.push(publication);
        return true;
      },
    });
    const expected = Buffer.from('safe');

    await expect(finalize(cache, root, {
      bytes: expected,
      trafficId: 'traffic_post_link_source_race',
      generation: 'generation_post_link_source_race',
    })).resolves.toMatchObject({ state: 'unavailable', reason: 'capture_io_failed' });

    await expect(fs.promises.stat(bodyPath(root, 'prj_1', digest(expected))))
      .rejects.toMatchObject({ code: 'ENOENT' });
    expect(publications).toEqual([]);
    expect(budgets.snapshot()).toEqual({
      activeSidecars: 0,
      queuedBytes: 0,
      temporaryBytes: 0,
      retainedBytes: 0,
      runtimes: {},
    });
  });

  it('never unlinks a foreign canonical replacement installed before post-link open', async () => {
    const publications: TrafficBodyDescriptorPublication[] = [];
    const foreign = Buffer.from('evil');
    let replacedCanonicalPath = '';
    const fileSystem: FileSystem = {
      ...nodeFileSystem,
      async link(existingPath, newPath) {
        await nodeFileSystem.link(existingPath, newPath);
        await nodeFileSystem.unlink(newPath);
        await fs.promises.writeFile(newPath, foreign);
        replacedCanonicalPath = newPath;
      },
    };
    const { cache, root, budgets } = await createCache({
      fileSystem,
      publishDescriptor(publication) {
        publications.push(publication);
        return true;
      },
    });
    const expected = Buffer.from('safe');

    await expect(finalize(cache, root, {
      bytes: expected,
      trafficId: 'traffic_post_link_destination_race',
      generation: 'generation_post_link_destination_race',
    })).resolves.toMatchObject({ state: 'unavailable', reason: 'capture_io_failed' });

    expect(replacedCanonicalPath).toBe(bodyPath(root, 'prj_1', digest(expected)));
    await expect(fs.promises.readFile(replacedCanonicalPath)).resolves.toEqual(foreign);
    expect(publications).toEqual([]);
    expect(budgets.snapshot()).toEqual({
      activeSidecars: 0,
      queuedBytes: 0,
      temporaryBytes: 0,
      retainedBytes: 0,
      runtimes: {},
    });
  });

  it('rolls back a new canonical after one-shot post-link identity acquisition failure', async () => {
    let linkedPath = '';
    let failNextLinkedLstat = true;
    const fileSystem: FileSystem = {
      ...nodeFileSystem,
      async link(existingPath, newPath) {
        await nodeFileSystem.link(existingPath, newPath);
        linkedPath = newPath;
      },
      async lstat(filePath) {
        if (failNextLinkedLstat && filePath === linkedPath) {
          failNextLinkedLstat = false;
          const error = new Error(`post-link lstat failed ${filePath}`) as NodeJS.ErrnoException;
          error.code = 'EIO';
          throw error;
        }
        return nodeFileSystem.lstat(filePath);
      },
    };
    const { cache, root, budgets } = await createCache({ fileSystem });
    const bytes = Buffer.from('linked');

    await expect(finalize(cache, root, {
      bytes,
      trafficId: 'traffic_post_link_lstat',
      generation: 'generation_post_link_lstat',
    })).resolves.toMatchObject({ state: 'unavailable', reason: 'capture_io_failed' });

    await expect(fs.promises.stat(bodyPath(root, 'prj_1', digest(bytes))))
      .rejects.toMatchObject({ code: 'ENOENT' });
    expect(budgets.snapshot()).toEqual({
      activeSidecars: 0,
      queuedBytes: 0,
      temporaryBytes: 0,
      retainedBytes: 0,
      runtimes: {},
    });
  });

  it('retains conservative cleanup ownership when post-link identity remains unavailable', async () => {
    let linkedPath = '';
    let blockLinkedLstat = true;
    const fileSystem: FileSystem = {
      ...nodeFileSystem,
      async link(existingPath, newPath) {
        await nodeFileSystem.link(existingPath, newPath);
        linkedPath = newPath;
      },
      async lstat(filePath) {
        if (blockLinkedLstat && filePath === linkedPath) {
          const error = new Error(`post-link identity unavailable ${filePath}`) as NodeJS.ErrnoException;
          error.code = 'EIO';
          throw error;
        }
        return nodeFileSystem.lstat(filePath);
      },
    };
    const { cache, root, budgets } = await createCache({ fileSystem });
    const bytes = Buffer.from('owned');

    await expect(finalize(cache, root, {
      bytes,
      trafficId: 'traffic_post_link_owned',
      generation: 'generation_post_link_owned',
    })).resolves.toMatchObject({ state: 'unavailable', reason: 'capture_io_failed' });

    await expect(fs.promises.readFile(bodyPath(root, 'prj_1', digest(bytes))))
      .resolves.toEqual(bytes);
    expect(budgets.snapshot().retainedBytes).toBe(bytes.length);
    blockLinkedLstat = false;
    await expect(cache.clearProject('prj_1')).resolves.toBeUndefined();
    expect(budgets.snapshot().retainedBytes).toBe(0);
    await expect(fs.promises.stat(bodyPath(root, 'prj_1', digest(bytes))))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retains conservative ownership when the linked source name disappears before correlation', async () => {
    const fileSystem: FileSystem = {
      ...nodeFileSystem,
      async link(existingPath, newPath) {
        await nodeFileSystem.link(existingPath, newPath);
        await nodeFileSystem.unlink(existingPath);
      },
    };
    const { cache, root, budgets } = await createCache({ fileSystem });
    const bytes = Buffer.from('source');

    await expect(finalize(cache, root, {
      bytes,
      trafficId: 'traffic_linked_source_missing',
      generation: 'generation_linked_source_missing',
    })).resolves.toMatchObject({ state: 'unavailable', reason: 'capture_io_failed' });

    await expect(fs.promises.readFile(bodyPath(root, 'prj_1', digest(bytes))))
      .resolves.toEqual(bytes);
    expect(budgets.snapshot().retainedBytes).toBe(bytes.length);
    const error = await cache.clearProject('prj_1').then(
      () => undefined,
      failure => failure as Error,
    );
    expect(error?.message).toBe('Traffic body cache integrity check failed');
    expect(error?.message).not.toContain(root);
    await cache.dispose();
    expect(budgets.snapshot().retainedBytes).toBe(0);
  });

  it('never claims or unlinks a pre-existing canonical when collision validation fails', async () => {
    let failCollisionLstat = false;
    let collisionPath = '';
    const fileSystem: FileSystem = {
      ...nodeFileSystem,
      async lstat(filePath) {
        if (failCollisionLstat && filePath === collisionPath) {
          failCollisionLstat = false;
          const error = new Error(`collision lstat failed ${filePath}`) as NodeJS.ErrnoException;
          error.code = 'EIO';
          throw error;
        }
        return nodeFileSystem.lstat(filePath);
      },
    };
    const { cache, root, budgets } = await createCache({ fileSystem });
    const expected = Buffer.from('expect');
    const foreign = Buffer.from('evil');
    collisionPath = bodyPath(root, 'prj_1', digest(expected));
    await fs.promises.mkdir(path.dirname(collisionPath), { recursive: true });
    await fs.promises.writeFile(collisionPath, foreign);
    failCollisionLstat = true;

    await expect(finalize(cache, root, {
      bytes: expected,
      trafficId: 'traffic_collision_foreign',
      generation: 'generation_collision_foreign',
    })).resolves.toMatchObject({ state: 'unavailable', reason: 'capture_io_failed' });

    await expect(fs.promises.readFile(collisionPath)).resolves.toEqual(foreign);
    expect(budgets.snapshot().retainedBytes).toBe(0);
  });

  it('represents a verified zero-byte body without creating a file', async () => {
    const { cache, root, budgets } = await createCache();

    const descriptor = await finalize(cache, root, {
      bytes: Buffer.alloc(0),
      trafficId: 'traffic_empty',
      generation: 'generation_empty',
    });
    const lease = await cache.acquire('prj_1', 'traffic_empty', 'generation_empty', 'response');

    expect(descriptor).toMatchObject({
      state: 'available',
      sha256: digest(Buffer.alloc(0)),
      retainedSize: 0,
    });
    expect(await consume(lease!.openStream())).toEqual(Buffer.alloc(0));
    expect(budgets.snapshot().retainedBytes).toBe(0);
    await expect(fs.promises.stat(bodyPath(root, 'prj_1', digest(Buffer.alloc(0)))))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await lease!.release();

    await expect(finalize(cache, root, {
      bytes: Buffer.alloc(0),
      sha256: 'a'.repeat(64),
      trafficId: 'traffic_false_empty',
      generation: 'generation_false_empty',
    })).resolves.toMatchObject({ state: 'unavailable', reason: 'capture_io_failed' });
  });
});

describe('Traffic body cache leases and lifecycle', () => {
  it('clear tombstones references immediately while a digest lease keeps bytes alive', async () => {
    const { cache, root, budgets } = await createCache();
    const bytes = Buffer.from('leased');
    await finalize(cache, root, {
      bytes,
      trafficId: 'traffic_1',
      generation: 'generation_1',
    });
    const lease = await cache.acquire('prj_1', 'traffic_1', 'generation_1', 'response');

    await expect(cache.clearProject('prj_1')).resolves.toBeUndefined();
    expect(await cache.acquire('prj_1', 'traffic_1', 'generation_1', 'response'))
      .toBeUndefined();
    expect(await consume(lease!.openStream())).toEqual(bytes);
    expect(await fs.promises.readFile(bodyPath(root, 'prj_1', digest(bytes)))).toEqual(bytes);

    await lease!.release();
    await lease!.release();
    await expect(fs.promises.stat(bodyPath(root, 'prj_1', digest(bytes))))
      .rejects.toMatchObject({ code: 'ENOENT' });
    expect(budgets.snapshot().retainedBytes).toBe(0);
  });

  it('fails clear safely on a one-shot unlink error and reclaims the pending entry on retry', async () => {
    let failNextCanonicalUnlink = false;
    const fileSystem: FileSystem = {
      ...nodeFileSystem,
      async unlink(filePath) {
        if (failNextCanonicalUnlink && /^[a-f0-9]{64}$/.test(path.basename(filePath))) {
          failNextCanonicalUnlink = false;
          const error = new Error(`unlink denied ${filePath}`) as NodeJS.ErrnoException;
          error.code = 'EACCES';
          throw error;
        }
        await nodeFileSystem.unlink(filePath);
      },
    };
    const { cache, root, budgets } = await createCache({ fileSystem });
    const bytes = Buffer.from('owned');
    await finalize(cache, root, {
      bytes,
      trafficId: 'traffic_clear_retry',
      generation: 'generation_clear_retry',
    });
    failNextCanonicalUnlink = true;

    const error = await cache.clearProject('prj_1').then(
      () => undefined,
      failure => failure as Error,
    );

    expect(error?.message).toBe('Traffic body cache integrity check failed');
    expect(error?.message).not.toContain(root);
    expect(budgets.snapshot().retainedBytes).toBe(bytes.length);
    await expect(fs.promises.readFile(bodyPath(root, 'prj_1', digest(bytes))))
      .resolves.toEqual(bytes);
    expect(await cache.acquire(
      'prj_1',
      'traffic_clear_retry',
      'generation_clear_retry',
      'response',
    )).toBeUndefined();

    await expect(cache.clearProject('prj_1')).resolves.toBeUndefined();
    expect(budgets.snapshot().retainedBytes).toBe(0);
    await expect(fs.promises.stat(bodyPath(root, 'prj_1', digest(bytes))))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps persistent clear deletion failures owned and path-free across retries', async () => {
    let armed = false;
    const fileSystem: FileSystem = {
      ...nodeFileSystem,
      async unlink(filePath) {
        if (armed && /^[a-f0-9]{64}$/.test(path.basename(filePath))) {
          const error = new Error(`persistent unlink failure ${filePath}`) as NodeJS.ErrnoException;
          error.code = 'EIO';
          throw error;
        }
        await nodeFileSystem.unlink(filePath);
      },
    };
    const { cache, root, budgets } = await createCache({
      fileSystem,
      projectRetainedBytes: 8,
      processRetainedBytes: 16,
    });
    const local = Buffer.from('local');
    const foreign = Buffer.from('other');
    await finalize(cache, root, {
      bytes: local,
      trafficId: 'traffic_clear_persistent',
      generation: 'generation_clear_persistent',
    });
    await finalize(cache, root, {
      bytes: foreign,
      projectId: 'prj_2',
      trafficId: 'traffic_clear_foreign',
      generation: 'generation_clear_foreign',
    });
    armed = true;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const error = await cache.clearProject('prj_1').then(
        () => undefined,
        failure => failure as Error,
      );
      expect(error?.message).toBe('Traffic body cache integrity check failed');
      expect(error?.message).not.toContain(root);
      expect(budgets.snapshot().retainedBytes).toBe(local.length + foreign.length);
      await expect(fs.promises.readFile(bodyPath(root, 'prj_1', digest(local))))
        .resolves.toEqual(local);
    }
    const foreignLease = await cache.acquire(
      'prj_2',
      'traffic_clear_foreign',
      'generation_clear_foreign',
      'response',
    );
    expect(await consume(foreignLease!.openStream())).toEqual(foreign);
    await foreignLease!.release();
  });

  it('stops eviction on a one-shot unlink failure and reclaims the pending entry on retry', async () => {
    let failed = false;
    let armed = false;
    let failedPath = '';
    const fileSystem: FileSystem = {
      ...nodeFileSystem,
      async unlink(filePath) {
        if (armed && !failed && /^[a-f0-9]{64}$/.test(path.basename(filePath))) {
          failed = true;
          failedPath = filePath;
          const error = new Error(`eviction unlink denied ${filePath}`) as NodeJS.ErrnoException;
          error.code = 'EACCES';
          throw error;
        }
        await nodeFileSystem.unlink(filePath);
      },
    };
    const { cache, root, budgets } = await createCache({ fileSystem });
    const old = Buffer.from('aaaa');
    const foreign = Buffer.from('bbbbbb');
    const current = Buffer.from('ccc');
    await finalize(cache, root, {
      bytes: old,
      trafficId: 'traffic_eviction_retry_old',
      generation: 'generation_eviction_retry_old',
    });
    await finalize(cache, root, {
      bytes: foreign,
      projectId: 'prj_2',
      trafficId: 'traffic_eviction_retry_foreign',
      generation: 'generation_eviction_retry_foreign',
    });
    armed = true;

    await expect(finalize(cache, root, {
      bytes: current,
      trafficId: 'traffic_eviction_retry_first',
      generation: 'generation_eviction_retry_first',
    })).resolves.toMatchObject({ state: 'unavailable', reason: 'capture_io_failed' });
    expect(failedPath).toBe(bodyPath(root, 'prj_1', digest(old)));
    expect(budgets.snapshot().retainedBytes).toBe(old.length + foreign.length);
    await expect(fs.promises.readFile(bodyPath(root, 'prj_1', digest(old))))
      .resolves.toEqual(old);

    await expect(finalize(cache, root, {
      bytes: current,
      trafficId: 'traffic_eviction_retry_second',
      generation: 'generation_eviction_retry_second',
    })).resolves.toMatchObject({ state: 'available', retainedSize: current.length });
    expect(budgets.snapshot().retainedBytes).toBe(current.length + foreign.length);
    await expect(fs.promises.stat(bodyPath(root, 'prj_1', digest(old))))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.promises.readFile(bodyPath(root, 'prj_2', digest(foreign))))
      .resolves.toEqual(foreign);
  });

  it('keeps persistent eviction deletion failures owned without evicting another Project', async () => {
    let armed = false;
    const old = Buffer.from('aaaa');
    const foreign = Buffer.from('bbbbbb');
    const current = Buffer.from('ccc');
    const fileSystem: FileSystem = {
      ...nodeFileSystem,
      async unlink(filePath) {
        if (armed && filePath.endsWith(digest(old))) {
          const error = new Error(`persistent eviction failure ${filePath}`) as NodeJS.ErrnoException;
          error.code = 'EIO';
          throw error;
        }
        await nodeFileSystem.unlink(filePath);
      },
    };
    const { cache, root, budgets } = await createCache({ fileSystem });
    await finalize(cache, root, {
      bytes: old,
      trafficId: 'traffic_eviction_persistent_old',
      generation: 'generation_eviction_persistent_old',
    });
    await finalize(cache, root, {
      bytes: foreign,
      projectId: 'prj_2',
      trafficId: 'traffic_eviction_persistent_foreign',
      generation: 'generation_eviction_persistent_foreign',
    });
    armed = true;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(finalize(cache, root, {
        bytes: current,
        trafficId: `traffic_eviction_persistent_${attempt}`,
        generation: `generation_eviction_persistent_${attempt}`,
      })).resolves.toMatchObject({ state: 'unavailable', reason: 'capture_io_failed' });
      expect(budgets.snapshot().retainedBytes).toBe(old.length + foreign.length);
      await expect(fs.promises.readFile(bodyPath(root, 'prj_1', digest(old))))
        .resolves.toEqual(old);
    }
    const foreignLease = await cache.acquire(
      'prj_2',
      'traffic_eviction_persistent_foreign',
      'generation_eviction_persistent_foreign',
      'response',
    );
    expect(await consume(foreignLease!.openStream())).toEqual(foreign);
    await foreignLease!.release();
    await expect(fs.promises.stat(bodyPath(root, 'prj_1', digest(current))))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('releases the cache queue before descriptor callbacks and clear cannot resurrect a row', async () => {
    const callbackStarted = deferred();
    const releaseCallback = deferred();
    const holder: { cache?: TrafficBodyCache } = {};
    const created = await createCache({
      async publishDescriptor(publication) {
        callbackStarted.resolve();
        await holder.cache!.releaseRow(
          publication.projectId,
          publication.trafficId,
          publication.generation,
        );
        await releaseCallback.promise;
        return false;
      },
    });
    const cache = created.cache;
    holder.cache = cache;
    await finalize(cache, created.root, {
      bytes: Buffer.from('aaaa'),
      trafficId: 'traffic_old',
      generation: 'generation_old',
    });
    const promotion = await cache.acquire('prj_1', 'traffic_old', 'generation_old', 'response');
    await promotion!.release();

    const replacement = finalize(cache, created.root, {
      bytes: Buffer.from('bbbb'),
      trafficId: 'traffic_new',
      generation: 'generation_new',
    });
    await callbackStarted.promise;
    await expect(cache.clearProject('prj_1')).resolves.toBeUndefined();
    releaseCallback.resolve();
    await expect(replacement).resolves.toMatchObject({ state: 'available' });
    expect(await cache.acquire('prj_1', 'traffic_new', 'generation_new', 'response'))
      .toBeUndefined();
  });

  it('dispose waits for owned leases and releases only its runtime namespace', async () => {
    const budgets = createTrafficBodyBudgetManager({
      ...TRAFFIC_LIMITS,
      projectTemporaryBytes: 64,
      processTemporaryBytes: 128,
      projectRetainedBytes: 20,
      processRetainedBytes: 30,
    });
    const first = await createCache({ runtimeNamespace: 'runtime_a', budgets });
    const second = await createCache({ runtimeNamespace: 'runtime_b', budgets });
    const bytes = Buffer.from('shared');
    await finalize(first.cache, first.root, {
      bytes,
      trafficId: 'traffic_a',
      generation: 'generation_a',
    });
    await finalize(second.cache, second.root, {
      bytes,
      trafficId: 'traffic_b',
      generation: 'generation_b',
    });
    const lease = await first.cache.acquire('prj_1', 'traffic_a', 'generation_a', 'response');

    let disposed = false;
    const disposing = first.cache.dispose().then(() => { disposed = true; });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(disposed).toBe(false);
    await lease!.release();
    await disposing;

    expect(budgets.snapshot()).toMatchObject({
      retainedBytes: bytes.length,
      runtimes: {
        runtime_b: { retainedBytes: bytes.length },
      },
    });
    expect(budgets.snapshot().runtimes).not.toHaveProperty('runtime_a');
  });

  it('settles retained accounting after root removal when canonical unlink keeps failing', async () => {
    let canonicalUnlinkAttempts = 0;
    const fileSystem: FileSystem = {
      ...nodeFileSystem,
      async unlink(filePath) {
        if (/^[a-f0-9]{64}$/.test(path.basename(filePath))) {
          canonicalUnlinkAttempts += 1;
          const error = new Error(`canonical unlink failure ${filePath}`) as NodeJS.ErrnoException;
          error.code = 'EIO';
          throw error;
        }
        await nodeFileSystem.unlink(filePath);
      },
    };
    const { cache, root, budgets } = await createCache({
      fileSystem,
      runtimeNamespace: 'runtime_disposal_accounting',
    });
    await finalize(cache, root, {
      bytes: Buffer.from('owned'),
      trafficId: 'traffic_owned',
      generation: 'generation_owned',
    });

    await cache.dispose();
    await cache.dispose();

    expect(canonicalUnlinkAttempts).toBeGreaterThan(0);
    expect(budgets.snapshot()).toEqual({
      activeSidecars: 0,
      queuedBytes: 0,
      temporaryBytes: 0,
      retainedBytes: 0,
      runtimes: {},
    });
    await expect(fs.promises.stat(path.join(root, 'traffic-cache')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('settles a one-shot canonical unlink failure left by clear before disposal', async () => {
    let failNextCanonicalUnlink = true;
    const fileSystem: FileSystem = {
      ...nodeFileSystem,
      async unlink(filePath) {
        if (failNextCanonicalUnlink && /^[a-f0-9]{64}$/.test(path.basename(filePath))) {
          failNextCanonicalUnlink = false;
          const error = new Error(`one-shot unlink failure ${filePath}`) as NodeJS.ErrnoException;
          error.code = 'EIO';
          throw error;
        }
        await nodeFileSystem.unlink(filePath);
      },
    };
    const { cache, root, budgets } = await createCache({
      fileSystem,
      runtimeNamespace: 'runtime_one_shot_disposal',
    });
    await finalize(cache, root, {
      bytes: Buffer.from('owned'),
      trafficId: 'traffic_one_shot',
      generation: 'generation_one_shot',
    });

    await expect(cache.clearProject('prj_1'))
      .rejects.toThrow('Traffic body cache integrity check failed');
    expect(budgets.snapshot().retainedBytes).toBe(5);
    await cache.dispose();

    expect(budgets.snapshot()).toEqual({
      activeSidecars: 0,
      queuedBytes: 0,
      temporaryBytes: 0,
      retainedBytes: 0,
      runtimes: {},
    });
  });

  it('keeps installed cache state authoritative when an eviction callback rejects', async () => {
    const reported: Array<{ publication: TrafficBodyDescriptorPublication; error: unknown }> = [];
    const callbackError = new Error('/private/callback-path');
    const { cache, root, budgets } = await createCache({
      async publishDescriptor() {
        throw callbackError;
      },
      onDescriptorPublicationError(publication, error) {
        reported.push({ publication, error });
      },
    });
    await finalize(cache, root, {
      bytes: Buffer.from('aaaa'),
      trafficId: 'traffic_callback_old',
      generation: 'generation_callback_old',
    });

    const descriptor = await finalize(cache, root, {
      bytes: Buffer.from('bbbb'),
      trafficId: 'traffic_callback_new',
      generation: 'generation_callback_new',
    });

    expect(descriptor).toMatchObject({ state: 'available', retainedSize: 4 });
    expect(reported).toEqual([{
      publication: expect.objectContaining({
        trafficId: 'traffic_callback_old',
        descriptor: expect.objectContaining({ state: 'evicted' }),
      }),
      error: callbackError,
    }]);
    expect(await cache.acquire(
      'prj_1',
      'traffic_callback_old',
      'generation_callback_old',
      'response',
    )).toBeUndefined();
    const lease = await cache.acquire(
      'prj_1',
      'traffic_callback_new',
      'generation_callback_new',
      'response',
    );
    expect(await consume(lease!.openStream())).toEqual(Buffer.from('bbbb'));
    await lease!.release();
    expect(budgets.snapshot().retainedBytes).toBe(4);
  });

  it('preserves authoritative state and consumes rejection from the publication error owner', async () => {
    const publicationError = new Error('/private/publication-error');
    const ownerError = new Error('/private/error-owner');
    const owned: Array<{ publication: TrafficBodyDescriptorPublication; error: unknown }> = [];
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => { unhandled.push(error); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const { cache, root, budgets } = await createCache({
        async publishDescriptor() {
          throw publicationError;
        },
        async onDescriptorPublicationError(publication, error) {
          owned.push({ publication, error });
          throw ownerError;
        },
      });
      await finalize(cache, root, {
        bytes: Buffer.from('aaaa'),
        trafficId: 'traffic_rejecting_owner_old',
        generation: 'generation_rejecting_owner_old',
      });

      const descriptor = await finalize(cache, root, {
        bytes: Buffer.from('bbbb'),
        trafficId: 'traffic_rejecting_owner_new',
        generation: 'generation_rejecting_owner_new',
      });
      await new Promise<void>(resolve => setImmediate(resolve));

      expect(descriptor).toMatchObject({ state: 'available', retainedSize: 4 });
      expect(owned).toEqual([{
        publication: expect.objectContaining({
          trafficId: 'traffic_rejecting_owner_old',
          descriptor: expect.objectContaining({ state: 'evicted' }),
        }),
        error: publicationError,
      }]);
      expect(unhandled).toEqual([]);
      const lease = await cache.acquire(
        'prj_1',
        'traffic_rejecting_owner_new',
        'generation_rejecting_owner_new',
        'response',
      );
      expect(await consume(lease!.openStream())).toEqual(Buffer.from('bbbb'));
      await lease!.release();
      expect(budgets.snapshot().retainedBytes).toBe(4);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('Traffic body cache filesystem safety', () => {
  it('removes a valid previous ephemeral cache at startup', async () => {
    const root = await createTestStorageDirectory('traffic-cache-');
    roots.push(root);
    const stale = path.join(root, 'traffic-cache', 'incoming', '.capture-stale');
    const staleBytes = Buffer.from('stale canonical');
    const staleBody = bodyPath(root, 'prj_1', digest(staleBytes));
    await fs.promises.mkdir(path.dirname(stale), { recursive: true });
    await fs.promises.writeFile(stale, 'private');
    await fs.promises.mkdir(path.dirname(staleBody), { recursive: true });
    await fs.promises.writeFile(staleBody, staleBytes);

    const { cache } = await createCache({ root });

    await expect(fs.promises.stat(stale)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.promises.stat(staleBody)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.promises.stat(path.join(root, 'traffic-cache', 'incoming')))
      .resolves.toMatchObject({});
    await cache.dispose();
  });

  it('rejects unsafe startup trees without leaking path text or following links', async () => {
    const outside = await createTestStorageDirectory('traffic-outside-');
    roots.push(outside);
    const cases: Array<(root: string) => Promise<void>> = [
      async root => {
        await fs.promises.symlink(outside, path.join(root, 'traffic-cache'));
      },
      async root => {
        const malformed = path.join(
          root,
          'traffic-cache',
          'projects',
          'prj_1',
          'sha256',
          'aa',
          'not-a-digest',
        );
        await fs.promises.mkdir(path.dirname(malformed), { recursive: true });
        await fs.promises.writeFile(malformed, 'private');
      },
    ];

    for (const arrange of cases) {
      const root = await createTestStorageDirectory('traffic-cache-');
      roots.push(root);
      await arrange(root);
      const cache = createTrafficBodyCache({
        rootDirectory: root,
        runtimeNamespace: `runtime_${crypto.randomUUID()}`,
        budgets: createTrafficBodyBudgetManager(TRAFFIC_LIMITS),
        fileSystem: nodeFileSystem,
      });
      caches.push(cache);

      const result = await cache.initialize().then(
        () => undefined,
        error => error as Error,
      );
      expect(result).toBeInstanceOf(Error);
      expect(result?.message).not.toContain(root);
      expect(result?.message).not.toContain(outside);
      expect(await fs.promises.readdir(outside)).toEqual([]);
    }
  });

  it.skipIf(process.platform === 'win32')('rejects special files in a previous cache tree', async () => {
    const root = await createTestStorageDirectory('traffic-cache-');
    roots.push(root);
    const fifo = path.join(root, 'traffic-cache', 'incoming', '.capture-special');
    await fs.promises.mkdir(path.dirname(fifo), { recursive: true });
    await execFileAsync('mkfifo', [fifo]);
    const cache = createTrafficBodyCache({
      rootDirectory: root,
      runtimeNamespace: 'runtime_special',
      budgets: createTrafficBodyBudgetManager(TRAFFIC_LIMITS),
      fileSystem: nodeFileSystem,
    });
    caches.push(cache);

    await expect(cache.initialize()).rejects.toThrow('Traffic body cache integrity check failed');
  });

  it('fails malformed, escaped, and symlinked finalization safely without path text', async () => {
    const { cache, root } = await createCache();
    const outside = path.join(root, 'outside-private');
    await fs.promises.writeFile(outside, 'private');
    const symlink = path.join(root, 'traffic-cache', 'incoming', '.capture-link');
    await fs.promises.symlink(outside, symlink);

    const descriptors = await Promise.all([
      finalize(cache, root, {
        bytes: Buffer.from('private'),
        sha256: 'not-a-digest',
      }),
      finalize(cache, root, {
        bytes: Buffer.from('private'),
        projectId: '../escape',
      }),
      finalize(cache, root, {
        bytes: Buffer.from('x'),
        temporaryPath: symlink,
      }),
    ]);

    expect(descriptors).toEqual(descriptors.map(() => expect.objectContaining({
      state: 'unavailable',
      reason: 'capture_io_failed',
    })));
    expect(JSON.stringify(descriptors)).not.toContain(root);
    expect(await fs.promises.readFile(outside, 'utf8')).toBe('private');
  });

  it('detects a replaced digest ancestor before publishing outside the cache', async () => {
    const root = await createTestStorageDirectory('traffic-cache-');
    const outside = await createTestStorageDirectory('traffic-outside-');
    roots.push(root, outside);
    const bytes = Buffer.from('race');
    const sha256 = digest(bytes);
    const prefix = path.dirname(bodyPath(root, 'prj_1', sha256));
    let armed = false;
    let replaced = false;
    const fileSystem: FileSystem = {
      ...nodeFileSystem,
      async lstat(filePath) {
        const stats = await nodeFileSystem.lstat(filePath);
        if (armed && !replaced && filePath === prefix && stats.isDirectory()) {
          replaced = true;
          await nodeFileSystem.rename(prefix, `${prefix}.original`);
          await fs.promises.symlink(outside, prefix);
        }
        return stats;
      },
    };
    const created = await createCache({ root, fileSystem });
    armed = true;

    const descriptor = await finalize(created.cache, root, {
      bytes,
      trafficId: 'traffic_race',
      generation: 'generation_race',
    });

    expect(descriptor).toMatchObject({ state: 'unavailable', reason: 'capture_io_failed' });
    expect(await fs.promises.readdir(outside)).toEqual([]);
  });

  it('normalizes initialize filesystem failures without exposing path text', async () => {
    const root = await createTestStorageDirectory('traffic-cache-');
    roots.push(root);
    const fileSystem: FileSystem = {
      ...nodeFileSystem,
      async lstat(filePath) {
        if (filePath === root) {
          const error = new Error(`permission denied ${root}`) as NodeJS.ErrnoException;
          error.code = 'EACCES';
          throw error;
        }
        return nodeFileSystem.lstat(filePath);
      },
    };
    const cache = createTrafficBodyCache({
      rootDirectory: root,
      runtimeNamespace: 'runtime_initialize_failure',
      budgets: createTrafficBodyBudgetManager(TRAFFIC_LIMITS),
      fileSystem,
    });
    caches.push(cache);

    const error = await cache.initialize().then(() => undefined, failure => failure as Error);

    expect(error?.message).toBe('Traffic body cache integrity check failed');
    expect(error?.message).not.toContain(root);
  });

  it('normalizes initialize readdir failures without exposing path text', async () => {
    const root = await createTestStorageDirectory('traffic-cache-');
    roots.push(root);
    const staleRoot = path.join(root, 'traffic-cache');
    await fs.promises.mkdir(path.join(staleRoot, 'incoming'), { recursive: true });
    const fileSystem: FileSystem = {
      ...nodeFileSystem,
      async readdir(directory, options) {
        if (directory === staleRoot) {
          const error = new Error(`readdir denied ${directory}`) as NodeJS.ErrnoException;
          error.code = 'EACCES';
          throw error;
        }
        return nodeFileSystem.readdir(directory, options);
      },
    };
    const cache = createTrafficBodyCache({
      rootDirectory: root,
      runtimeNamespace: 'runtime_readdir_failure',
      budgets: createTrafficBodyBudgetManager(TRAFFIC_LIMITS),
      fileSystem,
    });
    caches.push(cache);

    const error = await cache.initialize().then(() => undefined, failure => failure as Error);

    expect(error?.message).toBe('Traffic body cache integrity check failed');
    expect(error?.message).not.toContain(root);
  });

  it('normalizes acquire filesystem failures without exposing path text', async () => {
    let armed = false;
    let protectedDirectory = '';
    const fileSystem: FileSystem = {
      ...nodeFileSystem,
      async lstat(filePath) {
        if (armed && filePath === protectedDirectory) {
          const error = new Error(`permission denied ${filePath}`) as NodeJS.ErrnoException;
          error.code = 'EACCES';
          throw error;
        }
        return nodeFileSystem.lstat(filePath);
      },
    };
    const { cache, root } = await createCache({ fileSystem });
    const bytes = Buffer.from('read');
    await finalize(cache, root, {
      bytes,
      trafficId: 'traffic_acquire_failure',
      generation: 'generation_acquire_failure',
    });
    protectedDirectory = path.dirname(bodyPath(root, 'prj_1', digest(bytes)));
    armed = true;

    const error = await cache.acquire(
      'prj_1',
      'traffic_acquire_failure',
      'generation_acquire_failure',
      'response',
    ).then(() => undefined, failure => failure as Error);

    expect(error?.message).toBe('Traffic body cache integrity check failed');
    expect(error?.message).not.toContain(root);
  });

  it('normalizes a missing acquired leaf without exposing path text', async () => {
    const { cache, root } = await createCache();
    const bytes = Buffer.from('leaf');
    await finalize(cache, root, {
      bytes,
      trafficId: 'traffic_missing_leaf',
      generation: 'generation_missing_leaf',
    });
    await fs.promises.unlink(bodyPath(root, 'prj_1', digest(bytes)));

    const error = await cache.acquire(
      'prj_1',
      'traffic_missing_leaf',
      'generation_missing_leaf',
      'response',
    ).then(() => undefined, failure => failure as Error);

    expect(error?.message).toBe('Traffic body cache integrity check failed');
    expect(error?.message).not.toContain(root);
  });

  it('normalizes dispose filesystem failures without exposing path text', async () => {
    let armed = false;
    const fileSystem: FileSystem = {
      ...nodeFileSystem,
      async rm(filePath, options) {
        if (armed && path.basename(filePath) === 'traffic-cache') {
          const error = new Error(`permission denied ${filePath}`) as NodeJS.ErrnoException;
          error.code = 'EACCES';
          throw error;
        }
        await nodeFileSystem.rm(filePath, options);
      },
    };
    const { cache, root } = await createCache({ fileSystem });
    armed = true;

    const error = await cache.dispose().then(() => undefined, failure => failure as Error);

    expect(error?.message).toBe('Traffic body cache integrity check failed');
    expect(error?.message).not.toContain(root);
  });
});
