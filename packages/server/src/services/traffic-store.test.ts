import { describe, expect, it, vi } from 'vitest';

import type {
  TrafficBodyDescriptor,
  TrafficCapturedEvidence,
  TrafficPromotionResult,
  TrafficStoredDetail,
} from '../domain/traffic';
import { createTrafficStore, type TrafficBodyReference } from './traffic-store';

function available(side: 'request' | 'response', marker: string): TrafficBodyDescriptor {
  return {
    side,
    state: 'available',
    observedSize: 2,
    retainedSize: 2,
    sha256: marker.repeat(64),
  };
}

function detail(
  projectId: string,
  trafficId: string,
  generation: string,
  path = `/${trafficId}`,
): TrafficStoredDetail {
  return {
    id: trafficId,
    generation,
    projectId,
    requestId: `request_${trafficId}`,
    startedAt: '2026-09-01T00:00:00.000Z',
    completedAt: '2026-09-01T00:00:00.001Z',
    durationMs: 1,
    transport: 'https_mitm',
    allowlistPattern: '*.example.test',
    origin: 'https://api.example.test',
    method: 'POST',
    path,
    queryNames: [{ name: 'token', occurrenceCount: 1, sensitive: true }],
    decision: 'no_match_passthrough',
    status: 200,
    responseBytes: 2,
    requestBodyState: 'available',
    responseBodyState: 'available',
    request: {
      query: [{ name: 'token', value: '[REDACTED]' }],
      headers: [['authorization', '[REDACTED]']],
      body: available('request', 'a'),
    },
    response: {
      headers: [['set-cookie', '[REDACTED]']],
      body: available('response', 'b'),
    },
    appState: {
      mode: 'enabled',
      activeStateId: 'state_active',
      baseStateId: 'state_base',
      fallbackReasons: [],
    },
    captureState: 'complete',
    promotion: { state: 'eligible' },
  };
}

function captured(
  projectId: string,
  trafficId: string,
  generation: string,
): TrafficCapturedEvidence {
  return {
    projectId,
    trafficId,
    generation,
    capturedAt: '2026-09-01T00:00:00.001Z',
    request: {
      origin: 'https://api.example.test',
      method: 'POST',
      path: `/${trafficId}`,
      query: { ok: true, entries: [{ name: 'token', value: 'exact-private-query' }] },
    },
    response: {
      identity: `identity_${trafficId}`,
      status: 200,
      headers: [['set-cookie', 'exact-private-cookie']],
      contentEncoding: { ok: true },
      body: available('response', 'b'),
    },
  };
}

async function appendRow(
  store: ReturnType<typeof createTrafficStore>,
  projectId: string,
  trafficId: string,
  generation = `generation_${trafficId}`,
): Promise<void> {
  store.registerGeneration(projectId, trafficId, generation);
  expect(await store.append(
    detail(projectId, trafficId, generation),
    captured(projectId, trafficId, generation),
  )).toBe(true);
}

