import { EditorState, Text } from '@codemirror/state';
import { describe, expect, it, vi } from 'vitest';

import {
  createBodyDocumentCache,
  type BodyDocumentIdentity,
} from './bodyDocumentCache';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function identity(id: string, projectId = 'prj_1'): BodyDocumentIdentity {
  return {
    kind: 'traffic', projectId, trafficId: id, side: 'response', sha256: id.padEnd(64, 'a'),
  };
}

function loaded(value: string, byteCount = new TextEncoder().encode(value).byteLength) {
  return { text: Text.of([value]), byteCount };
}

describe('BodyDocumentCache', () => {
  it('deduplicates concurrent acquisition and publishes immutable snapshots', async () => {
    const pending = deferred<ReturnType<typeof loaded>>();
    const load = vi.fn(() => pending.promise);
    const cache = createBodyDocumentCache();
    const first = cache.acquire({ identity: identity('one'), active: true, dirty: false, load });
    const second = cache.acquire({ identity: identity('one'), active: true, dirty: false, load });
    const loading = first.getSnapshot();

    expect(load).toHaveBeenCalledOnce();
    pending.resolve(loaded('hello'));
    await vi.waitFor(() => expect(first.getSnapshot().state).toBe('ready'));
    expect(second.getSnapshot()).toBe(first.getSnapshot());
    expect(first.getSnapshot()).not.toBe(loading);
    expect(first.getSnapshot()).toMatchObject({
      state: 'ready', byteCount: 5, documentGeneration: 1, validationGeneration: 1,
    });
    first.release();
    second.release();
  });

  it('runs two loads and preempts the oldest inactive owner for an active document', async () => {
    const started: string[] = [];
    const aborted: string[] = [];
    const gates = new Map<string, ReturnType<typeof deferred<ReturnType<typeof loaded>>>>();
    const cache = createBodyDocumentCache();
    const acquire = (id: string, active: boolean) => cache.acquire({
      identity: identity(id), active, dirty: false,
      load: signal => {
        started.push(id);
        signal.addEventListener('abort', () => aborted.push(id), { once: true });
        const gate = deferred<ReturnType<typeof loaded>>();
        gates.set(id, gate);
        return gate.promise;
      },
    });

    const first = acquire('one', false);
    const second = acquire('two', false);
    const third = acquire('three', true);
    await vi.waitFor(() => expect(started).toEqual(['one', 'two', 'three']));
    expect(aborted).toEqual(['one']);
    expect(second.getSnapshot().state).toBe('loading');
    expect(third.getSnapshot().state).toBe('loading');
    gates.get('two')!.resolve(loaded('two'));
    gates.get('three')!.resolve(loaded('three'));
    await vi.waitFor(() => expect(third.getSnapshot().state).toBe('ready'));
    first.release();
    second.release();
    third.release();
  });

  it('rejects stale progress, success, error, and finalization after Project invalidation', async () => {
    const pending = deferred<ReturnType<typeof loaded>>();
    let progress!: (loadedBytes: number, totalBytes?: number) => void;
    const cache = createBodyDocumentCache();
    const handle = cache.acquire({
      identity: identity('one'), active: true, dirty: false,
      load: (_signal, publishProgress) => {
        progress = publishProgress;
        return pending.promise;
      },
    });
    await vi.waitFor(() => expect(handle.getSnapshot().state).toBe('loading'));
    const invalidated = handle.getSnapshot();
    cache.invalidateProject('prj_1');
    progress(4, 8);
    pending.resolve(loaded('stale'));
    await Promise.resolve();
    await Promise.resolve();

    expect(handle.getSnapshot()).toBe(invalidated);
  });

  it('evicts clean least-recently-used documents by count and bytes but protects active and dirty entries', async () => {
    const cache = createBodyDocumentCache();
    const loads = new Map<string, number>();
    const open = async (id: string, byteCount = 1, active = false, dirty = false) => {
      const handle = cache.acquire({
        identity: identity(id), active, dirty,
        async load() {
          loads.set(id, (loads.get(id) ?? 0) + 1);
          return loaded(id, byteCount);
        },
      });
      await vi.waitFor(() => expect(handle.getSnapshot().state).toBe('ready'));
      handle.release();
    };
    for (let index = 0; index < 13; index += 1) await open(`count-${index}`);
    await open('count-0');
    await open('count-12');
    expect(loads.get('count-0')).toBe(2);
    expect(loads.get('count-12')).toBe(1);

    const protectedActive = cache.acquire({
      identity: identity('active'), active: true, dirty: false,
      async load() { return loaded('active', 140 * 1024 * 1024); },
    });
    const protectedDirty = cache.acquire({
      identity: identity('dirty'), active: false, dirty: true,
      async load() { return loaded('dirty', 140 * 1024 * 1024); },
    });
    await vi.waitFor(() => expect(protectedDirty.getSnapshot().state).toBe('ready'));
    protectedActive.release();
    protectedDirty.release();
    const activeAgain = cache.acquire({
      identity: identity('active'), active: true, dirty: false,
      async load() { throw new Error('active document was evicted'); },
    });
    const dirtyAgain = cache.acquire({
      identity: identity('dirty'), active: false, dirty: true,
      async load() { throw new Error('dirty document was evicted'); },
    });
    expect(activeAgain.getSnapshot().state).toBe('ready');
    expect(dirtyAgain.getSnapshot().state).toBe('ready');
  });

  it('owns EditorState transactions and rejects stale generations and foreign start states', async () => {
    const cache = createBodyDocumentCache();
    const handle = cache.acquire({
      identity: identity('one'), active: true, dirty: true,
      async load() { return loaded('héllo'); },
    });
    await vi.waitFor(() => expect(handle.getSnapshot().state).toBe('ready'));
    const initial = handle.getSnapshot();
    const transaction = initial.editorState!.update({ changes: { from: 1, to: 2, insert: 'i' } });

    expect(handle.dispatch(transaction, initial.documentGeneration)).toBe(true);
    expect(handle.getSnapshot()).toMatchObject({
      byteCount: 5,
      documentGeneration: initial.documentGeneration + 1,
      validationGeneration: initial.validationGeneration + 1,
    });
    expect(handle.getSnapshot().editorState?.doc.toString()).toBe('hillo');
    expect(handle.dispatch(transaction, initial.documentGeneration)).toBe(false);
    const foreign = EditorState.create({ doc: 'foreign' }).update({ changes: { from: 0, insert: 'x' } });
    expect(handle.dispatch(foreign, handle.getSnapshot().documentGeneration)).toBe(false);
  });

  it('ignores callbacks from an older retry generation', async () => {
    const attempts: Array<{
      gate: ReturnType<typeof deferred<ReturnType<typeof loaded>>>;
      progress(loadedBytes: number, totalBytes?: number): void;
    }> = [];
    const cache = createBodyDocumentCache();
    const handle = cache.acquire({
      identity: identity('one'), active: true, dirty: false,
      load: (_signal, progress) => {
        const gate = deferred<ReturnType<typeof loaded>>();
        attempts.push({ gate, progress });
        return gate.promise;
      },
    });
    await vi.waitFor(() => expect(attempts).toHaveLength(1));
    attempts[0]!.gate.reject(new Error('first failed'));
    await vi.waitFor(() => expect(handle.getSnapshot().state).toBe('error'));
    handle.retry();
    await vi.waitFor(() => expect(attempts).toHaveLength(2));
    attempts[0]!.progress(99, 100);
    attempts[1]!.progress(2, 4);
    expect(handle.getSnapshot().progress).toEqual({ loadedBytes: 2, totalBytes: 4 });
    attempts[1]!.gate.resolve(loaded('done'));
    await vi.waitFor(() => expect(handle.getSnapshot().state).toBe('ready'));
  });

  it('cancels an active pending load when its final owning handle releases', async () => {
    let signal!: AbortSignal;
    const cache = createBodyDocumentCache();
    const handle = cache.acquire({
      identity: identity('released-active'),
      active: true,
      dirty: false,
      load: owner => {
        signal = owner;
        return new Promise(() => undefined);
      },
    });
    await vi.waitFor(() => expect(handle.getSnapshot().state).toBe('loading'));

    cache.deactivate(handle.identity);
    handle.release();

    expect(signal.aborted).toBe(true);
  });
});
