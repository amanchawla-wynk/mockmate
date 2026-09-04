import { setImmediate as waitForImmediate } from 'node:timers/promises';
import { Readable, Writable } from 'node:stream';

import express, { type Response } from 'express';
import request from 'supertest';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import type { BodyAsset } from '../domain/model';
import type { ResolvedMock } from '../repository/compile-project';
import type { ProjectRepository } from '../repository/project-repository';
import {
  writeResolvedResponse,
  type ResponseBodyRepository,
  type ResponseWriterTarget,
} from './response-writer';

const assetId = 'a'.repeat(64);

function resolved(overrides: Partial<ResolvedMock> = {}): ResolvedMock {
  return {
    projectId: 'prj_1',
    endpointId: 'ep_1',
    variantId: 'var_1',
    selectedStateId: 'state_1',
    resolutionSource: 'project_active_state',
    fallbackReasons: [],
    status: 201,
    responseHeaders: { 'X-Trace': 'trace-1' },
    delayMs: 0,
    bodyAssetId: assetId,
    ...overrides,
  };
}

function bodyAsset(overrides: Partial<BodyAsset> = {}): BodyAsset {
  return {
    schemaVersion: 4,
    id: assetId,
    mediaType: 'application/octet-stream',
    size: 3,
    encoding: 'gzip',
    createdAt: '2026-08-27T00:00:00.000Z',
    ...overrides,
  };
}

class RecordingTarget extends Writable implements ResponseWriterTarget {
  readonly statusCalls: number[] = [];
  readonly headerWrites: Array<readonly [string, string | number | readonly string[]]> = [];
  readonly chunks: Buffer[] = [];
  finalCalls = 0;

  constructor(options: {
    autoDestroy?: boolean;
    destroy?: (error: Error | null, callback: (error?: Error | null) => void) => void;
    emitClose?: boolean;
    final?: (callback: (error?: Error | null) => void) => void;
    highWaterMark?: number;
    write?: (chunk: Buffer, callback: (error?: Error | null) => void) => void;
  } = {}) {
    super({
      autoDestroy: options.autoDestroy,
      emitClose: options.emitClose,
      highWaterMark: options.highWaterMark,
    });
    this.destroyTarget = options.destroy;
    this.finalize = options.final;
    this.writeChunk = options.write;
  }

  private readonly finalize?: (callback: (error?: Error | null) => void) => void;

  private readonly destroyTarget?: (
    error: Error | null,
    callback: (error?: Error | null) => void,
  ) => void;

  private readonly writeChunk?: (
    chunk: Buffer,
    callback: (error?: Error | null) => void,
  ) => void;

  status(code: number): void {
    this.statusCalls.push(code);
  }

  setHeader(name: string, value: string | number | readonly string[]): void {
    this.headerWrites.push([name, value]);
  }

  header(name: string): string | number | readonly string[] | undefined {
    return [...this.headerWrites]
      .reverse()
      .find(([candidate]) => candidate.toLowerCase() === name.toLowerCase())?.[1];
  }

  bytes(): Buffer {
    return Buffer.concat(this.chunks);
  }

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const bytes = Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk);
    this.chunks.push(bytes);
    if (this.writeChunk) this.writeChunk(bytes, callback);
    else callback();
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.finalCalls += 1;
    if (this.finalize) this.finalize(callback);
    else callback();
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (this.destroyTarget) this.destroyTarget(error, callback);
    else callback(error);
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(settle => { resolve = settle; });
  return { promise, resolve };
}

async function captureUncaughtErrors(work: () => Promise<void>): Promise<Error[]> {
  const errors: Error[] = [];
  const listener = (error: Error) => { errors.push(error); };
  process.on('uncaughtException', listener);
  try {
    await work();
    await waitForImmediate();
    return errors;
  } finally {
    process.off('uncaughtException', listener);
  }
}

type PromiseOutcome<T> =
  | { state: 'fulfilled'; value: T }
  | { state: 'rejected'; error: unknown }
  | { state: 'pending' };

async function observeSettlement<T>(promise: Promise<T>): Promise<PromiseOutcome<T>> {
  const promptWindow = waitForImmediate()
    .then(() => waitForImmediate())
    .then(() => waitForImmediate())
    .then(() => waitForImmediate());
  return Promise.race([
    promise.then<PromiseOutcome<T>>(
      value => ({ state: 'fulfilled', value }),
      error => ({ state: 'rejected', error }),
    ),
    promptWindow.then<PromiseOutcome<T>>(() => ({ state: 'pending' })),
  ]);
}

function expectNoLifecycleListeners(stream: Readable | Writable): void {
  expect(stream.listenerCount('error')).toBe(0);
  expect(stream.listenerCount('close')).toBe(0);
  expect(stream.listenerCount('end')).toBe(0);
  expect(stream.listenerCount('finish')).toBe(0);
}

