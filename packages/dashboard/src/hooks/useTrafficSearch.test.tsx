import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { trafficApi, ApiClientError } from '../api/client';
import type { TrafficJsonSearchPage, TrafficJsonSearchResult } from '../api/types';
import { useTrafficSearch } from './useTrafficSearch';

function result(id: string): TrafficJsonSearchResult {
  return {
    traffic: {
      id, generation: 'g1', projectId: 'prj_1', requestId: `req_${id}`,
      startedAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T00:00:00.000Z',
      durationMs: 1, transport: 'https_mitm', allowlistPattern: 'api.example.com',
      origin: 'https://api.example.com', method: 'POST', path: `/${id}`, queryNames: [],
      decision: 'endpoint_passthrough', status: 200, responseBytes: 2,
      requestBodyState: 'unavailable', responseBodyState: 'available',
    },
    side: 'response',
    matchCount: 1,
    matches: [{ jsonPointer: '/x', kind: 'value', occurrence: 1, snippet: 'needle' }],
  };
}

function page(results: TrafficJsonSearchResult[], nextCursor?: string): TrafficJsonSearchPage {
  return {
    searchSessionId: 'sess_1',
    query: 'needle',
    results,
    ...(nextCursor === undefined ? {} : { nextCursor }),
    skipped: {
      unavailable: 0, truncated: 0, evicted: 0, unsupportedEncoding: 0,
      invalidUtf8: 0, notJson: 1, changedDuringSearch: 0, searchBudgetExceeded: 0,
    },
  };
}

describe('useTrafficSearch', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('debounces the query, returns results, and paginates via loadMore', async () => {
    const search = vi.spyOn(trafficApi, 'search')
      .mockResolvedValueOnce(page([result('trf_1')], 'cursor_2'))
      .mockResolvedValueOnce(page([result('trf_2')]));
    const { result: hook } = renderHook(() => useTrafficSearch('prj_1', { enabled: true, debounceMs: 10 }));

    act(() => hook.current.setQuery('needle'));
    await waitFor(() => expect(hook.current.results.map(entry => entry.traffic.id)).toEqual(['trf_1']));
    expect(hook.current.hasMore).toBe(true);
    expect(hook.current.skipped.notJson).toBe(1);

    act(() => hook.current.loadMore());
    await waitFor(() => expect(hook.current.results.map(entry => entry.traffic.id)).toEqual(['trf_1', 'trf_2']));
    expect(hook.current.hasMore).toBe(false);
    expect(hook.current.skipped.notJson).toBe(2);
    expect(search).toHaveBeenCalledTimes(2);
    expect(search.mock.calls[1]![1]).toMatchObject({ cursor: 'cursor_2' });
  });

  it('surfaces a friendly message when the session expires', async () => {
    vi.spyOn(trafficApi, 'search').mockRejectedValue(
      new ApiClientError(410, 'TRAFFIC_SEARCH_EXPIRED', 'gone', 'req_1'),
    );
    const { result: hook } = renderHook(() => useTrafficSearch('prj_1', { debounceMs: 10 }));

    act(() => hook.current.setQuery('needle'));
    await waitFor(() => expect(hook.current.error).toBe('Search results expired; run the search again.'));
    expect(hook.current.results).toHaveLength(0);
  });

  it('clears results when the query becomes empty', async () => {
    vi.spyOn(trafficApi, 'search').mockResolvedValue(page([result('trf_1')]));
    const { result: hook } = renderHook(() => useTrafficSearch('prj_1', { debounceMs: 10 }));

    act(() => hook.current.setQuery('needle'));
    await waitFor(() => expect(hook.current.results).toHaveLength(1));

    act(() => hook.current.setQuery('   '));
    await waitFor(() => expect(hook.current.results).toHaveLength(0));
    expect(hook.current.activeQuery).toBe('');
  });

  it('does not search while disabled', async () => {
    const search = vi.spyOn(trafficApi, 'search').mockResolvedValue(page([]));
    const { result: hook } = renderHook(() => useTrafficSearch('prj_1', { enabled: false, debounceMs: 10 }));

    act(() => hook.current.setQuery('needle'));
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(search).not.toHaveBeenCalled();
  });
});