describe('Traffic store', () => {
  it('counts pending generations against the same Project bound and tombstones late finalization', async () => {
    const release = vi.fn(async () => undefined);
    const store = createTrafficStore({ rowsPerProject: 2, releaseBodyReference: release });
    store.registerGeneration('project_a', 'traffic_disabled_capture', 'generation_1');
    store.registerGeneration('project_a', 'traffic_sidecar_rejected', 'generation_2');
    store.registerGeneration('project_a', 'traffic_third', 'generation_3');

    expect(await store.append(
      detail('project_a', 'traffic_disabled_capture', 'generation_1'),
      captured('project_a', 'traffic_disabled_capture', 'generation_1'),
    )).toBe(false);
    expect(store.get('project_a', 'traffic_disabled_capture')).toBeUndefined();
    expect(release).toHaveBeenCalledTimes(2);
    expect(release.mock.calls.map(([reference]) => reference.side)).toEqual(['request', 'response']);
  });

  it('evicts only the oldest Project-local generation and keeps bounded cursor semantics', async () => {
    const released: TrafficBodyReference[] = [];
    const store = createTrafficStore({
      rowsPerProject: 2,
      releaseBodyReference: async reference => { released.push(reference); },
    });
    await appendRow(store, 'project_a', 'traffic_1');
    await appendRow(store, 'project_b', 'traffic_foreign');
    await appendRow(store, 'project_a', 'traffic_2');
    await appendRow(store, 'project_a', 'traffic_3');

    expect(store.list('project_a').entries.map(entry => entry.id)).toEqual(['traffic_2', 'traffic_3']);
    expect(store.list('project_b').entries.map(entry => entry.id)).toEqual(['traffic_foreign']);
    expect(store.list('project_a', { afterId: 'traffic_1', limit: 1 })).toMatchObject({
      reset: true,
      entries: [{ id: 'traffic_3' }],
      latestId: 'traffic_3',
      hasMore: true,
    });
    expect(store.list('project_a', { afterId: 'traffic_2' }).entries.map(entry => entry.id))
      .toEqual(['traffic_3']);
    expect(store.list('project_a', { beforeId: 'traffic_3' }).entries.map(entry => entry.id))
      .toEqual(['traffic_2']);
    expect(released.map(reference => reference.trafficId)).toEqual(['traffic_1', 'traffic_1']);
  });

  it('makes cross-Project reads indistinguishable from missing and never exposes captured evidence', async () => {
    const store = createTrafficStore();
    await appendRow(store, 'project_a', 'traffic_1');

    expect(store.get('project_b', 'traffic_1')).toBeUndefined();
    expect(store.snapshotForAcceptance('project_b', 'traffic_1', 'generation_traffic_1'))
      .toBeUndefined();
    const publicDetail = store.get('project_a', 'traffic_1');
    expect(publicDetail).toBeDefined();
    expect(publicDetail).not.toHaveProperty('captured');
    expect(publicDetail).not.toHaveProperty('accepted');
    expect(JSON.stringify(publicDetail)).not.toContain('exact-private');
    expect(JSON.stringify(store.list('project_a'))).not.toContain('exact-private');
  });

  it('tombstones finalized and pending generations before awaiting clear releases', async () => {
    const observedAfterTransition: Array<TrafficStoredDetail | undefined> = [];
    const release = vi.fn(async (reference: TrafficBodyReference) => {
      observedAfterTransition.push(store.get(reference.projectId, reference.trafficId));
    });
    const store = createTrafficStore({ releaseBodyReference: release });
    await appendRow(store, 'project_a', 'traffic_finalized');
    store.registerGeneration('project_a', 'traffic_pending', 'generation_pending');

    await store.clear('project_a');

    expect(observedAfterTransition).toEqual([undefined, undefined]);
    expect(store.list('project_a').entries).toEqual([]);
    expect(await store.append(
      detail('project_a', 'traffic_pending', 'generation_pending'),
      captured('project_a', 'traffic_pending', 'generation_pending'),
    )).toBe(false);
    expect(release).toHaveBeenCalledTimes(4);
  });

  it.each(['request', 'response'] as const)(
    'prevents publication when clear wins before %s completion',
    async side => {
      const store = createTrafficStore();
      const trafficId = `traffic_${side}`;
      const generation = `generation_${side}`;
      store.registerGeneration('project_a', trafficId, generation);

      await store.clear('project_a');

      expect(await store.append(
        detail('project_a', trafficId, generation),
        captured('project_a', trafficId, generation),
      )).toBe(false);
      expect(store.get('project_a', trafficId)).toBeUndefined();
    },
  );

  it('checks generation on every update and never resurrects tombstoned work', async () => {
    const store = createTrafficStore({ rowsPerProject: 1 });
    await appendRow(store, 'project_a', 'traffic_old', 'generation_old');
    store.registerGeneration('project_a', 'traffic_new', 'generation_new');

    expect(store.updateBody(
      'project_a',
      'traffic_old',
      'generation_old',
      'response',
      available('response', 'c'),
    )).toBe(false);
    expect(store.attachPromotion(
      'project_a',
      'traffic_old',
      'generation_old',
      {
        endpointId: 'endpoint_1',
        endpointCreated: true,
        variantId: 'variant_1',
        variantCreated: true,
        endpointModeChanged: false,
        bindingChanged: false,
      },
    )).toBe(false);
    expect(store.snapshotForAcceptance('project_a', 'traffic_old', 'generation_old'))
      .toBeUndefined();
    expect(store.get('project_a', 'traffic_old')).toBeUndefined();
  });

  it('returns separately immutable public and captured snapshots across later updates', async () => {
    const store = createTrafficStore();
    await appendRow(store, 'project_a', 'traffic_1');
    const before = store.snapshotForAcceptance(
      'project_a',
      'traffic_1',
      'generation_traffic_1',
    );
    if (before === undefined) throw new Error('Expected acceptance snapshot');

    expect(store.updateBody(
      'project_a',
      'traffic_1',
      'generation_traffic_1',
      'response',
      available('response', 'c'),
    )).toBe(true);
    const after = store.snapshotForAcceptance(
      'project_a',
      'traffic_1',
      'generation_traffic_1',
    );
    if (after === undefined) throw new Error('Expected updated acceptance snapshot');

    expect(Object.isFrozen(before)).toBe(true);
    expect(Object.isFrozen(before.detail.response.body)).toBe(true);
    expect(Object.isFrozen(before.captured.response.headers)).toBe(true);
    expect(before.detail.response.body).toMatchObject({ sha256: 'b'.repeat(64) });
    expect(before.captured.response.body).toMatchObject({ sha256: 'b'.repeat(64) });
    expect(after.detail.response.body).toMatchObject({ sha256: 'c'.repeat(64) });
    expect(after.captured.response.body).toMatchObject({ sha256: 'c'.repeat(64) });

    const publicRead = store.get('project_a', 'traffic_1');
    expect(Object.isFrozen(publicRead)).toBe(true);
    expect(publicRead).not.toBe(before.detail);
  });

  it('never resurrects failure promotion when exact response evidence is published or replaced', async () => {
    const store = createTrafficStore();
    const failed = detail('project_a', 'traffic_failure', 'generation_failure');
    failed.decision = 'failure';
    failed.promotion = { state: 'blocked', reason: 'request_failed' };
    failed.upstream = { failure: { code: 'UPSTREAM_FAILURE', message: 'Upstream request failed' } };
    const exact = captured('project_a', 'traffic_failure', 'generation_failure');
    store.registerGeneration('project_a', failed.id, failed.generation);

    expect(await store.append(failed, exact)).toBe(true);
    expect(store.get('project_a', failed.id)?.promotion)
      .toEqual({ state: 'blocked', reason: 'request_failed' });
    const privateSnapshot = store.snapshotForAcceptance('project_a', failed.id, failed.generation);
    expect(privateSnapshot?.captured.response.headers)
      .toContainEqual(['set-cookie', 'exact-private-cookie']);
    expect(JSON.stringify(store.get('project_a', failed.id))).not.toContain('exact-private-cookie');

    expect(store.updateBody(
      'project_a', failed.id, failed.generation, 'response', available('response', 'c'),
    )).toBe(true);
    expect(store.get('project_a', failed.id)?.promotion)
      .toEqual({ state: 'blocked', reason: 'request_failed' });
  });

  it('attaches a cloned promotion result only to the matching live generation', async () => {
    const store = createTrafficStore();
    await appendRow(store, 'project_a', 'traffic_1');
    const result: TrafficPromotionResult = {
      endpointId: 'endpoint_1',
      endpointCreated: true,
      variantId: 'variant_1',
      variantCreated: true,
      endpointModeChanged: false,
      stateId: 'state_1',
      bindingChanged: true,
    };

    expect(store.attachPromotion(
      'project_a',
      'traffic_1',
      'wrong_generation',
      result,
    )).toBe(false);
    expect(store.attachPromotion(
      'project_a',
      'traffic_1',
      'generation_traffic_1',
      result,
    )).toBe(true);
    result.endpointId = 'mutated';

    expect(store.get('project_a', 'traffic_1')?.promotion).toEqual({
      state: 'promoted',
      result: { ...result, endpointId: 'endpoint_1' },
    });
  });
});