function controlledTarget(): {
  target: RecordingTarget;
  destroyStarted: Promise<void>;
  completeDestroy(error?: Error): void;
} {
  const started = deferred<void>();
  let complete!: (error?: Error) => void;
  const target = new RecordingTarget({
    emitClose: false,
    destroy: (_error, callback) => {
      complete = callback;
      started.resolve();
    },
  });
  return {
    target,
    destroyStarted: started.promise,
    completeDestroy: error => complete(error),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('writeResolvedResponse', () => {
  it('owns teardown when the destination reports an error during delay without self-destroying', async () => {
    const destinationFailure = new Error('destination failed during delay');
    let destroyCalls = 0;
    const target = new RecordingTarget();
    const targetDestroy = target.destroy;
    target.destroy = function destroy(error?: Error): RecordingTarget {
      destroyCalls += 1;
      return targetDestroy.call(this, error) as RecordingTarget;
    };
    const getBody = vi.fn();
    const openBody = vi.fn();

    const errors = await captureUncaughtErrors(async () => {
      const writing = writeResolvedResponse(target, resolved({ delayMs: 60_000 }), {
        getBody,
        openBody,
      });
      target.emit('error', destinationFailure);
      await expect(writing).rejects.toBe(destinationFailure);
    });

    expect(errors).toEqual([]);
    expect(destroyCalls).toBe(1);
    expect(target.destroyed).toBe(true);
    expect(target.statusCalls).toEqual([]);
    expect(getBody).not.toHaveBeenCalled();
    expect(openBody).not.toHaveBeenCalled();
    expectNoLifecycleListeners(target);
  });

  it('owns teardown when the destination reports an error during metadata without self-destroying', async () => {
    const destinationFailure = new Error('destination failed during metadata');
    const metadata = deferred<BodyAsset>();
    let destroyCalls = 0;
    const target = new RecordingTarget();
    const targetDestroy = target.destroy;
    target.destroy = function destroy(error?: Error): RecordingTarget {
      destroyCalls += 1;
      return targetDestroy.call(this, error) as RecordingTarget;
    };
    const openBody = vi.fn(() => Readable.from([Buffer.of(1)]));

    const errors = await captureUncaughtErrors(async () => {
      const writing = writeResolvedResponse(target, resolved(), {
        getBody: () => metadata.promise,
        openBody,
      });
      await waitForImmediate();
      target.emit('error', destinationFailure);
      await expect(writing).rejects.toBe(destinationFailure);
      metadata.resolve(bodyAsset());
    });

    expect(errors).toEqual([]);
    expect(destroyCalls).toBe(1);
    expect(target.destroyed).toBe(true);
    expect(openBody).not.toHaveBeenCalled();
    expectNoLifecycleListeners(target);
  });

  it('owns teardown when the destination reports an error during open without self-destroying', async () => {
    const destinationFailure = new Error('destination failed during open');
    let destroyCalls = 0;
    let produced = 0;
    const source = Readable.from((async function* () {
      produced += 1;
      yield Buffer.of(1);
    })());
    const target = new RecordingTarget();
    const targetDestroy = target.destroy;
    target.destroy = function destroy(error?: Error): RecordingTarget {
      destroyCalls += 1;
      return targetDestroy.call(this, error) as RecordingTarget;
    };

    const errors = await captureUncaughtErrors(async () => {
      await expect(writeResolvedResponse(target, resolved(), {
        getBody: async () => bodyAsset({ size: 1 }),
        openBody: () => {
          target.emit('error', destinationFailure);
          return source;
        },
      })).rejects.toBe(destinationFailure);
    });

    expect(errors).toEqual([]);
    expect(destroyCalls).toBe(1);
    expect(target.destroyed).toBe(true);
    expect(source.destroyed).toBe(true);
    expect(produced).toBe(0);
    expectNoLifecycleListeners(source);
    expectNoLifecycleListeners(target);
  });

  it('preserves destination failure when the source destroy override throws synchronously', async () => {
    const destinationFailure = new Error('destination failed');
    const cleanupFailure = new Error('source destroy override failed');
    let destroyCalls = 0;
    let produced = 0;
    const source = new Readable({
      read() {
        produced += 1;
        this.push(Buffer.alloc(1024, produced));
      },
    });
    source.destroy = (() => {
      destroyCalls += 1;
      throw cleanupFailure;
    }) as typeof source.destroy;
    const target = new RecordingTarget({
      autoDestroy: false,
      highWaterMark: 1,
      write: (_chunk, callback) => setImmediate(() => callback(destinationFailure)),
    });

    const errors = await captureUncaughtErrors(async () => {
      await expect(writeResolvedResponse(target, resolved(), {
        getBody: async () => bodyAsset({ size: 1024 }),
        openBody: () => source,
      })).rejects.toBe(destinationFailure);
    });
    const producedAtSettlement = produced;
    await waitForImmediate();

    expect(errors).toEqual([]);
    expect(destroyCalls).toBe(1);
    expect(source.destroyed).toBe(true);
    expect(target.destroyed).toBe(true);
    expect(produced).toBe(producedAtSettlement);
    expectNoLifecycleListeners(source);
    expectNoLifecycleListeners(target);
  });

  it('preserves source failure when the destination destroy override throws synchronously', async () => {
    const sourceFailure = new Error('source failed');
    const cleanupFailure = new Error('destination destroy override failed');
    let destroyCalls = 0;
    let produced = 0;
    const source = new Readable({
      read() {
        if (produced > 0) return;
        produced += 1;
        this.push(Buffer.of(1));
        setImmediate(() => this.emit('error', sourceFailure));
      },
    });
    const target = new RecordingTarget();
    target.destroy = (() => {
      destroyCalls += 1;
      throw cleanupFailure;
    }) as typeof target.destroy;

    const errors = await captureUncaughtErrors(async () => {
      await expect(writeResolvedResponse(target, resolved(), {
        getBody: async () => bodyAsset({ size: 1 }),
        openBody: () => source,
      })).rejects.toBe(sourceFailure);
    });
    const producedAtSettlement = produced;
    await waitForImmediate();

    expect(errors).toEqual([]);
    expect(destroyCalls).toBe(1);
    expect(source.destroyed).toBe(true);
    expect(target.destroyed).toBe(true);
    expect(produced).toBe(producedAtSettlement);
    expectNoLifecycleListeners(source);
    expectNoLifecycleListeners(target);
  });

  it('settles ownership without forging state when destination destroy and fallback both throw', async () => {
    const destinationFailure = new Error('destination failed');
    const cleanupFailure = new Error('destination destroy override failed');
    const fallbackFailure = new Error('destination fallback failed');
    let destroyCalls = 0;
    let fallbackCalls = 0;
    const target = new RecordingTarget();
    target.destroy = (() => {
      destroyCalls += 1;
      throw cleanupFailure;
    }) as typeof target.destroy;
    const getBody = vi.fn();
    const openBody = vi.fn();
    const writing = writeResolvedResponse(target, resolved({ delayMs: 60_000 }), {
      getBody,
      openBody,
    });
    const fallback = vi.spyOn(Writable.prototype, 'destroy').mockImplementation(() => {
      fallbackCalls += 1;
      throw fallbackFailure;
    });
    let rejection: unknown;

    const errors = await captureUncaughtErrors(async () => {
      try {
        target.emit('error', destinationFailure);
        rejection = await writing.catch(error => error);
      } finally {
        fallback.mockRestore();
      }
    });

    expect(rejection).toBe(destinationFailure);
    expect(errors).toEqual([]);
    expect(destroyCalls).toBe(1);
    expect(fallbackCalls).toBe(1);
    expect(target.destroyed).toBe(false);
    expect(target.closed).toBe(false);
    expect(target.statusCalls).toEqual([]);
    expect(getBody).not.toHaveBeenCalled();
    expect(openBody).not.toHaveBeenCalled();
    expectNoLifecycleListeners(target);
  });

  it('retains destination error consumers through async destroy failure during delay', async () => {
    const cancellation = new Error('request cancelled');
    const cleanupFailure = new Error('target cleanup failed');
    const { target, destroyStarted, completeDestroy } = controlledTarget();
    let beforeTeardown!: PromiseOutcome<number>;
    let rejection: unknown;

    const errors = await captureUncaughtErrors(async () => {
      const writing = writeResolvedResponse(target, resolved({ delayMs: 60_000 }), {
        getBody: vi.fn(),
        openBody: vi.fn(),
      });
      target.destroy(cancellation);
      await destroyStarted;
      beforeTeardown = await observeSettlement(writing);
      completeDestroy(cleanupFailure);
      rejection = await writing.catch(error => error);
    });

    expect(beforeTeardown).toEqual({ state: 'pending' });
    expect(rejection).toBe(cancellation);
    expect(errors).toEqual([]);
    expectNoLifecycleListeners(target);
  });

  it('retains destination error consumers through async destroy failure during metadata', async () => {
    const cancellation = new Error('request cancelled');
    const cleanupFailure = new Error('target cleanup failed');
    const metadata = deferred<BodyAsset>();
    const { target, destroyStarted, completeDestroy } = controlledTarget();
    const openBody = vi.fn(() => Readable.from([Buffer.of(1)]));
    let beforeTeardown!: PromiseOutcome<number>;
    let rejection: unknown;

    const errors = await captureUncaughtErrors(async () => {
      const writing = writeResolvedResponse(target, resolved(), {
        getBody: () => metadata.promise,
        openBody,
      });
      await waitForImmediate();
      target.destroy(cancellation);
      await destroyStarted;
      beforeTeardown = await observeSettlement(writing);
      completeDestroy(cleanupFailure);
      rejection = await writing.catch(error => error);
      metadata.resolve(bodyAsset());
    });

    expect(beforeTeardown).toEqual({ state: 'pending' });
    expect(rejection).toBe(cancellation);
    expect(errors).toEqual([]);
    expect(openBody).not.toHaveBeenCalled();
    expectNoLifecycleListeners(target);
  });

  it('retains both stream consumers through async destination destroy failure after open', async () => {
    const cancellation = new Error('request cancelled');
    const cleanupFailure = new Error('target cleanup failed');
    const source = Readable.from([Buffer.of(1)]);
    const { target, destroyStarted, completeDestroy } = controlledTarget();
    let beforeTeardown!: PromiseOutcome<number>;
    let rejection: unknown;

    const errors = await captureUncaughtErrors(async () => {
      const writing = writeResolvedResponse(target, resolved(), {
        getBody: async () => bodyAsset({ size: 1 }),
        openBody: () => {
          target.destroy(cancellation);
          return source;
        },
      });
      await destroyStarted;
      beforeTeardown = await observeSettlement(writing);
      completeDestroy(cleanupFailure);
      rejection = await writing.catch(error => error);
    });

    expect(beforeTeardown).toEqual({ state: 'pending' });
    expect(rejection).toBe(cancellation);
    expect(errors).toEqual([]);
    expect(source.destroyed).toBe(true);
    expectNoLifecycleListeners(source);
    expectNoLifecycleListeners(target);
  });

  it('settles successful async emitClose false source disposal by terminal state', async () => {
    const cancellation = new Error('request cancelled');
    const source = new Readable({
      emitClose: false,
      read() { this.push(Buffer.of(1)); },
      destroy(_error, callback) { setImmediate(() => callback()); },
    });
    const target = new RecordingTarget();
    const writing = writeResolvedResponse(target, resolved(), {
      getBody: async () => bodyAsset({ size: 1 }),
      openBody: () => {
        target.destroy(cancellation);
        return source;
      },
    });

    const outcome = await observeSettlement(writing);
    if (outcome.state === 'pending') {
      source.emit('close');
      await writing.catch(() => undefined);
    }

    expect(outcome).toEqual({ state: 'rejected', error: cancellation });
    expect(source.closed).toBe(true);
    expectNoLifecycleListeners(source);
    expectNoLifecycleListeners(target);
  });

  it('consumes failing async emitClose false source disposal and preserves cancellation', async () => {
    const cancellation = new Error('request cancelled');
    const source = new Readable({
      emitClose: false,
      read() { this.push(Buffer.of(1)); },
      destroy(_error, callback) {
        setImmediate(() => callback(new Error('source cleanup failed')));
      },
    });
    const target = new RecordingTarget();

    const errors = await captureUncaughtErrors(async () => {
      await expect(writeResolvedResponse(target, resolved(), {
        getBody: async () => bodyAsset({ size: 1 }),
        openBody: () => {
          target.destroy(cancellation);
          return source;
        },
      })).rejects.toBe(cancellation);
    });

    expect(errors).toEqual([]);
    expect(source.closed).toBe(true);
    expectNoLifecycleListeners(source);
    expectNoLifecycleListeners(target);
  });

  it('observes silent source self-destroy during active piping and settles teardown', async () => {
    let produced = 0;
    const source = new Readable({
      emitClose: false,
      read() {
        produced += 1;
        this.push(Buffer.of(produced));
        this.destroy();
      },
      destroy(_error, callback) { setImmediate(() => callback()); },
    });
    const target = new RecordingTarget();
    const writing = writeResolvedResponse(target, resolved(), {
      getBody: async () => bodyAsset({ size: 1 }),
      openBody: () => source,
    });

    const outcome = await observeSettlement(writing);
    if (outcome.state === 'pending') {
      source.emit('close');
      await writing.catch(() => undefined);
    }
    const producedAtSettlement = produced;
    await waitForImmediate();

    expect(outcome).toMatchObject({ state: 'rejected' });
    expect((outcome as { error?: Error }).error?.message).toMatch(/source.*closed|premature/i);
    expect(produced).toBe(producedAtSettlement);
    expectNoLifecycleListeners(source);
    expectNoLifecycleListeners(target);
  });

  it('uses an honest concrete body source contract with a real Express response', async () => {
    expectTypeOf<Response>().toMatchTypeOf<ResponseWriterTarget>();
    expectTypeOf<Parameters<ResponseBodyRepository['openBody']>>()
      .toEqualTypeOf<Parameters<ProjectRepository['openBody']>>();
    expectTypeOf<ResponseBodyRepository['openBody']>().returns.toEqualTypeOf<Readable>();

    const bodies: ResponseBodyRepository = {
      getBody: async () => bodyAsset({ encoding: undefined, size: 3 }),
      openBody: (): Readable => (
        Readable.from([Buffer.from([0x00, 0xff, 0x01])])
      ),
    };
    const app = express();
    app.get('/probe', async (_request, response, next) => {
      try {
        await writeResolvedResponse(response, resolved(), bodies);
      } catch (error) {
        next(error);
      }
    });

    const response = await request(app).get('/probe').expect(201);
    expect(response.headers['content-type']).toMatch('application/octet-stream');
    expect(response.body).toEqual(Buffer.from([0x00, 0xff, 0x01]));
  });

  it('rejects an already-closed destination before delay, writes, or body access', async () => {
    const target = new RecordingTarget();
    target.destroy();
    await waitForImmediate();
    const getBody = vi.fn();
    const openBody = vi.fn();

    await expect(writeResolvedResponse(target, resolved(), { getBody, openBody }))
      .rejects.toThrow(/destination.*closed|unavailable|cancel/i);

    expect(target.statusCalls).toEqual([]);
    expect(target.headerWrites).toEqual([]);
    expect(getBody).not.toHaveBeenCalled();
    expect(openBody).not.toHaveBeenCalled();
    expectNoLifecycleListeners(target);
  });

  it('cancels and clears a pending delay when the destination closes', async () => {
    vi.useFakeTimers();
    const target = new RecordingTarget();
    const getBody = vi.fn();
    const openBody = vi.fn();
    const writing = writeResolvedResponse(target, resolved({ delayMs: 250 }), { getBody, openBody });

    target.destroy();
    let outcome: PromiseOutcome<number> = { state: 'pending' };
    void writing.then(
      value => { outcome = { state: 'fulfilled', value }; },
      error => { outcome = { state: 'rejected', error }; },
    );
    await vi.advanceTimersByTimeAsync(0);
    const promptOutcome = outcome;
    if (promptOutcome.state === 'pending') {
      await vi.advanceTimersByTimeAsync(250);
      await writing.catch(() => undefined);
    }

    expect(promptOutcome).toMatchObject({ state: 'rejected' });
    expect(vi.getTimerCount()).toBe(0);
    expect(target.statusCalls).toEqual([]);
    expect(getBody).not.toHaveBeenCalled();
    expect(openBody).not.toHaveBeenCalled();
    expectNoLifecycleListeners(target);
  });

  it('settles promptly when the destination closes while metadata is pending', async () => {
    const metadata = deferred<BodyAsset>();
    const target = new RecordingTarget();
    const openBody = vi.fn(() => Readable.from([Buffer.of(1)]));
    const writing = writeResolvedResponse(target, resolved(), {
      getBody: () => metadata.promise,
      openBody,
    });
    await waitForImmediate();

    target.destroy();
    const outcome = await observeSettlement(writing);
    metadata.resolve(bodyAsset());
    if (outcome.state === 'pending') {
      await waitForImmediate();
      target.emit('close');
      await writing.catch(() => undefined);
    }

    expect(outcome).toMatchObject({ state: 'rejected' });
    expect(openBody).not.toHaveBeenCalled();
    expectNoLifecycleListeners(target);
  });

  it('does not consume a source when the destination closes during open', async () => {
    let produced = 0;
    const source = Readable.from((async function* () {
      produced += 1;
      yield Buffer.of(1);
    })());
    const target = new RecordingTarget();

    await expect(writeResolvedResponse(target, resolved(), {
      getBody: async () => bodyAsset({ size: 1 }),
      openBody: () => {
        target.emit('close');
        return source;
      },
    })).rejects.toThrow(/destination.*closed|unavailable|cancel|premature/i);

    expect(produced).toBe(0);
    expect(source.destroyed).toBe(true);
    expectNoLifecycleListeners(source);
    expectNoLifecycleListeners(target);
  });

  it('awaits empty-response completion and rejects cancellation during end', async () => {
    let finish!: (error?: Error | null) => void;
    const target = new RecordingTarget({ final: callback => { finish = callback; } });
    const writing = writeResolvedResponse(target, resolved({ bodyAssetId: undefined }), {
      getBody: vi.fn(),
      openBody: vi.fn(),
    });
    await waitForImmediate();
    expect(target.finalCalls).toBe(1);

    target.destroy();
    const outcome = await observeSettlement(writing);
    finish();
    await writing.catch(() => undefined);

    expect(outcome).toMatchObject({ state: 'rejected' });
    expectNoLifecycleListeners(target);
  });

  it('rejects an already-terminal source without consuming into the destination', async () => {
    const source = Readable.from([Buffer.of(1)]);
    source.destroy();
    await waitForImmediate();
    const target = new RecordingTarget();
    const writing = writeResolvedResponse(target, resolved(), {
      getBody: async () => bodyAsset({ size: 1 }),
      openBody: () => source,
    });

    const outcome = await observeSettlement(writing);
    if (outcome.state === 'pending') {
      target.destroy();
      await writing.catch(() => undefined);
    }

    expect(outcome).toMatchObject({ state: 'rejected' });
    expect(target.bytes()).toHaveLength(0);
    expectNoLifecycleListeners(source);
    expectNoLifecycleListeners(target);
  });

  it('settles emitClose false teardown and preserves the destination failure', async () => {
    const destinationFailure = new Error('destination failed');
    let destroyCalls = 0;
    const source = new Readable({
      emitClose: false,
      read() { this.push(Buffer.of(1)); },
      destroy(_error, callback) {
        destroyCalls += 1;
        setImmediate(() => callback());
      },
    });
    const target = new RecordingTarget({
      highWaterMark: 1,
      write: (_chunk, callback) => callback(destinationFailure),
    });
    const writing = writeResolvedResponse(target, resolved(), {
      getBody: async () => bodyAsset({ size: 1 }),
      openBody: () => source,
    });

    const outcome = await observeSettlement(writing);
    if (outcome.state === 'pending') {
      source.emit('close');
      await writing.catch(() => undefined);
    }

    expect(outcome).toEqual({ state: 'rejected', error: destinationFailure });
    expect(destroyCalls).toBe(1);
    expectNoLifecycleListeners(source);
    expectNoLifecycleListeners(target);
  });

  it('settles asynchronous destination cancellation when close emission is disabled', async () => {
    let sourceDestroyCalls = 0;
    const source = new Readable({
      emitClose: false,
      read() { this.push(Buffer.of(1)); },
      destroy(_error, callback) {
        sourceDestroyCalls += 1;
        setImmediate(() => callback());
      },
    });
    const target = new RecordingTarget({
      emitClose: false,
      highWaterMark: 1,
      destroy: (_error, callback) => setImmediate(() => callback()),
      write: () => target.destroy(),
    });
    const writing = writeResolvedResponse(target, resolved(), {
      getBody: async () => bodyAsset({ size: 1 }),
      openBody: () => source,
    });

    const outcome = await observeSettlement(writing);
    if (outcome.state === 'pending') {
      target.emit('close');
      source.emit('close');
      await writing.catch(() => undefined);
    }

    expect(outcome).toMatchObject({ state: 'rejected' });
    expect(sourceDestroyCalls).toBe(1);
    expectNoLifecycleListeners(source);
    expectNoLifecycleListeners(target);
  });

  it('consumes emitClose false cleanup errors while preserving the initiating failure', async () => {
    const destinationFailure = new Error('destination failed');
    const source = new Readable({
      emitClose: false,
      read() { this.push(Buffer.of(1)); },
      destroy(_error, callback) {
        setImmediate(() => callback(new Error('cleanup failed')));
      },
    });
    const target = new RecordingTarget({
      write: (_chunk, callback) => callback(destinationFailure),
    });

    const errors = await captureUncaughtErrors(async () => {
      await expect(writeResolvedResponse(target, resolved(), {
        getBody: async () => bodyAsset({ size: 1 }),
        openBody: () => source,
      })).rejects.toBe(destinationFailure);
    });

    expect(errors).toEqual([]);
    expectNoLifecycleListeners(source);
    expectNoLifecycleListeners(target);
  });

  it('rejects a body source that does not meet the concrete Readable contract', async () => {
    const broadSource = {
      on() { return this; },
      once() { return this; },
      off() { return this; },
      emit() { return false; },
      pause() { return this; },
      pipe(destination: NodeJS.WritableStream) {
        destination.end();
        return destination;
      },
      read() { return null; },
      resume() { return this; },
      setEncoding() { return this; },
      unpipe() { return this; },
      unshift() {},
      wrap() { return this; },
      isPaused() { return false; },
      [Symbol.asyncIterator]: async function* () {},
    } as unknown as NodeJS.ReadableStream;

    await expect(writeResolvedResponse(new RecordingTarget(), resolved(), {
      getBody: async () => bodyAsset({ size: 0 }),
      openBody: () => broadSource,
    })).rejects.toThrow(TypeError);
  });

  it('waits huge valid delays in timer-sized chunks', async () => {
    vi.useFakeTimers();
    const maximumTimerDelay = 2_147_483_647;
    const target = new RecordingTarget();
    const timer = vi.spyOn(globalThis, 'setTimeout');
    const writing = writeResolvedResponse(target, resolved({
      bodyAssetId: undefined,
      delayMs: maximumTimerDelay + 5,
    }), { getBody: vi.fn(), openBody: vi.fn() });

    expect(timer).toHaveBeenLastCalledWith(expect.any(Function), maximumTimerDelay);
    await vi.advanceTimersByTimeAsync(maximumTimerDelay);
    expect(target.statusCalls).toEqual([]);
    expect(timer).toHaveBeenLastCalledWith(expect.any(Function), 5);
    await vi.advanceTimersByTimeAsync(4);
    expect(target.statusCalls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await expect(writing).resolves.toBe(0);
  });

  it('awaits fresh metadata and streams exact binary bytes with body-owned content headers', async () => {
    const metadata = deferred<BodyAsset>();
    const getBody = vi.fn(() => metadata.promise);
    const source = Readable.from([Buffer.from([0x00, 0xff]), Buffer.from([0x01])]);
    const setEncoding = vi.spyOn(source, 'setEncoding');
    const openBody = vi.fn(() => source);
    const target = new RecordingTarget();
    const response = resolved({
      responseHeaders: {
        'content-type': 'text/plain',
        'CONTENT-LENGTH': '999',
        'Content-Encoding': 'br',
        'Transfer-Encoding': 'chunked',
        'set-cookie': ['session=one; Path=/', 'theme=dark; Path=/'],
        'X-Trace': 'trace-1',
      },
    });

    const writing = writeResolvedResponse(target, response, { getBody, openBody });
    await waitForImmediate();
    expect(getBody).toHaveBeenCalledWith('prj_1', assetId);
    expect(openBody).not.toHaveBeenCalled();

    metadata.resolve(bodyAsset());
    await expect(writing).resolves.toBe(3);

    expect(openBody).toHaveBeenCalledOnce();
    expect(openBody).toHaveBeenCalledWith('prj_1', assetId);
    expect(target.bytes()).toEqual(Buffer.from([0x00, 0xff, 0x01]));
    expect(setEncoding).not.toHaveBeenCalled();
    expect(target.statusCalls).toEqual([201]);
    expect(target.header('Content-Type')).toBe('text/plain');
    expect(target.header('Content-Length')).toBe(3);
    expect(target.header('Content-Encoding')).toBe('gzip');
    expect(target.header('X-Trace')).toBe('trace-1');
    expect(target.headerWrites).toContainEqual([
      'set-cookie',
      ['session=one; Path=/', 'theme=dark; Path=/'],
    ]);
    expect(target.headerWrites.map(([name]) => name)).toEqual([
      'content-type',
      'set-cookie',
      'X-Trace',
      'Content-Length',
      'Content-Encoding',
    ]);
  });

  it('prefers a body-bearing Variant Content-Type over Body Asset metadata', async () => {
    const target = new RecordingTarget();
    await writeResolvedResponse(target, resolved({
      responseHeaders: { 'content-type': 'application/vnd.example+json; profile=mobile' },
    }), {
      getBody: async () => bodyAsset({ size: 2 }),
      openBody: () => Readable.from([Buffer.from('{}')]),
    });
    expect(target.header('content-type'))
      .toBe('application/vnd.example+json; profile=mobile');
    expect(target.header('Content-Length')).toBe(2);
  });

  it('falls back to Body Asset Content-Type for a non-empty body-bearing Variant', async () => {
    const target = new RecordingTarget();

    await writeResolvedResponse(target, resolved({ responseHeaders: {} }), {
      getBody: async () => bodyAsset({ size: 2, mediaType: 'application/octet-stream' }),
      openBody: () => Readable.from([Buffer.from([0, 1])]),
    });

    expect(target.header('Content-Type')).toBe('application/octet-stream');
    expect(target.header('Content-Length')).toBe(2);
  });

  it('uses Body Asset Content-Type for an explicitly present empty body', async () => {
    const target = new RecordingTarget();

    await writeResolvedResponse(target, resolved({
      status: 200,
      responseHeaders: { 'Transfer-Encoding': 'chunked' },
    }), {
      getBody: async () => bodyAsset({ size: 0 }),
      openBody: () => Readable.from([]),
    });

    expect(target.header('Content-Type')).toBe('application/octet-stream');
    expect(target.header('Content-Length')).toBe(0);
    expect(target.header('Transfer-Encoding')).toBeUndefined();
  });

  it.each([100, 103, 199])('rejects informational authored status %s before response commit', async status => {
    const getBody = vi.fn(async () => bodyAsset({ size: 3 }));
    const openBody = vi.fn(() => Readable.from('abc'));
    const target = new RecordingTarget();

    await expect(writeResolvedResponse(target, resolved({ status }), { getBody, openBody }))
      .rejects.toThrow('Authored response status must be a final HTTP status');

    expect(target.statusCalls).toEqual([]);
    expect(target.headerWrites).toEqual([]);
    expect(target.finalCalls).toBe(0);
    expect(target.bytes()).toEqual(Buffer.alloc(0));
    expect(getBody).not.toHaveBeenCalled();
    expect(openBody).not.toHaveBeenCalled();
  });

  it.each([
    ['no content', 204, 'GET'],
    ['reset content', 205, 'GET'],
    ['not modified', 304, 'GET'],
    ['HEAD', 200, 'HEAD'],
  ])('does not access or observe a configured Body Asset for a %s response', async (
    _name,
    status,
    method,
  ) => {
    const getBody = vi.fn(async () => bodyAsset({ size: 3 }));
    const openBody = vi.fn(() => Readable.from('abc'));
    const target = new RecordingTarget();

    await expect(writeResolvedResponse(target, resolved({
      status,
      responseHeaders: {
        'X-Protocol': 'bodyless',
        'Transfer-Encoding': 'chunked',
        'X-Repeat': ['one', 'two'],
      },
    }), { getBody, openBody }, method)).resolves.toBe(0);

    expect(target.statusCalls).toEqual([status]);
    expect(target.header('X-Protocol')).toBe('bodyless');
    expect(target.header('Content-Type')).toBeUndefined();
    expect(target.header('Content-Length')).toBe(status === 205 ? 0 : undefined);
    expect(target.header('Transfer-Encoding')).toBeUndefined();
    expect(target.header('X-Repeat')).toEqual(['one', 'two']);
    expect(target.bytes()).toEqual(Buffer.alloc(0));
    expect(getBody).not.toHaveBeenCalled();
    expect(openBody).not.toHaveBeenCalled();
  });

  it('preserves bodyless Variant Content-Type without accessing the body repository', async () => {
    const getBody = vi.fn();
    const openBody = vi.fn();
    const target = new RecordingTarget();

    await writeResolvedResponse(target, resolved({
      bodyAssetId: undefined,
      responseHeaders: { 'Content-Type': 'application/problem+json' },
    }), { getBody, openBody });

    expect(target.header('Content-Type')).toBe('application/problem+json');
    expect(target.header('Content-Length')).toBe(0);
    expect(getBody).not.toHaveBeenCalled();
    expect(openBody).not.toHaveBeenCalled();
  });

  it('omits a conflicting resolved content encoding when metadata has none', async () => {
    const target = new RecordingTarget();
    await writeResolvedResponse(target, resolved({
      responseHeaders: { 'CONTENT-ENCODING': 'br', 'x-safe': 'yes' },
    }), {
      getBody: async () => bodyAsset({ encoding: undefined }),
      openBody: () => Readable.from([Buffer.from([0, 1, 2])]),
    });

    expect(target.header('Content-Encoding')).toBeUndefined();
    expect(target.header('x-safe')).toBe('yes');
  });

  it('waits the full delay before committing an empty response', async () => {
    vi.useFakeTimers();
    const getBody = vi.fn();
    const openBody = vi.fn();
    const target = new RecordingTarget();

    const writing = writeResolvedResponse(target, resolved({
      delayMs: 250,
      bodyAssetId: undefined,
      responseHeaders: { 'X-Empty': 'yes' },
    }), { getBody, openBody });

    await vi.advanceTimersByTimeAsync(249);
    expect(target.statusCalls).toEqual([]);
    expect(target.headerWrites).toEqual([]);
    expect(target.finalCalls).toBe(0);

    await vi.advanceTimersByTimeAsync(1);
    await expect(writing).resolves.toBe(0);
    expect(target.statusCalls).toEqual([201]);
    expect(target.header('X-Empty')).toBe('yes');
    expect(target.header('Content-Length')).toBe(0);
    expect(target.finalCalls).toBe(1);
    expect(getBody).not.toHaveBeenCalled();
    expect(openBody).not.toHaveBeenCalled();
  });

  it('propagates metadata and synchronous open failures', async () => {
    const metadataFailure = new Error('metadata failed');
    const metadataOpen = vi.fn();
    await expect(writeResolvedResponse(new RecordingTarget(), resolved(), {
      getBody: async () => { throw metadataFailure; },
      openBody: metadataOpen,
    })).rejects.toBe(metadataFailure);
    expect(metadataOpen).not.toHaveBeenCalled();

    const openFailure = new Error('open failed');
    await expect(writeResolvedResponse(new RecordingTarget(), resolved(), {
      getBody: async () => bodyAsset(),
      openBody: () => { throw openFailure; },
    })).rejects.toBe(openFailure);
  });

  it('propagates a source failure and removes lifecycle listeners', async () => {
    const sourceFailure = new Error('source failed');
    let destroyCalls = 0;
    let reads = 0;
    const source = new Readable({
      read() {
        reads += 1;
        if (reads === 1) this.push(Buffer.of(1));
        else this.emit('error', sourceFailure);
      },
      destroy(_error, callback) {
        destroyCalls += 1;
        setImmediate(() => callback(new Error('asynchronous cleanup failed')));
      },
    });
    const target = new RecordingTarget();

    const errors = await captureUncaughtErrors(async () => {
      await expect(writeResolvedResponse(target, resolved(), {
        getBody: async () => bodyAsset(),
        openBody: () => source,
      })).rejects.toBe(sourceFailure);
    });

    expect(errors).toEqual([]);
    expect(destroyCalls).toBe(1);
    expect(source.destroyed).toBe(true);
    expect(source.listenerCount('error')).toBe(0);
    expect(source.listenerCount('close')).toBe(0);
    expect(source.listenerCount('end')).toBe(0);
    expect(target.listenerCount('error')).toBe(0);
    expect(target.listenerCount('close')).toBe(0);
    expect(target.listenerCount('finish')).toBe(0);
  });

  it('stops production once the destination fails and settles asynchronous destroy failure', async () => {
    const destinationFailure = new Error('destination failed');
    let destroyCalls = 0;
    let produced = 0;
    const source = new Readable({
      read() {
        produced += 1;
        this.push(Buffer.alloc(1024, produced));
      },
      destroy(_error, callback) {
        destroyCalls += 1;
        setImmediate(() => callback(new Error('asynchronous cleanup failed')));
      },
    });
    const target = new RecordingTarget({
      autoDestroy: false,
      highWaterMark: 1,
      write: (_chunk, callback) => setImmediate(() => callback(destinationFailure)),
    });

    const errors = await captureUncaughtErrors(async () => {
      await expect(writeResolvedResponse(target, resolved({ bodyAssetId: assetId }), {
        getBody: async () => bodyAsset({ size: 1024 }),
        openBody: () => source,
      })).rejects.toBe(destinationFailure);
    });
    const producedAtSettlement = produced;
    await waitForImmediate();

    expect(errors).toEqual([]);
    expect(produced).toBe(producedAtSettlement);
    expect(destroyCalls).toBe(1);
    expect(source.destroyed).toBe(true);
    expect(target.destroyed).toBe(true);
    expect(source.listenerCount('error')).toBe(0);
    expect(source.listenerCount('close')).toBe(0);
  });

  it('tears down exactly once when the destination is cancelled', async () => {
    let destroyCalls = 0;
    let produced = 0;
    const source = new Readable({
      read() {
        produced += 1;
        this.push(Buffer.alloc(1024, produced));
      },
      destroy(error, callback) {
        destroyCalls += 1;
        setImmediate(() => callback(error));
      },
    });
    const target = new RecordingTarget({
      highWaterMark: 1,
      write: () => target.destroy(),
    });

    await expect(writeResolvedResponse(target, resolved(), {
      getBody: async () => bodyAsset({ size: 1024 }),
      openBody: () => source,
    })).rejects.toThrow(/closed|premature|cancel/i);
    const producedAtSettlement = produced;
    await waitForImmediate();

    expect(produced).toBe(producedAtSettlement);
    expect(destroyCalls).toBe(1);
    expect(source.listenerCount('error')).toBe(0);
    expect(source.listenerCount('close')).toBe(0);
    expect(target.listenerCount('error')).toBe(0);
    expect(target.listenerCount('close')).toBe(0);
    expect(target.listenerCount('finish')).toBe(0);
  });

  it('honors writable backpressure instead of eagerly consuming the complete source', async () => {
    const callbacks: Array<() => void> = [];
    let produced = 0;
    const source = Readable.from((async function* () {
      for (let index = 0; index < 8; index += 1) {
        produced += 1;
        yield Buffer.alloc(1024, index);
      }
    })());
    const target = new RecordingTarget({
      highWaterMark: 1,
      write: (_chunk, callback) => callbacks.push(callback),
    });
    const writing = writeResolvedResponse(target, resolved(), {
      getBody: async () => bodyAsset({ size: 8 * 1024 }),
      openBody: () => source,
    });

    while (callbacks.length === 0) await waitForImmediate();
    expect(produced).toBeLessThan(8);

    for (let index = 0; index < 8; index += 1) {
      while (callbacks.length === 0) await waitForImmediate();
      callbacks.shift()!();
      await waitForImmediate();
    }

    await expect(writing).resolves.toBe(8 * 1024);
    expect(target.bytes()).toHaveLength(8 * 1024);
    expect(source.listenerCount('error')).toBe(0);
    expect(source.listenerCount('close')).toBe(0);
    expect(source.listenerCount('end')).toBe(0);
  });
});
