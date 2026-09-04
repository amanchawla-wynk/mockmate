import { describe, expect, it } from 'vitest';

import type { BodyAsset, EndpointDetail } from '../domain/model';
import type { TrafficAcceptedSnapshot, TrafficPromotionInput } from '../domain/traffic';
import { projectRecord, settingsRecord, stateRecord } from '../test-support/project-builder';
import {
  applyTrafficPromotion,
  createTrafficPromoter,
  lookupTrafficPromotionReceipt,
  promotionResponseIdentity,
  trafficPromotionReceiptKey,
} from './traffic-promotion';
import type { ValidatedProjectSnapshot } from './snapshot';

const command: TrafficPromotionInput = {
  expectedTrafficGeneration: 'tg_1',
  expectedResponseIdentity: 'resp_1',
  endpoint: { action: 'reuse', endpointId: 'ep_1', expectedRevision: 4 },
  state: { action: 'bind', stateId: 'state_1', expectedRevision: 8 },
};

const endpoint = {
  schemaVersion: 4,
  id: 'ep_1',
  projectId: 'prj_1',
  name: 'Endpoint',
  baseUrl: 'https://api.example.test',
  matcher: { method: 'GET', path: '/items' },
  mode: 'mock',
  defaultVariantId: 'var_1',
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
      endpointModeChanged: true,
      stateTarget: 'bound',
      stateId: 'state_1',
      bindingChanged: true,
    }],
    revision: 0,
  }],
  revision: 5,
} satisfies EndpointDetail;

