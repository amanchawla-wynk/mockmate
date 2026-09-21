import { gzipSync } from 'node:zlib';
import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { HttpError } from './api-errors';
import type { TrafficBodyDescriptor, TrafficDetail, TrafficSummary } from '../domain/traffic';
import { createTrafficSearchService, type TrafficSearchOptions } from './traffic-search';
import type { TrafficService } from './traffic-service';

const digest = 'a'.repeat(64);
type SideState = TrafficBodyDescriptor['state'];

interface FakeSide {
  state: SideState;
  bytes?: Uint8Array;
  contentEncoding?: string;
}

interface FakeRow {
  id: string;
  generation: string;
  completedAt: string;
  request: FakeSide;
  response: FakeSide;
  /** When set, `get` reports this generation, simulating a post-snapshot change. */
  detailGeneration?: string;
}

function cursorFor(sessionId: string, index: number): string {
  return Buffer.from(`${sessionId}\u0000${index}`, 'utf8').toString('base64url');
}

function descriptor(side: 'request' | 'response', input: FakeSide): TrafficBodyDescriptor {
  if (input.state === 'available') {
    return {
      side,
      state: 'available',
      observedSize: input.bytes?.byteLength ?? 0,
      retainedSize: input.bytes?.byteLength ?? 0,
      sha256: digest,
      mediaType: 'application/json',
      ...(input.contentEncoding === undefined ? {} : { contentEncoding: input.contentEncoding }),
    };
  }
  if (input.state === 'truncated') {
    return { side, state: 'truncated', observedSize: 1, reason: 'body_limit_exceeded' };
  }
  if (input.state === 'evicted') {
    return { side, state: 'evicted', observedSize: 1, retainedSize: 1, sha256: digest, reason: 'retention_evicted' };
  }
  return { side, state: 'unavailable', observedSize: 0, reason: 'body_unobservable' };
}

function summary(row: FakeRow): TrafficSummary {
  return {
    id: row.id,
    generation: row.generation,
    projectId: 'prj_1',
    requestId: `req_${row.id}`,
    startedAt: row.completedAt,
    completedAt: row.completedAt,
    durationMs: 1,
    transport: 'https_mitm',
    allowlistPattern: 'api.example.com',
    origin: 'https://api.example.com',
    method: 'POST',
    path: `/${row.id}`,
    queryNames: [],
    decision: 'endpoint_passthrough',
    status: 200,
    responseBytes: row.response.bytes?.byteLength ?? 0,
    requestBodyState: row.request.state,
    responseBodyState: row.response.state,
  };
}

function detail(row: FakeRow): TrafficDetail {
  return {
    ...summary(row),
    generation: row.detailGeneration ?? row.generation,
    request: { query: [], headers: [], body: descriptor('request', row.request) },
    response: { headers: [], body: descriptor('response', row.response) },
    appState: { mode: 'disabled', fallbackReasons: [] },
    captureState: 'complete',
    promotion: { state: 'blocked', reason: 'body_unavailable' },
  };
}

