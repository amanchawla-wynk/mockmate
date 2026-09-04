import { EditorState, type Text, type Transaction } from '@codemirror/state';

export type BodyDocumentIdentity =
  | {
    kind: 'mock';
    projectId: string;
    endpointId: string;
    variantId: string;
    variantRevision: number;
    bodyAssetId?: string;
  }
  | {
    kind: 'traffic';
    projectId: string;
    trafficId: string;
    side: 'request' | 'response';
    sha256: string;
  };

export interface BodyDocumentSnapshot {
  state: 'queued' | 'loading' | 'ready' | 'error';
  progress: { loadedBytes: number; totalBytes?: number };
  documentGeneration: number;
  validationGeneration: number;
  byteCount: number;
  editorState?: EditorState;
  error?: string;
}

export interface BodyDocumentHandle {
  readonly identity: BodyDocumentIdentity;
  getSnapshot(): BodyDocumentSnapshot;
  subscribe(listener: () => void): () => void;
  dispatch(transaction: Transaction, expectedDocumentGeneration: number): boolean;
  retry(): void;
  release(): void;
}

export interface BodyDocumentCache {
  acquire(input: {
    identity: BodyDocumentIdentity;
    active: boolean;
    dirty: boolean;
    load(
      signal: AbortSignal,
      progress: (loadedBytes: number, totalBytes?: number) => void,
    ): Promise<{ text: Text; byteCount: number; editorState?: EditorState }>;
  }): BodyDocumentHandle;
  setActive(identity: BodyDocumentIdentity | undefined): void;
  deactivate(identity: BodyDocumentIdentity): void;
  setDirty(identity: BodyDocumentIdentity, dirty: boolean): void;
  invalidate(identity: BodyDocumentIdentity): void;
  invalidateProject(projectId: string): void;
}

interface CacheEntry {
  key: string;
  identity: BodyDocumentIdentity;
  snapshot: BodyDocumentSnapshot;
  listeners: Set<() => void>;
  load: Parameters<BodyDocumentCache['acquire']>[0]['load'];
  references: number;
  active: boolean;
  dirty: boolean;
  lastUsed: number;
  requestGeneration: number;
  request?: LoadOwner;
}

interface LoadOwner {
  entry: CacheEntry;
  generation: number;
  controller: AbortController;
  started: number;
}

const DEFAULT_MAX_CONCURRENT_LOADS = 2;
const DEFAULT_MAX_DOCUMENTS = 12;
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;

export function bodyDocumentIdentityKey(identity: BodyDocumentIdentity): string {
  if (identity.kind === 'traffic') {
    return ['traffic', identity.projectId, identity.trafficId, identity.side, identity.sha256]
      .map(value => `${value.length}:${value}`).join('|');
  }
  return [
    'mock', identity.projectId, identity.endpointId, identity.variantId,
    String(identity.variantRevision), identity.bodyAssetId ?? '',
  ].map(value => `${value.length}:${value}`).join('|');
}

function immutableSnapshot(input: BodyDocumentSnapshot): BodyDocumentSnapshot {
  const progress = Object.freeze({ ...input.progress });
  return Object.freeze({ ...input, progress });
}