describe('Traffic promotion receipts', () => {
  it('builds receipt identity without expected revisions', () => {
    expect(trafficPromotionReceiptKey('trf_1', command)).toEqual({
      trafficId: 'trf_1',
      trafficGeneration: 'tg_1',
      responseIdentity: 'resp_1',
      endpointTarget: { action: 'reuse', endpointId: 'ep_1' },
      stateTarget: { action: 'bind', stateId: 'state_1' },
    });
    expect(trafficPromotionReceiptKey('trf_1', {
      ...command,
      endpoint: { ...command.endpoint, expectedRevision: 99 },
      state: { ...command.state, expectedRevision: 100 },
    })).toEqual(trafficPromotionReceiptKey('trf_1', command));
  });

  it('returns immutable exact results and conflicts for a reused Traffic ID', () => {
    expect(lookupTrafficPromotionReceipt([endpoint], 'trf_1', command)).toEqual({
      state: 'exact',
      result: {
        endpointId: 'ep_1',
        endpointCreated: false,
        variantId: 'var_1',
        variantCreated: true,
        endpointModeChanged: true,
        stateId: 'state_1',
        bindingChanged: true,
      },
    });
    expect(lookupTrafficPromotionReceipt([endpoint], 'trf_1', {
      ...command,
      expectedResponseIdentity: 'different',
    })).toEqual({ state: 'conflict' });
    expect(lookupTrafficPromotionReceipt([endpoint], 'trf_missing', command))
      .toEqual({ state: 'none' });
  });

  it('creates a canonical mock Endpoint and persists exact response behavior', () => {
    const body: BodyAsset = {
      schemaVersion: 4,
      id: 'a'.repeat(64),
      mediaType: 'application/json',
      size: 7,
      encoding: 'gzip',
      createdAt: '2026-09-02T00:00:00.000Z',
    };
    const headers: Array<[string, string]> = [
      ['Content-Type', 'application/json'],
      ['Set-Cookie', 'a=1'],
      ['Set-Cookie', 'b=2'],
      ['Content-Length', '7'],
      ['Content-Encoding', 'gzip'],
      ['Connection', 'close'],
      ['X-Request-Id', 'req_1'],
    ];
    const accepted: TrafficAcceptedSnapshot = {
      projectId: 'prj_1',
      trafficId: 'trf_create',
      generation: 'tg_create',
      capturedAt: '2026-09-02T00:00:00.000Z',
      acceptedAt: '2026-09-02T00:00:01.000Z',
      request: {
        origin: 'https://api.example.test',
        method: 'POST',
        path: '/items',
        query: [{ name: 'tag', value: 'one' }, { name: 'tag', value: 'two' }],
      },
      response: {
        identity: promotionResponseIdentity(201, headers, body),
        status: 201,
        headers,
        contentEncoding: { ok: true, value: 'gzip' },
        body: {
          state: 'available',
          observedSize: 7,
          retainedSize: 7,
          sha256: body.id,
          mediaType: body.mediaType,
          contentEncoding: body.encoding,
        },
      },
    };
    const current: ValidatedProjectSnapshot = {
      project: projectRecord(),
      settings: settingsRecord(),
      endpoints: new Map(),
      states: new Map(),
      bodyAssets: new Map(),
      generationId: 'gen_current',
    };
    const input: TrafficPromotionInput = {
      expectedTrafficGeneration: accepted.generation,
      expectedResponseIdentity: accepted.response.identity,
      endpoint: { action: 'create' },
      state: { action: 'unbound' },
    };

    const publication = applyTrafficPromotion({
      current,
      accepted,
      input,
      body,
      endpointId: 'ep_created',
      variantId: 'var_created',
    });

    expect(publication.result).toEqual({
      endpointId: 'ep_created',
      endpointCreated: true,
      variantId: 'var_created',
      variantCreated: true,
      endpointModeChanged: false,
      bindingChanged: false,
    });
    expect(publication.candidate.endpoints.get('ep_created')).toMatchObject({
      mode: 'mock',
      defaultVariantId: 'var_created',
      matcher: {
        method: 'POST',
        path: '/items',
        query: { tag: [{ operator: 'equals', value: 'one' }, { operator: 'equals', value: 'two' }] },
      },
      variants: [{
        id: 'var_created',
        status: 201,
        responseHeaders: {
          'content-type': 'application/json',
          'set-cookie': ['a=1', 'b=2'],
        },
        bodyAssetId: body.id,
        trafficProvenance: [expect.objectContaining({
          trafficId: accepted.trafficId,
          endpointTarget: 'create',
          variantId: 'var_created',
        })],
      }],
    });
  });

  it('reuses the first equal Variant, changes passthrough mode, and binds an explicit State', () => {
    const body: BodyAsset = {
      schemaVersion: 4,
      id: 'b'.repeat(64),
      mediaType: 'text/plain',
      size: 4,
      createdAt: '2026-09-02T00:00:00.000Z',
    };
    const headers: Array<[string, string]> = [['Content-Type', 'text/plain']];
    const accepted: TrafficAcceptedSnapshot = {
      projectId: 'prj_1', trafficId: 'trf_reuse', generation: 'tg_reuse',
      capturedAt: '2026-09-02T00:00:00.000Z', acceptedAt: '2026-09-02T00:00:01.000Z',
      request: { origin: 'https://api.example.test', method: 'GET', path: '/profile', query: [] },
      response: {
        identity: promotionResponseIdentity(200, headers, body),
        status: 200,
        headers,
        contentEncoding: { ok: true },
        body: {
          state: 'available', observedSize: 4, retainedSize: 4,
          sha256: body.id, mediaType: body.mediaType,
        },
      },
    };
    const equalVariant = (id: string) => ({
      id,
      endpointId: 'ep_1',
      name: id,
      status: 200,
      responseHeaders: { 'content-type': 'text/plain' },
      bodyAssetId: body.id,
      revision: 0,
    });
    const current: ValidatedProjectSnapshot = {
      project: projectRecord({ appStateMode: 'disabled' }),
      settings: settingsRecord(),
      endpoints: new Map([['ep_1', {
        ...endpoint,
        matcher: { method: 'GET', path: '/profile' },
        mode: 'passthrough',
        variants: [equalVariant('var_first'), equalVariant('var_second')],
        defaultVariantId: 'var_second',
        revision: 5,
      }]]),
      states: new Map([['state_other', stateRecord({
        id: 'state_other', bindings: {}, revision: 3,
      })]]),
      bodyAssets: new Map([[body.id, body]]),
      generationId: 'gen_current',
    };
    const input: TrafficPromotionInput = {
      expectedTrafficGeneration: accepted.generation,
      expectedResponseIdentity: accepted.response.identity,
      endpoint: { action: 'reuse', endpointId: 'ep_1', expectedRevision: 5 },
      state: { action: 'bind', stateId: 'state_other', expectedRevision: 3 },
    };

    const publication = applyTrafficPromotion({ current, accepted, input, body });

    expect(publication.result).toMatchObject({
      endpointId: 'ep_1', endpointCreated: false,
      variantId: 'var_first', variantCreated: false,
      endpointModeChanged: true, stateId: 'state_other', bindingChanged: true,
    });
    expect(publication.candidate.endpoints.get('ep_1')).toMatchObject({
      mode: 'mock',
      defaultVariantId: 'var_second',
      variants: [expect.objectContaining({
        id: 'var_first',
        trafficProvenance: [expect.objectContaining({ trafficId: 'trf_reuse' })],
      }), expect.objectContaining({ id: 'var_second' })],
    });
    expect(publication.candidate.endpoints.get('ep_1')?.variants[1])
      .not.toHaveProperty('trafficProvenance');
    expect(publication.candidate.states.get('state_other')?.bindings)
      .toEqual({ ep_1: 'var_first' });
  });

  it('preflights receipts and settles publication and accepted ownership in order', async () => {
    const events: string[] = [];
    const result = {
      endpointId: 'ep_1', endpointCreated: false,
      variantId: 'var_1', variantCreated: false,
      endpointModeChanged: false, bindingChanged: false,
    };
    const promoter = createTrafficPromoter({
      repository: {
        async lookupTrafficPromotionReceipt() {
          events.push('receipt');
          return { state: 'none' } as const;
        },
        async promoteTraffic() {
          events.push('publish');
          return {
            result,
            async complete() { events.push('publication.complete'); },
          };
        },
      },
      promotionAcceptor: {
        async accept() {
          events.push('accept');
          return {
            snapshot: {} as never,
            lease: {} as never,
            async attachResult() { events.push('attach'); return true; },
            async settle() { events.push('accepted.settle'); },
          };
        },
      },
      publicationFailpoints: {
        async before(operation) { events.push(operation); },
      },
    });

    await expect(promoter.promote('prj_1', 'trf_1', command)).resolves.toEqual(result);
    expect(events).toEqual([
      'receipt', 'accept', 'publish', 'resultAttach', 'attach',
      'cleanup', 'publication.complete', 'accepted.settle',
    ]);
  });

  it('returns exact receipts before acceptance and rejects conflicts', async () => {
    const accept = async () => { throw new Error('must not accept'); };
    const exact = createTrafficPromoter({
      repository: {
        async lookupTrafficPromotionReceipt() {
          return { state: 'exact', result: {
            endpointId: 'ep_1', endpointCreated: false,
            variantId: 'var_1', variantCreated: false,
            endpointModeChanged: false, bindingChanged: false,
          } } as const;
        },
        async promoteTraffic() { throw new Error('must not publish'); },
      },
      promotionAcceptor: { accept },
      publicationFailpoints: { async before() {} },
    });
    await expect(exact.promote('prj_1', 'trf_1', command)).resolves.toMatchObject({
      endpointId: 'ep_1', variantId: 'var_1',
    });

    const conflict = createTrafficPromoter({
      repository: {
        async lookupTrafficPromotionReceipt() { return { state: 'conflict' } as const; },
        async promoteTraffic() { throw new Error('must not publish'); },
      },
      promotionAcceptor: { accept },
      publicationFailpoints: { async before() {} },
    });
    await expect(conflict.promote('prj_1', 'trf_1', command))
      .rejects.toMatchObject({ status: 409, code: 'TRAFFIC_PROMOTION_CONFLICT' });
  });

  it('cannot let cleanup failure skip either owner settlement', async () => {
    const events: string[] = [];
    const promoter = createTrafficPromoter({
      repository: {
        async lookupTrafficPromotionReceipt() { return { state: 'none' } as const; },
        async promoteTraffic() {
          return {
            result: {
              endpointId: 'ep_1', endpointCreated: false,
              variantId: 'var_1', variantCreated: false,
              endpointModeChanged: false, bindingChanged: false,
            },
            async complete() {
              events.push('complete');
              throw new Error('publication cleanup failed');
            },
          };
        },
      },
      promotionAcceptor: {
        async accept() {
          return {
            snapshot: {} as never,
            lease: {} as never,
            async attachResult() { return true; },
            async settle() {
              events.push('settle');
              throw new Error('accepted cleanup failed');
            },
          };
        },
      },
      publicationFailpoints: {
        async before(operation) {
          if (operation === 'cleanup') throw new Error('cleanup failpoint');
        },
      },
    });

    await expect(promoter.promote('prj_1', 'trf_1', command))
      .rejects.toThrow('cleanup failpoint');
    expect(events).toEqual(['complete', 'settle']);
  });

  it('keeps result-attachment failure primary while settling both owners', async () => {
    const events: string[] = [];
    const promoter = createTrafficPromoter({
      repository: {
        async lookupTrafficPromotionReceipt() { return { state: 'none' } as const; },
        async promoteTraffic() {
          return {
            result: {
              endpointId: 'ep_1', endpointCreated: false,
              variantId: 'var_1', variantCreated: false,
              endpointModeChanged: false, bindingChanged: false,
            },
            async complete() { events.push('complete'); },
          };
        },
      },
      promotionAcceptor: {
        async accept() {
          return {
            snapshot: {} as never,
            lease: {} as never,
            async attachResult() { events.push('attach'); return true; },
            async settle() { events.push('settle'); },
          };
        },
      },
      publicationFailpoints: {
        async before(operation) {
          if (operation === 'resultAttach') throw new Error('result attachment failed');
          if (operation === 'cleanup') {
            events.push('cleanup');
            throw new Error('cleanup failpoint failed');
          }
        },
      },
    });

    await expect(promoter.promote('prj_1', 'trf_1', command))
      .rejects.toThrow('result attachment failed');
    expect(events).toEqual(['cleanup', 'complete', 'settle']);
  });
});
