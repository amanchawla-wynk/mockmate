import { describe, expect, it, vi } from 'vitest';

import { normalizeHttpOrigin } from '../domain/http-origin';
import { TRAFFIC_LIMITS, type TrafficStore } from '../domain/traffic';
import type { FileSystem } from '../repository/file-system';
import type { ProjectRepository } from '../repository/project-repository';
import { createTrafficPromoter } from '../repository/traffic-promotion';
import type { TrafficBodyBudgetManager } from './traffic-body-budget';
import type { TrafficBodyCache } from './traffic-body-cache';
import { createTrafficService } from './traffic-service';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(settle => { resolve = settle; });
  return { promise, resolve };
}

function harness(overrides: {
  storeClear?: () => Promise<void>;
  cacheClear?: () => Promise<void>;
  cacheDispose?: () => Promise<void>;
  append?: TrafficStore['append'];
  snapshot?: TrafficStore['snapshotForAcceptance'];
  attachPromotion?: TrafficStore['attachPromotion'];
  cacheAcquire?: TrafficBodyCache['acquire'];
} = {}) {
  const store = {
    registerGeneration: vi.fn(),
    append: overrides.append ?? vi.fn(async () => true),
    list: vi.fn(() => ({ entries: [], hasMore: false })),
    get: vi.fn(),
    updateBody: vi.fn(() => false),
    snapshotForAcceptance: vi.fn(overrides.snapshot),
    attachPromotion: vi.fn(overrides.attachPromotion ?? (() => false)),
    clear: vi.fn(overrides.storeClear ?? (async () => undefined)),
  } as unknown as TrafficStore;
  const cache = {
    clearProject: vi.fn(overrides.cacheClear ?? (async () => undefined)),
    dispose: vi.fn(overrides.cacheDispose ?? (async () => undefined)),
    acquire: vi.fn(overrides.cacheAcquire),
  } as unknown as TrafficBodyCache;
  const repository = {
    getRuntimeSettings: vi.fn(() => ({ captureRawTraffic: false })),
  } as unknown as ProjectRepository;
  const budgets = {
    reserveSidecar: vi.fn(() => ({ ok: false, reason: 'sidecar_limit' })),
  } as unknown as TrafficBodyBudgetManager;
  const { service, promotionAcceptor, installPromoter } = createTrafficService({
    runtimeNamespace: 'runtime_test',
    repository,
    store,
    cache,
    budgets,
    fileSystem: {} as FileSystem,
    limits: TRAFFIC_LIMITS,
  });
  return { service, promotionAcceptor, installPromoter, store, cache };
}

function begin(service: ReturnType<typeof harness>['service'], requestId: string) {
  return service.begin({
    projectId: 'project_1',
    requestId,
    transport: 'direct',
    allowlistPattern: 'api.example.test',
    origin: normalizeHttpOrigin('http://api.example.test'),
    method: 'GET',
    path: '/',
    query: { ok: true, entries: [] },
    headers: [],
    appState: { mode: 'disabled', fallbackReasons: ['app_state_mode_disabled'] },
  });
}

