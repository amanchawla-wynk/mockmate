import * as fs from 'node:fs';
import { constants as fsConstants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { TRAFFIC_LIMITS } from '../domain/traffic';
import { nodeFileSystem, type FileSystem } from '../repository/file-system';
import { createTestStorageDirectory } from '../test-support/test-storage';
import { createCaptureSidecar, type CaptureSidecar } from './capture-sidecar';
import { createTrafficBodyBudgetManager } from './traffic-body-budget';
import {
  createTrafficBodyCache,
  type TrafficBodyCache,
  type TrafficBodyDescriptorPublication,
} from './traffic-body-cache';

const roots: string[] = [];
const caches: TrafficBodyCache[] = [];

afterEach(async () => {
  await Promise.allSettled(caches.splice(0).map(cache => cache.dispose()));
  await Promise.all(roots.splice(0).map(root => fs.promises.rm(root, {
    recursive: true,
    force: true,
  })));
});

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>(settle => { resolve = settle; });
  return { promise, resolve };
}

async function waitForQueueDrain(
  budgets: ReturnType<typeof createTrafficBodyBudgetManager>,
): Promise<void> {
  while (budgets.snapshot().queuedBytes !== 0) {
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

async function captureFiles(root: string): Promise<string[]> {
  const incoming = path.join(root, 'traffic-cache', 'incoming');
  try {
    return await fs.promises.readdir(incoming);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function createHarness(options: {
  fileSystem?: FileSystem;
  limits?: Partial<typeof TRAFFIC_LIMITS>;
  enabled?: boolean;
  textPreview?: boolean;
  publishDescriptor?(publication: TrafficBodyDescriptorPublication): Promise<boolean> | boolean;
  onDescriptorPublicationError?(
    publication: TrafficBodyDescriptorPublication,
    error: unknown,
  ): Promise<void> | void;
} = {}): Promise<{
    root: string;
    cache: TrafficBodyCache;
    budgets: ReturnType<typeof createTrafficBodyBudgetManager>;
    sidecar(overrides?: Partial<Parameters<typeof createCaptureSidecar>[0]>): CaptureSidecar;
  }> {
  const root = await createTestStorageDirectory('capture-sidecar-');
  roots.push(root);
  const fileSystem = options.fileSystem ?? nodeFileSystem;
  const limits = {
    ...TRAFFIC_LIMITS,
    ...options.limits,
  };
  const budgets = createTrafficBodyBudgetManager(limits);
  const publicationOptions = options.publishDescriptor === undefined ? {} : {
    publishDescriptor: options.publishDescriptor,
    onDescriptorPublicationError: options.onDescriptorPublicationError ?? (() => {
      throw new Error('Unexpected descriptor publication failure');
    }),
  };
  const cache = createTrafficBodyCache({
    rootDirectory: root,
    runtimeNamespace: 'runtime_a',
    budgets,
    fileSystem,
    ...publicationOptions,
  });
  caches.push(cache);
  await cache.initialize();
  let identity = 0;
  return {
    root,
    cache,
    budgets,
    sidecar(overrides = {}) {
      identity += 1;
      return createCaptureSidecar({
        runtimeNamespace: 'runtime_a',
        projectId: 'prj_1',
        trafficId: `traffic_${identity}`,
        generation: `generation_${identity}`,
        side: 'response',
        enabled: options.enabled ?? true,
        mediaType: 'text/plain',
        textPreview: options.textPreview ?? true,
         cache,
         budgets,
         fileSystem,
         limits,
         ...overrides,
       });
    },
  };
}

function blockedCaptureOpenFileSystem(): {
  fileSystem: FileSystem;
  started: Promise<void>;
  cancelled: Promise<void>;
  release(): void;
} {
  const started = deferred();
  const cancelled = deferred();
  const release = deferred();
  return {
    fileSystem: {
      ...nodeFileSystem,
      async open(filePath, flags, mode, signal) {
        if (path.basename(filePath).startsWith('.capture-')
          && typeof flags === 'number'
          && (flags & fsConstants.O_EXCL) !== 0) {
          started.resolve();
          await new Promise<void>((resolve, reject) => {
            const onAbort = () => {
              cancelled.resolve();
              void release.promise.then(() => reject(signal?.reason));
            };
            signal?.addEventListener('abort', onAbort, { once: true });
            void release.promise.then(() => {
              signal?.removeEventListener('abort', onAbort);
              if (!signal?.aborted) resolve();
            });
          });
        }
        return nodeFileSystem.open(filePath, flags, mode, signal);
      },
    },
    started: started.promise,
    cancelled: cancelled.promise,
    release: release.resolve,
  };
}

function partialWriteFailureFileSystem(): FileSystem {
  return {
    ...nodeFileSystem,
    async open(filePath, flags, mode) {
      const handle = await nodeFileSystem.open(filePath, flags, mode);
      if (!path.basename(filePath).startsWith('.capture-')
        || typeof flags !== 'number'
        || (flags & fsConstants.O_EXCL) === 0) {
        return handle;
      }
      let failed = false;
      return new Proxy(handle, {
        get(target, property, receiver) {
          if (property === 'write') {
            return async (
              buffer: Uint8Array,
              offset?: number,
              length?: number,
              position?: number | null,
            ) => {
              if (failed) throw new Error('capture write failed');
              failed = true;
              const requested = length ?? buffer.byteLength;
              const partial = Math.max(1, Math.floor(requested / 2));
              await target.write(buffer, offset ?? 0, partial, position ?? null);
              throw new Error('capture write failed');
            };
          }
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as FileHandle;
    },
  };
}

function blockedCaptureWriteFileSystem(): {
  fileSystem: FileSystem;
  writeStarted: Promise<void>;
  cancelledByClose: Promise<void>;
} {
  const writeStarted = deferred();
  const cancelledByClose = deferred();
  return {
    fileSystem: {
      ...nodeFileSystem,
      async open(filePath, flags, mode, signal) {
        const handle = await nodeFileSystem.open(filePath, flags, mode, signal);
        if (!path.basename(filePath).startsWith('.capture-')
          || typeof flags !== 'number'
          || (flags & fsConstants.O_EXCL) === 0) return handle;
        let closed = false;
        return new Proxy(handle, {
          get(target, property, receiver) {
            if (property === 'write') {
              return async () => {
                writeStarted.resolve();
                await cancelledByClose.promise;
                const error = new Error('capture write cancelled') as NodeJS.ErrnoException;
                error.code = 'ECANCELED';
                throw error;
              };
            }
            if (property === 'close') {
              return async () => {
                cancelledByClose.resolve();
                if (closed) return;
                closed = true;
                await target.close();
              };
            }
            const value = Reflect.get(target, property, receiver) as unknown;
            return typeof value === 'function' ? value.bind(target) : value;
          },
        }) as FileHandle;
      },
    },
    writeStarted: writeStarted.promise,
    cancelledByClose: cancelledByClose.promise,
  };
}

describe('capture sidecar admission and bounded observation', () => {
  it('returns from observe synchronously while persistence is stalled and saturates at sidecarQueueBytes + 1', async () => {
    const blocked = blockedCaptureOpenFileSystem();
    const sidecarQueueBytes = 64 * 1024;
    const previewBytes = 16 * 1024;
    const { sidecar, budgets } = await createHarness({
      fileSystem: blocked.fileSystem,
      limits: { sidecarQueueBytes, previewBytes, projectQueuedBytes: 256 * 1024, processQueuedBytes: 256 * 1024 },
    });
    const capture = sidecar();

    expect(capture.observe(Buffer.alloc(sidecarQueueBytes, 0x61)))
      .toBeUndefined();
    await blocked.started;
    expect(budgets.snapshot().queuedBytes).toBe(sidecarQueueBytes);
    expect(capture.observe(Buffer.of(0x62))).toBeUndefined();
    expect(budgets.snapshot().queuedBytes).toBe(0);

    const completion = capture.complete();
    blocked.release();
    await expect(completion).resolves.toMatchObject({
      preview: 'a'.repeat(previewBytes),
      previewEncoding: 'utf8',
      observedSize: sidecarQueueBytes + 1,
      descriptor: {
        state: 'unavailable',
        reason: 'queue_saturated',
        observedSize: sidecarQueueBytes + 1,
      },
    });
    expect(budgets.snapshot()).toMatchObject({
      activeSidecars: 0,
      queuedBytes: 0,
      temporaryBytes: 0,
    });
  });

  it('returns exact admission reasons for sidecar and temporary aggregate limits', async () => {
    const sidecarLimited = await createHarness({
      limits: { projectActiveSidecars: 1, processActiveSidecars: 1 },
    });
    const first = sidecarLimited.sidecar();
    const rejected = sidecarLimited.sidecar();
    await expect(rejected.complete()).resolves.toMatchObject({
      descriptor: { state: 'unavailable', reason: 'sidecar_limit' },
    });
    first.abandon('stream_cancelled');
    await first.complete();

    const temporaryLimited = await createHarness({
      limits: { projectTemporaryBytes: 4, processTemporaryBytes: 4 },
    });
    const capture = temporaryLimited.sidecar();
    capture.observe(Buffer.from('12345'));
    await expect(capture.complete()).resolves.toMatchObject({
      descriptor: { state: 'unavailable', reason: 'temporary_budget_exceeded' },
    });
  });

  it('continues bounded observation after non-cancellation exact abandonment', async () => {
    const { sidecar } = await createHarness({ limits: { previewBytes: 8, bodyBytes: 32 } });
    const capture = sidecar();
    capture.abandon('body_unobservable');
    capture.observe(Buffer.from('continued observation'));

    await expect(capture.complete()).resolves.toEqual({
      preview: 'continue',
      previewEncoding: 'utf8',
      observedSize: 21,
      descriptor: {
        side: 'response',
        state: 'unavailable',
        mediaType: 'text/plain',
        observedSize: 21,
        reason: 'body_unobservable',
      },
    });
  });

  it.each(['request', 'response'] as const)(
    'continues %s preview and size after queue saturation without further persistence',
    async side => {
      const blocked = blockedCaptureOpenFileSystem();
      const { sidecar, budgets } = await createHarness({
        fileSystem: blocked.fileSystem,
        limits: { previewBytes: 5, bodyBytes: 32, sidecarQueueBytes: 4 },
      });
      const capture = sidecar({ side });
      capture.observe(Buffer.from('1234'));
      await blocked.started;
      capture.observe(Buffer.from('56'));
      capture.observe(Buffer.from('789'));
      const completion = capture.complete();
      blocked.release();

      await expect(completion).resolves.toMatchObject({
        preview: '12345',
        previewEncoding: 'utf8',
        observedSize: 9,
        descriptor: { side, state: 'unavailable', reason: 'queue_saturated', observedSize: 9 },
      });
      expect(budgets.snapshot()).toMatchObject({ queuedBytes: 0, temporaryBytes: 0 });
    },
  );

  it.each(['request', 'response'] as const)(
    'continues %s preview and size after temporary-budget exhaustion without resurrection',
    async side => {
      const { sidecar, budgets } = await createHarness({
        limits: {
          previewBytes: 5,
          bodyBytes: 32,
          projectTemporaryBytes: 4,
          processTemporaryBytes: 4,
        },
      });
      const capture = sidecar({ side });
      capture.observe(Buffer.from('12345'));
      capture.observe(Buffer.from('6789'));

      await expect(capture.complete()).resolves.toMatchObject({
        preview: '12345',
        previewEncoding: 'utf8',
        observedSize: 9,
        descriptor: {
          side, state: 'unavailable', reason: 'temporary_budget_exceeded', observedSize: 9,
        },
      });
      expect(budgets.snapshot()).toMatchObject({ queuedBytes: 0, temporaryBytes: 0 });
    },
  );

  it.each(['request', 'response'] as const)(
    'continues %s preview and size after capture I/O abandonment',
    async side => {
      const { sidecar, budgets } = await createHarness({
        fileSystem: partialWriteFailureFileSystem(),
        limits: { previewBytes: 5, bodyBytes: 32 },
      });
      const capture = sidecar({ side });
      capture.observe(Buffer.from('1234'));
      await waitForQueueDrain(budgets);
      capture.observe(Buffer.from('56789'));

      await expect(capture.complete()).resolves.toMatchObject({
        preview: '12345',
        previewEncoding: 'utf8',
        observedSize: 9,
        descriptor: { side, state: 'unavailable', reason: 'capture_io_failed', observedSize: 9 },
      });
      expect(budgets.snapshot()).toMatchObject({ queuedBytes: 0, temporaryBytes: 0 });
    },
  );
});

describe('capture sidecar exact boundaries', () => {
  it('uses injected physical limits and saturates multichunk overflow at body limit + 1', async () => {
    const { sidecar, budgets } = await createHarness({
      limits: { previewBytes: 3, bodyBytes: 5 },
    });
    const capture = sidecar();
    capture.observe(Buffer.from('1234'));
    await waitForQueueDrain(budgets);
    capture.observe(Buffer.from('56789'));
    capture.observe(Buffer.from('ignored after truncation'));

    await expect(capture.complete()).resolves.toMatchObject({
      preview: '123',
      previewEncoding: 'utf8',
      observedSize: 6,
      descriptor: {
        state: 'truncated',
        reason: 'body_limit_exceeded',
        observedSize: 6,
      },
    });
  });

  it('captures unknown-length chunks and verified enabled empty bodies exactly', async () => {
    const { sidecar, cache } = await createHarness();
    const unknown = sidecar({ trafficId: 'traffic_unknown', generation: 'generation_unknown' });
    unknown.observe(Buffer.from('ab'));
    unknown.observe(Buffer.from('cd'));

    await expect(unknown.complete()).resolves.toMatchObject({
      preview: 'abcd',
      observedSize: 4,
      descriptor: {
        state: 'available',
        retainedSize: 4,
        sha256: '88d4266fd4e6338d13b845fcf289579d209c897823b9217da3e161936f031589',
      },
    });
    const lease = await cache.acquire(
      'prj_1',
      'traffic_unknown',
      'generation_unknown',
      'response',
    );
    const chunks: Buffer[] = [];
    for await (const chunk of lease!.openStream() as AsyncIterable<Buffer>) chunks.push(chunk);
    expect(Buffer.concat(chunks)).toEqual(Buffer.from('abcd'));
    await lease!.release();

    const empty = sidecar({ trafficId: 'traffic_empty', generation: 'generation_empty' });
    await expect(empty.complete()).resolves.toMatchObject({
      observedSize: 0,
      descriptor: {
        state: 'available',
        retainedSize: 0,
        sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      },
    });
  });

  it('accepts exactly bodyBytes and truncates at bodyBytes + 1', async () => {
    // Production bodyBytes is effectively unbounded; inject a small ceiling to
    // keep truncate-boundary coverage without allocating MAX_SAFE_INTEGER.
    const bodyBytes = 8 * 1024;
    const { sidecar, budgets } = await createHarness({
      limits: { bodyBytes, sidecarQueueBytes: bodyBytes },
    });
    const exact = sidecar({ trafficId: 'traffic_exact', generation: 'generation_exact' });
    exact.observe(Buffer.alloc(bodyBytes, 0x61));
    await waitForQueueDrain(budgets);
    await expect(exact.complete()).resolves.toMatchObject({
      observedSize: bodyBytes,
      descriptor: {
        state: 'available',
        observedSize: bodyBytes,
        retainedSize: bodyBytes,
      },
    });

    const oversized = sidecar({
      trafficId: 'traffic_oversized',
      generation: 'generation_oversized',
    });
    oversized.observe(Buffer.alloc(bodyBytes + 1));
    await expect(oversized.complete()).resolves.toMatchObject({
      observedSize: bodyBytes + 1,
      descriptor: {
        state: 'truncated',
        reason: 'body_limit_exceeded',
        observedSize: bodyBytes + 1,
      },
    });
  });

  it('keeps disabled capture unavailable for empty bodies while preserving preview metadata', async () => {
    const { sidecar, budgets } = await createHarness({ enabled: false });
    const empty = sidecar();
    await expect(empty.complete()).resolves.toMatchObject({
      observedSize: 0,
      descriptor: { state: 'unavailable', reason: 'raw_capture_disabled' },
    });

    const body = sidecar();
    body.observe(Buffer.from([0xff, 0x00]));
    await expect(body.complete()).resolves.toMatchObject({
      preview: '/wA=',
      previewEncoding: 'base64',
      observedSize: 2,
      descriptor: { state: 'unavailable', reason: 'raw_capture_disabled' },
    });
    expect(budgets.snapshot().activeSidecars).toBe(0);
  });
});

describe('capture sidecar cleanup and settlement', () => {
  it('removes operation-owned temporary files after partial disk failure', async () => {
    const { sidecar, root, budgets } = await createHarness({
      fileSystem: partialWriteFailureFileSystem(),
    });
    const capture = sidecar();
    capture.observe(Buffer.from('partial-write'));

    await expect(capture.complete()).resolves.toMatchObject({
      descriptor: { state: 'unavailable', reason: 'capture_io_failed' },
    });
    expect(await captureFiles(root)).toEqual([]);
    expect(budgets.snapshot()).toMatchObject({
      activeSidecars: 0,
      queuedBytes: 0,
      temporaryBytes: 0,
    });
  });

  it('preserves the initiating cancellation reason and settles duplicate completion exactly once', async () => {
    const { sidecar, root, budgets } = await createHarness();
    const capture = sidecar();
    capture.observe(Buffer.from('cancelled'));
    capture.abandon('stream_cancelled');
    capture.abandon('capture_io_failed');

    const first = capture.complete();
    const second = capture.complete();
    await expect(first).resolves.toMatchObject({
      descriptor: { state: 'unavailable', reason: 'stream_cancelled' },
    });
    await expect(second).resolves.toEqual(await first);
    expect(await captureFiles(root)).toEqual([]);
    expect(budgets.snapshot()).toMatchObject({
      activeSidecars: 0,
      queuedBytes: 0,
      temporaryBytes: 0,
    });
  });

  it.each(['clear', 'dispose'] as const)(
    'ignores observation after cache %s without changing terminal evidence', async lifecycle => {
    const { sidecar, cache } = await createHarness();
    const capture = sidecar();
    capture.observe(Buffer.from('before'));

    if (lifecycle === 'clear') await cache.clearProject('prj_1');
    else await cache.dispose();

    expect(() => capture.observe(Buffer.from('after'))).not.toThrow();
    await expect(capture.complete()).resolves.toMatchObject({
      preview: 'before',
      observedSize: 6,
      descriptor: {
        state: 'unavailable',
        reason: 'stream_cancelled',
        observedSize: 6,
      },
    });
    },
  );

  it('preserves an initiating cancellation when temporary cleanup also fails', async () => {
    const fileSystem: FileSystem = {
      ...nodeFileSystem,
      async unlink(filePath) {
        if (path.basename(filePath).startsWith('.capture-')) {
          const error = new Error(`cleanup failed ${filePath}`) as NodeJS.ErrnoException;
          error.code = 'EIO';
          throw error;
        }
        await nodeFileSystem.unlink(filePath);
      },
    };
    const { sidecar } = await createHarness({ fileSystem });
    const capture = sidecar();
    capture.observe(Buffer.from('cancelled-cleanup'));
    capture.abandon('stream_cancelled');

    await expect(capture.complete()).resolves.toMatchObject({
      descriptor: { state: 'unavailable', reason: 'stream_cancelled' },
    });
  });

  it('cancels and awaits an active stalled sidecar before cache disposal resolves', async () => {
    const blocked = blockedCaptureOpenFileSystem();
    const { sidecar, cache } = await createHarness({ fileSystem: blocked.fileSystem });
    const capture = sidecar();
    capture.observe(Buffer.from('active'));
    await blocked.started;

    const disposal = cache.dispose();
    await blocked.cancelled;
    await new Promise<void>(resolve => setImmediate(resolve));
    const settledBeforeRelease = await Promise.race([
      disposal.then(() => true),
      new Promise<false>(resolve => setTimeout(() => resolve(false), 100)),
    ]);
    blocked.release();

    expect(settledBeforeRelease).toBe(false);
    await expect(capture.complete()).resolves.toMatchObject({
      descriptor: { state: 'unavailable', reason: 'stream_cancelled' },
    });
    await disposal;
  });

  it('closes a blocked capture write and awaits all cleanup before disposal resolves', async () => {
    const blocked = blockedCaptureWriteFileSystem();
    const { sidecar, cache, budgets, root } = await createHarness({ fileSystem: blocked.fileSystem });
    const capture = sidecar();
    capture.observe(Buffer.from('blocked-write'));
    await blocked.writeStarted;

    const disposal = cache.dispose();

    await blocked.cancelledByClose;
    await expect(disposal).resolves.toBeUndefined();
    await expect(capture.complete()).resolves.toMatchObject({
      descriptor: { state: 'unavailable', reason: 'stream_cancelled' },
    });
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

  it('awaits admitted finalization publication before disposal removes cache ownership', async () => {
    const publicationStarted = deferred();
    const publicationCancelled = deferred();
    const releasePublication = deferred();
    const { sidecar, cache, budgets, root } = await createHarness({
      limits: { projectRetainedBytes: 6, processRetainedBytes: 12 },
      async publishDescriptor(_publication, signal) {
        publicationStarted.resolve();
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => {
            publicationCancelled.resolve();
            void releasePublication.promise.then(() => reject(signal.reason));
          };
          signal.addEventListener('abort', onAbort, { once: true });
          void releasePublication.promise.then(() => {
            signal.removeEventListener('abort', onAbort);
            if (!signal.aborted) resolve();
          });
        });
        return true;
      },
      onDescriptorPublicationError() {},
    });
    const old = sidecar({
      trafficId: 'traffic_disposal_admitted_old',
      generation: 'generation_disposal_admitted_old',
    });
    old.observe(Buffer.from('aaaa'));
    await waitForQueueDrain(budgets);
    await old.complete();

    const admitted = sidecar({
      trafficId: 'traffic_disposal_admitted',
      generation: 'generation_disposal_admitted',
    });
    admitted.observe(Buffer.from('bbbb'));
    await waitForQueueDrain(budgets);
    const completion = admitted.complete();
    await publicationStarted.promise;

    const disposal = cache.dispose();
    await publicationCancelled.promise;
    await new Promise<void>(resolve => setImmediate(resolve));
    const settledBeforeRelease = await Promise.race([
      disposal.then(() => true),
      new Promise<false>(resolve => setTimeout(() => resolve(false), 100)),
    ]);
    releasePublication.resolve();

    expect(settledBeforeRelease).toBe(false);
    await expect(completion).resolves.toMatchObject({
      descriptor: { state: 'unavailable', reason: 'stream_cancelled' },
    });
    await expect(disposal).resolves.toBeUndefined();
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

  it('releases only the late-cancelled side after finalization admission', async () => {
    const publicationStarted = deferred();
    const releasePublication = deferred();
    const { sidecar, cache, budgets } = await createHarness({
      limits: { projectRetainedBytes: 8, processRetainedBytes: 16 },
      async publishDescriptor() {
        publicationStarted.resolve();
        await releasePublication.promise;
        return true;
      },
      onDescriptorPublicationError() {},
    });
    const old = sidecar({ trafficId: 'traffic_old', generation: 'generation_old' });
    old.observe(Buffer.from('aaaa'));
    await waitForQueueDrain(budgets);
    await old.complete();
    const request = sidecar({
      trafficId: 'traffic_shared', generation: 'generation_shared', side: 'request',
    });
    request.observe(Buffer.from('rr'));
    await waitForQueueDrain(budgets);
    await request.complete();
    const response = sidecar({
      trafficId: 'traffic_shared', generation: 'generation_shared', side: 'response',
    });
    response.observe(Buffer.from('bbbb'));
    await waitForQueueDrain(budgets);
    const completion = response.complete();
    await publicationStarted.promise;

    response.abandon('stream_cancelled');
    releasePublication.resolve();

    await expect(completion).resolves.toMatchObject({
      descriptor: { side: 'response', state: 'unavailable', reason: 'stream_cancelled' },
    });
    const sibling = await cache.acquire(
      'prj_1', 'traffic_shared', 'generation_shared', 'request',
    );
    expect(sibling).toBeDefined();
    await sibling!.release();
  });

  it('cancels and awaits stalled persistence while clearing a pending capture', async () => {
    const blocked = blockedCaptureOpenFileSystem();
    const { sidecar, cache } = await createHarness({ fileSystem: blocked.fileSystem });
    const capture = sidecar({
      trafficId: 'traffic_pending_clear',
      generation: 'generation_pending_clear',
    });
    capture.observe(Buffer.from('pending'));
    await blocked.started;

    const clearing = cache.clearProject('prj_1');
    await blocked.cancelled;
    blocked.release();
    await expect(clearing).resolves.toBeUndefined();

    await expect(capture.complete()).resolves.toMatchObject({
      descriptor: { state: 'unavailable', reason: 'stream_cancelled' },
    });
    expect(await cache.acquire(
      'prj_1',
      'traffic_pending_clear',
      'generation_pending_clear',
      'response',
    )).toBeUndefined();
  });

  it('rejects a tombstoned deduplicated finalization while a newer row owns the digest', async () => {
    const { sidecar, cache, budgets } = await createHarness();
    const bytes = Buffer.from('shared-digest');
    const pending = sidecar({
      trafficId: 'traffic_pending_dedup',
      generation: 'generation_pending_dedup',
    });
    pending.observe(bytes);
    await waitForQueueDrain(budgets);
    await cache.clearProject('prj_1');

    const owner = sidecar({
      trafficId: 'traffic_new_owner',
      generation: 'generation_new_owner',
    });
    owner.observe(bytes);
    await waitForQueueDrain(budgets);
    await expect(owner.complete()).resolves.toMatchObject({ descriptor: { state: 'available' } });

    await expect(pending.complete()).resolves.toMatchObject({
      descriptor: { state: 'unavailable', reason: 'stream_cancelled' },
    });
    expect(await cache.acquire(
      'prj_1',
      'traffic_pending_dedup',
      'generation_pending_dedup',
      'response',
    )).toBeUndefined();
    const ownerLease = await cache.acquire(
      'prj_1',
      'traffic_new_owner',
      'generation_new_owner',
      'response',
    );
    expect(ownerLease).toBeDefined();
    await ownerLease!.release();
  });

  it('closes capture admission synchronously during disposal and after disposal', async () => {
    const { sidecar, cache, budgets } = await createHarness();
    const owner = sidecar({ trafficId: 'traffic_disposal_owner' });
    owner.observe(Buffer.from('owner'));
    await waitForQueueDrain(budgets);
    await owner.complete();
    const lease = await cache.acquire(
      'prj_1',
      'traffic_disposal_owner',
      'generation_1',
      'response',
    );
    expect(lease).toBeDefined();

    const disposal = cache.dispose();
    const during = sidecar({
      trafficId: 'traffic_during_disposal',
      generation: 'generation_during_disposal',
    });
    expect(budgets.snapshot().activeSidecars).toBe(0);
    await expect(during.complete()).resolves.toMatchObject({
      descriptor: { state: 'unavailable', reason: 'stream_cancelled' },
    });

    await lease!.release();
    await disposal;

    const after = sidecar({
      trafficId: 'traffic_after_disposal',
      generation: 'generation_after_disposal',
    });
    expect(budgets.snapshot().activeSidecars).toBe(0);
    await expect(after.complete()).resolves.toMatchObject({
      descriptor: { state: 'unavailable', reason: 'stream_cancelled' },
    });
  });

  it('does not retain completed row tombstones across repeated clear epochs', async () => {
    const { sidecar, cache, budgets } = await createHarness();
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const capture = sidecar({
        trafficId: 'traffic_reused_after_clear',
        generation: 'generation_reused_after_clear',
      });
      capture.observe(Buffer.from('epoch'));
      await waitForQueueDrain(budgets);
      await expect(capture.complete()).resolves.toMatchObject({
        descriptor: { state: 'available' },
      });
      await cache.clearProject('prj_1');
    }
    expect(budgets.snapshot().retainedBytes).toBe(0);
  });

  it('keeps a sidecar available when an eviction callback rejects', async () => {
    const callbackError = new Error('/private/sidecar-callback');
    const reported: unknown[] = [];
    const { sidecar, cache, budgets } = await createHarness({
      limits: { projectRetainedBytes: 6, processRetainedBytes: 12 },
      async publishDescriptor() {
        throw callbackError;
      },
      onDescriptorPublicationError(_publication, error) {
        reported.push(error);
      },
    });
    const old = sidecar({ trafficId: 'traffic_sidecar_callback_old' });
    old.observe(Buffer.from('aaaa'));
    await waitForQueueDrain(budgets);
    await old.complete();

    const current = sidecar({
      trafficId: 'traffic_sidecar_callback_new',
      generation: 'generation_sidecar_callback_new',
    });
    current.observe(Buffer.from('bbbb'));
    await waitForQueueDrain(budgets);

    await expect(current.complete()).resolves.toMatchObject({
      descriptor: { state: 'available', retainedSize: 4 },
    });
    expect(reported).toEqual([callbackError]);
    const lease = await cache.acquire(
      'prj_1',
      'traffic_sidecar_callback_new',
      'generation_sidecar_callback_new',
      'response',
    );
    expect(lease).toBeDefined();
    await lease!.release();
    expect(budgets.snapshot().retainedBytes).toBe(4);
  });
});