function json(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function createFakeTraffic(rows: FakeRow[]) {
  const leases = { acquired: 0, released: 0 };
  const service = {
    list: () => ({
      entries: rows.map(summary),
      hasMore: false,
    }),
    get: (_projectId: string, trafficId: string) => {
      const row = rows.find(candidate => candidate.id === trafficId);
      return row === undefined ? undefined : detail(row);
    },
    async openBody(_projectId: string, trafficId: string, side: 'request' | 'response') {
      const row = rows.find(candidate => candidate.id === trafficId);
      const target = row?.[side];
      if (row === undefined || target === undefined || target.state !== 'available') {
        throw new HttpError(410, 'TRAFFIC_BODY_EVICTED', 'Traffic body was evicted');
      }
      leases.acquired += 1;
      const bytes = target.bytes ?? new Uint8Array();
      let released = false;
      return {
        descriptor: descriptor(side, target) as Extract<TrafficBodyDescriptor, { state: 'available' }>,
        lease: {
          projectId: 'prj_1',
          sha256: digest,
          byteCount: bytes.byteLength,
          openStream: () => Readable.from([Buffer.from(bytes)]),
          async release() {
            if (released) return;
            released = true;
            leases.released += 1;
          },
        },
      };
    },
  };
  return { service: service as unknown as TrafficService, leases, rows };
}

function makeService(rows: FakeRow[], options?: TrafficSearchOptions) {
  const fake = createFakeTraffic(rows);
  const search = createTrafficSearchService({ traffic: fake.service, options });
  return { search, ...fake };
}

const bodyless: FakeSide = { state: 'unavailable' };

function twoMatchingRows(): FakeRow[] {
  return [1, 2].map(index => ({
    id: `trf_${index}`,
    generation: 'g1',
    completedAt: `2026-01-0${index}T00:00:00.000Z`,
    request: bodyless,
    response: { state: 'available', bytes: json({ v: 'needle' }) },
  }));
}

describe('createTrafficSearchService', () => {
  it('returns one newest-first result per matching JSON body and releases leases', async () => {
    const { search, leases } = makeService([
      {
        id: 'trf_old', generation: 'g1', completedAt: '2026-01-01T00:00:00.000Z',
        request: bodyless,
        response: { state: 'available', bytes: json({ user: 'needle' }) },
      },
      {
        id: 'trf_new', generation: 'g1', completedAt: '2026-01-02T00:00:00.000Z',
        request: { state: 'available', bytes: json({ q: 'needle in request' }) },
        response: { state: 'available', bytes: json({ ok: true }) },
      },
    ]);

    const page = await search.search('prj_1', { query: 'needle', limit: 100 });

    expect(page.results.map(result => [result.traffic.id, result.side])).toEqual([
      ['trf_new', 'request'],
      ['trf_old', 'response'],
    ]);
    expect(page.results[0]!.matchCount).toBe(1);
    expect(page.nextCursor).toBeUndefined();
    expect(leases.acquired).toBe(leases.released);
    expect(leases.acquired).toBeGreaterThan(0);
  });

  it('classifies skipped bodies without failing the search', async () => {
    const { search } = makeService([
      {
        id: 'trf_1', generation: 'g1', completedAt: '2026-01-05T00:00:00.000Z',
        request: { state: 'truncated' },
        response: { state: 'evicted' },
      },
      {
        id: 'trf_2', generation: 'g1', completedAt: '2026-01-04T00:00:00.000Z',
        request: { state: 'available', bytes: new TextEncoder().encode('{not json') },
        response: { state: 'available', bytes: new Uint8Array([0xff, 0xfe]) },
      },
    ]);

    const page = await search.search('prj_1', { query: 'needle', limit: 100 });

    expect(page.results).toHaveLength(0);
    expect(page.skipped).toMatchObject({
      truncated: 1,
      evicted: 1,
      notJson: 1,
      invalidUtf8: 1,
    });
  });

  it('searches gzip-encoded JSON bodies through the decoded view', async () => {
    const { search } = makeService([
      {
        id: 'trf_gz', generation: 'g1', completedAt: '2026-01-06T00:00:00.000Z',
        request: bodyless,
        response: { state: 'available', bytes: gzipSync(Buffer.from(JSON.stringify({ token: 'needle' }))), contentEncoding: 'gzip' },
      },
    ]);

    const page = await search.search('prj_1', { query: 'needle', limit: 100 });
    expect(page.results.map(result => result.traffic.id)).toEqual(['trf_gz']);
  });

  it('counts oversized decoded bodies as a search-budget skip', async () => {
    const { search } = makeService([
      {
        id: 'trf_big', generation: 'g1', completedAt: '2026-01-07T00:00:00.000Z',
        request: bodyless,
        response: { state: 'available', bytes: json({ value: 'needle'.repeat(20) }) },
      },
    ], { maxDecodedBytes: 8 });

    const page = await search.search('prj_1', { query: 'needle', limit: 100 });
    expect(page.results).toHaveLength(0);
    expect(page.skipped.searchBudgetExceeded).toBe(1);
  });

  it('paginates newest-first without duplicates and rejects mismatched cursors', async () => {
    const rows: FakeRow[] = [1, 2, 3].map(index => ({
      id: `trf_${index}`,
      generation: 'g1',
      completedAt: `2026-01-0${index}T00:00:00.000Z`,
      request: bodyless,
      response: { state: 'available', bytes: json({ v: 'needle' }) },
    }));
    const { search } = makeService(rows);

    const first = await search.search('prj_1', { query: 'needle', limit: 2 });
    expect(first.results.map(result => result.traffic.id)).toEqual(['trf_3', 'trf_2']);
    expect(first.nextCursor).toBeDefined();

    const second = await search.search('prj_1', { query: 'needle', limit: 2, cursor: first.nextCursor });
    expect(second.results.map(result => result.traffic.id)).toEqual(['trf_1']);
    expect(second.nextCursor).toBeUndefined();
    expect(second.searchSessionId).toBe(first.searchSessionId);

    await expect(search.search('prj_1', { query: 'other', limit: 2, cursor: first.nextCursor }))
      .rejects.toMatchObject({ status: 400, code: 'TRAFFIC_SEARCH_CURSOR_INVALID' });
  });

  it('rejects empty queries, expired cursors, and cross-project cursors', async () => {
    const { search } = makeService([
      {
        id: 'trf_1', generation: 'g1', completedAt: '2026-01-01T00:00:00.000Z',
        request: bodyless,
        response: { state: 'available', bytes: json({ v: 'needle' }) },
      },
    ]);

    await expect(search.search('prj_1', { query: '   ', limit: 100 }))
      .rejects.toMatchObject({ status: 400, code: 'TRAFFIC_SEARCH_QUERY_REQUIRED' });
    await expect(search.search('prj_1', { query: 'needle', limit: 100, cursor: cursorFor('missing', 0) }))
      .rejects.toMatchObject({ status: 410, code: 'TRAFFIC_SEARCH_EXPIRED' });

    const paged = makeService(twoMatchingRows());
    const first = await paged.search.search('prj_1', { query: 'needle', limit: 1 });
    expect(first.nextCursor).toBeDefined();
    await expect(paged.search.search('prj_2', { query: 'needle', limit: 1, cursor: first.nextCursor! }))
      .rejects.toMatchObject({ status: 410 });
  });

  it('detects rows whose generation changed after the snapshot', async () => {
    const { search } = makeService([{
      id: 'trf_1', generation: 'g1', detailGeneration: 'g2',
      completedAt: '2026-01-01T00:00:00.000Z',
      request: bodyless,
      response: { state: 'available', bytes: json({ v: 'needle' }) },
    }]);

    const page = await search.search('prj_1', { query: 'needle', limit: 100 });
    expect(page.results).toHaveLength(0);
    expect(page.skipped.changedDuringSearch).toBe(1);
  });

  it('drops sessions on clearProject so their cursors expire', async () => {
    const { search } = makeService(twoMatchingRows());

    const first = await search.search('prj_1', { query: 'needle', limit: 1 });
    expect(first.nextCursor).toBeDefined();
    search.clearProject('prj_1');
    await expect(search.search('prj_1', { query: 'needle', limit: 1, cursor: first.nextCursor! }))
      .rejects.toMatchObject({ status: 410 });
  });

  it('expires idle sessions after their TTL', async () => {
    let clock = 1_000;
    const { search } = makeService(twoMatchingRows(), { sessionTtlMs: 100, now: () => clock });

    const first = await search.search('prj_1', { query: 'needle', limit: 1 });
    expect(first.nextCursor).toBeDefined();
    clock += 1_000;
    await expect(search.search('prj_1', { query: 'needle', limit: 1, cursor: first.nextCursor! }))
      .rejects.toMatchObject({ status: 410 });
  });

  it('stops a page once its aggregate decode budget is spent', async () => {
    const rows: FakeRow[] = [1, 2, 3].map(index => ({
      id: `trf_${index}`,
      generation: 'g1',
      completedAt: `2026-01-0${index}T00:00:00.000Z`,
      request: bodyless,
      response: { state: 'available', bytes: json({ v: 'needle' }) },
    }));
    const bodyBytes = json({ v: 'needle' }).byteLength;
    // Enough budget for exactly one body, so the page stops and offers a cursor.
    const { search } = makeService(rows, { maxPageDecodedBytes: bodyBytes });

    const page = await search.search('prj_1', { query: 'needle', limit: 100 });
    expect(page.results).toHaveLength(1);
    expect(page.nextCursor).toBeDefined();
  });

  it('aborts an in-flight scan and surfaces an AbortError', async () => {
    const { search } = makeService([{
      id: 'trf_1', generation: 'g1', completedAt: '2026-01-01T00:00:00.000Z',
      request: bodyless,
      response: { state: 'available', bytes: json({ v: 'needle' }) },
    }]);
    const controller = new AbortController();
    controller.abort();

    await expect(search.search('prj_1', { query: 'needle', limit: 100 }, controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' });
  });
});