describe('Traffic service lifecycle', () => {
  it('closes Project admission and initiates both clear phases before awaiting either queue', async () => {
    const storeClear = deferred();
    const cacheClear = deferred();
    const { service, store, cache } = harness({
      storeClear: () => storeClear.promise,
      cacheClear: () => cacheClear.promise,
    });

    const clearing = service.clear('project_1');

    expect(store.clear).toHaveBeenCalledWith('project_1');
    expect(cache.clearProject).toHaveBeenCalledWith('project_1');
    expect(() => begin(service, 'during_clear')).toThrow('Traffic service is unavailable');
    storeClear.resolve();
    cacheClear.resolve();
    await clearing;
    expect(() => begin(service, 'after_clear')).not.toThrow();
    await service.dispose();
  });

  it('starts capture cancellation before awaiting active finalization', async () => {
    const append = deferred<boolean>();
    const cacheDispose = deferred();
    const { service, cache } = harness({
      append: vi.fn(() => append.promise),
      cacheDispose: () => cacheDispose.promise,
    });
    const exchange = begin(service, 'active_finalization');
    exchange.setDecision({
      decision: 'direct_miss',
      appState: { mode: 'disabled', fallbackReasons: ['app_state_mode_disabled'] },
    });
    exchange.setResponse(404, []);
    const finalization = exchange.finalize({ kind: 'response', status: 404, responseBytes: 0 });

    const disposal = service.dispose();

    expect(cache.dispose).toHaveBeenCalledOnce();
    append.resolve(true);
    cacheDispose.resolve();
    await expect(finalization).resolves.toMatchObject({ requestId: 'active_finalization' });
    await expect(disposal).resolves.toBeUndefined();
  });

  it('owns an admitted exchange when finalization starts after disposal', async () => {
    const append = deferred<boolean>();
    const { service, store } = harness({
      append: vi.fn(() => append.promise),
    });
    const exchange = begin(service, 'late_finalization');
    exchange.setDecision({
      decision: 'direct_miss',
      appState: { mode: 'disabled', fallbackReasons: ['app_state_mode_disabled'] },
    });
    exchange.setResponse(204, []);

    const disposal = service.dispose();
    await new Promise<void>(resolve => setImmediate(resolve));

    expect(store.append).toHaveBeenCalledOnce();
    const lateFinalization = exchange.finalize({ kind: 'response', status: 204, responseBytes: 0 });
    append.resolve(true);
    await expect(disposal).resolves.toBeUndefined();
    await expect(lateFinalization).resolves.toMatchObject({
      requestId: 'late_finalization',
      status: 499,
      promotion: { state: 'blocked', reason: 'request_cancelled' },
    });
    expect(store.append).toHaveBeenCalledOnce();
  });

  it('rejects private acceptance for an exact available failure before lease acquisition', async () => {
    const available = {
      side: 'response' as const,
      state: 'available' as const,
      observedSize: 2,
      retainedSize: 2,
      sha256: 'a'.repeat(64),
    };
    const { promotionAcceptor, cache } = harness({
      snapshot: vi.fn(() => ({
        projectId: 'project_1',
        trafficId: 'traffic_failure',
        generation: 'generation_failure',
        detail: { promotion: { state: 'blocked', reason: 'request_failed' } },
        captured: {
          request: { query: { ok: true, entries: [] } },
          response: { contentEncoding: { ok: true }, body: available, identity: 'failure_identity' },
        },
      }) as never),
    });

    await expect(promotionAcceptor.accept('project_1', 'traffic_failure', {
      generation: 'generation_failure',
      responseIdentity: 'failure_identity',
    })).rejects.toMatchObject({ code: 'TRAFFIC_PROMOTION_BLOCKED' });
    expect(cache.acquire).not.toHaveBeenCalled();
  });

  it('finishes an accepted promotion when clear evicts its live Traffic row', async () => {
    const publicationStarted = deferred();
    const finishPublication = deferred();
    const leaseReleased = deferred();
    let cleared = false;
    const snapshot = {
      projectId: 'project_1',
      trafficId: 'traffic_accepted',
      generation: 'generation_accepted',
      detail: { promotion: { state: 'eligible' } },
      captured: {
        capturedAt: '2026-09-02T00:00:00.000Z',
        request: {
          origin: 'http://api.example.test', method: 'GET', path: '/',
          query: { ok: true, entries: [] },
        },
        response: {
          identity: 'response_accepted', status: 200, headers: [],
          contentEncoding: { ok: true },
          body: {
            side: 'response', state: 'available', observedSize: 1, retainedSize: 1,
            sha256: 'a'.repeat(64),
          },
        },
      },
    };
    const release = vi.fn(async () => { leaseReleased.resolve(); });
    const instance = harness({
      snapshot: vi.fn(() => cleared ? undefined : snapshot) as never,
      storeClear: async () => { cleared = true; },
      cacheClear: () => leaseReleased.promise,
      cacheAcquire: vi.fn(async () => ({
        projectId: 'project_1', sha256: 'a'.repeat(64), byteCount: 1,
        openStream: vi.fn(), release,
      })) as never,
      attachPromotion: vi.fn(() => false),
    });
    const result = {
      endpointId: 'ep_1', endpointCreated: true,
      variantId: 'var_1', variantCreated: true,
      endpointModeChanged: false, bindingChanged: false,
    };
    instance.installPromoter(createTrafficPromoter({
      repository: {
        async lookupTrafficPromotionReceipt() { return { state: 'none' } as const; },
        async promoteTraffic() {
          publicationStarted.resolve();
          await finishPublication.promise;
          return { result, async complete() {} };
        },
      },
      promotionAcceptor: instance.promotionAcceptor,
      publicationFailpoints: { async before() {} },
    }));
    const promotion = instance.service.promoter.promote('project_1', 'traffic_accepted', {
      expectedTrafficGeneration: 'generation_accepted',
      expectedResponseIdentity: 'response_accepted',
      endpoint: { action: 'create' },
      state: { action: 'unbound' },
    });
    await publicationStarted.promise;

    const clearing = instance.service.clear('project_1');
    finishPublication.resolve();

    await expect(promotion).resolves.toEqual(result);
    await expect(clearing).resolves.toBeUndefined();
    expect(instance.store.attachPromotion).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    await instance.service.dispose();
  });
});