function initialSnapshot(): BodyDocumentSnapshot {
  return immutableSnapshot({
    state: 'queued',
    progress: { loadedBytes: 0 },
    documentGeneration: 0,
    validationGeneration: 0,
    byteCount: 0,
  });
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function createBodyDocumentCache(options: {
  maxConcurrentLoads?: number;
  maxDocuments?: number;
  maxBytes?: number;
} = {}): BodyDocumentCache {
  const maxConcurrentLoads = options.maxConcurrentLoads ?? DEFAULT_MAX_CONCURRENT_LOADS;
  const maxDocuments = options.maxDocuments ?? DEFAULT_MAX_DOCUMENTS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const entries = new Map<string, CacheEntry>();
  const queued = new Set<CacheEntry>();
  const running = new Set<LoadOwner>();
  let clock = 0;
  let activeKey: string | undefined;

  const publish = (entry: CacheEntry, snapshot: BodyDocumentSnapshot): void => {
    entry.snapshot = immutableSnapshot(snapshot);
    for (const listener of entry.listeners) listener();
  };

  const evict = (): void => {
    const ready = [...entries.values()].filter(entry => entry.snapshot.state === 'ready');
    let count = ready.length;
    let bytes = ready.reduce((total, entry) => total + entry.snapshot.byteCount, 0);
    const candidates = ready
      .filter(entry => entry.references === 0 && !entry.active && !entry.dirty)
      .sort((left, right) => left.lastUsed - right.lastUsed);
    for (const candidate of candidates) {
      if (count <= maxDocuments && bytes <= maxBytes) break;
      entries.delete(candidate.key);
      count -= 1;
      bytes -= candidate.snapshot.byteCount;
    }
  };

  const isCurrent = (owner: LoadOwner): boolean => (
    entries.get(owner.entry.key) === owner.entry
    && owner.entry.request === owner
    && owner.entry.requestGeneration === owner.generation
  );

  const enqueue = (entry: CacheEntry): void => {
    if (entries.get(entry.key) !== entry || entry.request !== undefined) return;
    queued.add(entry);
  };

  const schedule = (): void => {
    while (running.size < maxConcurrentLoads && queued.size > 0) {
      const candidates = [...queued];
      const entry = candidates.find(candidate => candidate.active)
        ?? candidates.sort((left, right) => left.lastUsed - right.lastUsed)[0]!;
      queued.delete(entry);
      if (entries.get(entry.key) !== entry || entry.request !== undefined) continue;
      const owner: LoadOwner = {
        entry,
        generation: entry.requestGeneration += 1,
        controller: new AbortController(),
        started: clock += 1,
      };
      entry.request = owner;
      running.add(owner);
      publish(entry, {
        ...entry.snapshot,
        state: 'loading',
        progress: { loadedBytes: 0 },
        error: undefined,
      });
      void entry.load(owner.controller.signal, (loadedBytes, totalBytes) => {
        if (!isCurrent(owner)) return;
        publish(entry, {
          ...entry.snapshot,
          progress: {
            loadedBytes,
            ...(totalBytes === undefined ? {} : { totalBytes }),
          },
        });
      }).then(result => {
        if (!isCurrent(owner)) return;
        entry.request = undefined;
        entry.lastUsed = clock += 1;
        publish(entry, {
          state: 'ready',
          progress: { loadedBytes: result.byteCount, totalBytes: result.byteCount },
          documentGeneration: entry.snapshot.documentGeneration + 1,
          validationGeneration: entry.snapshot.validationGeneration + 1,
          byteCount: result.byteCount,
          editorState: result.editorState ?? EditorState.create({ doc: result.text }),
        });
        evict();
      }).catch(error => {
        if (!isCurrent(owner)) return;
        entry.request = undefined;
        publish(entry, {
          ...entry.snapshot,
          state: 'error',
          error: error instanceof Error ? error.message : 'Body document load failed',
        });
      }).finally(() => {
        running.delete(owner);
        if (isCurrent(owner)) entry.request = undefined;
        schedule();
      });
    }
  };

  const cancelOwner = (owner: LoadOwner, requeue: boolean): void => {
    if (!isCurrent(owner)) return;
    owner.entry.request = undefined;
    running.delete(owner);
    owner.controller.abort();
    if (requeue) {
      publish(owner.entry, {
        ...owner.entry.snapshot,
        state: 'queued',
        progress: { loadedBytes: 0 },
      });
      enqueue(owner.entry);
    }
  };

  const prioritize = (entry: CacheEntry): void => {
    if (!entry.active || running.size < maxConcurrentLoads || entry.request !== undefined) return;
    const oldestInactive = [...running]
      .filter(owner => !owner.entry.active && !owner.entry.dirty)
      .sort((left, right) => left.started - right.started)[0];
    if (oldestInactive !== undefined) cancelOwner(oldestInactive, true);
  };

  const remove = (entry: CacheEntry): void => {
    queued.delete(entry);
    if (entry.request !== undefined) cancelOwner(entry.request, false);
    entries.delete(entry.key);
  };

  const cache: BodyDocumentCache = {
    acquire(input) {
      const key = bodyDocumentIdentityKey(input.identity);
      let entry = entries.get(key);
      if (entry === undefined) {
        entry = {
          key,
          identity: { ...input.identity },
          snapshot: initialSnapshot(),
          listeners: new Set(),
          load: input.load,
          references: 0,
          active: false,
          dirty: input.dirty,
          lastUsed: clock += 1,
          requestGeneration: 0,
        };
        entries.set(key, entry);
        enqueue(entry);
      } else {
        entry.load = input.load;
        entry.lastUsed = clock += 1;
        if (input.dirty) entry.dirty = true;
      }
      if (input.active) {
        activeKey = key;
        for (const candidate of entries.values()) candidate.active = candidate.key === key;
      }
      entry.references += 1;
      prioritize(entry);
      schedule();

      let released = false;
      const ownedEntry = entry;
      return {
        identity: { ...ownedEntry.identity },
        getSnapshot: () => ownedEntry.snapshot,
        subscribe(listener) {
          ownedEntry.listeners.add(listener);
          return () => ownedEntry.listeners.delete(listener);
        },
        dispatch(transaction, expectedDocumentGeneration) {
          const snapshot = ownedEntry.snapshot;
          if (entries.get(ownedEntry.key) !== ownedEntry
            || snapshot.state !== 'ready'
            || snapshot.editorState === undefined
            || snapshot.documentGeneration !== expectedDocumentGeneration
            || transaction.startState !== snapshot.editorState) return false;
          let nextByteCount = snapshot.byteCount;
          transaction.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
            nextByteCount -= byteLength(transaction.startState.doc.sliceString(fromA, toA));
            nextByteCount += byteLength(inserted.toString());
          });
          publish(ownedEntry, {
            ...snapshot,
            editorState: transaction.state,
            byteCount: nextByteCount,
            documentGeneration: snapshot.documentGeneration + 1,
            validationGeneration: snapshot.validationGeneration + (transaction.docChanged ? 1 : 0),
          });
          ownedEntry.lastUsed = clock += 1;
          return true;
        },
        retry() {
          if (entries.get(ownedEntry.key) !== ownedEntry
            || ownedEntry.snapshot.state !== 'error'
            || ownedEntry.request !== undefined) return;
          publish(ownedEntry, {
            ...ownedEntry.snapshot,
            state: 'queued',
            progress: { loadedBytes: 0 },
            error: undefined,
          });
          enqueue(ownedEntry);
          prioritize(ownedEntry);
          schedule();
        },
        release() {
          if (released) return;
          released = true;
          ownedEntry.references = Math.max(0, ownedEntry.references - 1);
          ownedEntry.lastUsed = clock += 1;
          if (ownedEntry.references === 0
            && !ownedEntry.active
            && !ownedEntry.dirty
            && ownedEntry.snapshot.state !== 'ready') {
            remove(ownedEntry);
            schedule();
          } else {
            evict();
          }
        },
      };
    },

    setActive(identity) {
      activeKey = identity === undefined ? undefined : bodyDocumentIdentityKey(identity);
      for (const entry of entries.values()) entry.active = entry.key === activeKey;
      const active = activeKey === undefined ? undefined : entries.get(activeKey);
      if (active !== undefined) {
        prioritize(active);
        schedule();
      }
      evict();
    },

    deactivate(identity) {
      const key = bodyDocumentIdentityKey(identity);
      if (activeKey !== key) return;
      activeKey = undefined;
      const entry = entries.get(key);
      if (entry !== undefined) entry.active = false;
      evict();
    },

    setDirty(identity, dirty) {
      const entry = entries.get(bodyDocumentIdentityKey(identity));
      if (entry === undefined) return;
      entry.dirty = dirty;
      entry.lastUsed = clock += 1;
      evict();
    },

    invalidate(identity) {
      const entry = entries.get(bodyDocumentIdentityKey(identity));
      if (entry === undefined) return;
      remove(entry);
      if (activeKey === entry.key) activeKey = undefined;
      schedule();
    },

    invalidateProject(projectId) {
      for (const entry of [...entries.values()]) {
        if (entry.identity.projectId === projectId) remove(entry);
      }
      if (activeKey !== undefined && !entries.has(activeKey)) activeKey = undefined;
      schedule();
    },
  };
  return cache;
}
