import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { Suspense, startTransition } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useTraffic } from './useTraffic';

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

const summary = {
  id: 'traffic_1',
  projectId: 'prj_1',
  method: 'GET',
  path: '/users',
  status: 200,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function ConcurrentTrafficHarness({
  projectId,
  suspend,
  suspension,
}: {
  projectId: string;
  suspend: boolean;
  suspension: Promise<never>;
}) {
  const traffic = useTraffic(projectId, { pollIntervalMs: 60_000 });
  if (suspend) throw suspension;
  return (
    <div>
      <span>Traffic: {traffic.entries.map(entry => entry.id).join(',')}</span>
      <span>Detail: {traffic.selected?.id ?? 'none'}</span>
      <span>{traffic.loading ? 'List loading' : 'List settled'}</span>
      <button type="button" onClick={() => { void traffic.refresh(); }}>Refresh Traffic</button>
      <button type="button" onClick={() => traffic.select('traffic_1')}>Select Traffic</button>
      <button type="button" onClick={() => { void traffic.clear(); }}>Clear Traffic</button>
    </div>
  );
}

function concurrentTrafficView(
  projectId: string,
  suspend: boolean,
  suspension: Promise<never>,
) {
  return (
    <Suspense fallback={<span>Suspended Project</span>}>
      <ConcurrentTrafficHarness
        projectId={projectId}
        suspend={suspend}
        suspension={suspension}
      />
    </Suspense>
  );
}

describe('useTraffic', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('loads canonical Project-owned summaries and detail', async () => {
    const fetch = vi.fn((url: string | URL | Request) => Promise.resolve(
      String(url).endsWith('/traffic/traffic_1')
        ? response({ ...summary, request: {}, response: {} })
        : response({ entries: [summary], latestId: summary.id, hasMore: false }),
    ));
    vi.stubGlobal('fetch', fetch);

    const { result } = renderHook(() => useTraffic('prj_1', { pollIntervalMs: 60_000 }));
    await waitFor(() => expect(result.current.entries.map(entry => entry.id)).toEqual(['traffic_1']));
    expect(fetch).toHaveBeenCalledWith(
      '/api/admin/projects/prj_1/traffic?limit=100',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    act(() => result.current.select('traffic_1'));
    await waitFor(() => expect(result.current.selected?.id).toBe('traffic_1'));
    expect(fetch).toHaveBeenLastCalledWith(
      '/api/admin/projects/prj_1/traffic/traffic_1',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('advances the list cursor, deduplicates increments, and drops a selection on retention reset', async () => {
    const newer = { ...summary, id: 'traffic_2', path: '/newer' };
    const retained = { ...summary, status: 201 };
    const reset = { ...summary, id: 'traffic_3', path: '/retained' };
    let listCall = 0;
    const fetch = vi.fn((url: string | URL | Request) => {
      const value = String(url);
      if (value.endsWith('/traffic/traffic_1')) {
        return Promise.resolve(response({ ...summary, request: {}, response: {} }));
      }
      listCall += 1;
      if (listCall === 1) {
        return Promise.resolve(response({ entries: [summary], latestId: summary.id, hasMore: false }));
      }
      if (listCall === 2) {
        return Promise.resolve(response({ entries: [retained, newer], latestId: newer.id, hasMore: false }));
      }
      return Promise.resolve(response({ entries: [reset], latestId: reset.id, hasMore: false, reset: true }));
    });
    vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useTraffic('prj_1', { pollIntervalMs: 60_000 }));
    await waitFor(() => expect(result.current.entries).toHaveLength(1));
    act(() => result.current.select('traffic_1'));
    await waitFor(() => expect(result.current.selected?.id).toBe('traffic_1'));

    let refreshed: unknown;
    await act(async () => { refreshed = await result.current.refresh(); });
    expect(refreshed).toBe(true);
    expect(fetch).toHaveBeenCalledWith(
      '/api/admin/projects/prj_1/traffic?afterId=traffic_1&limit=100',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result.current.entries.map(entry => entry.id)).toEqual(['traffic_1', 'traffic_2']);
    expect(result.current.entries[0]?.status).toBe(201);

    await act(async () => { refreshed = await result.current.refresh(); });
    expect(refreshed).toBe(true);
    expect(result.current.entries.map(entry => entry.id)).toEqual(['traffic_3']);
    expect(result.current.selected).toBeNull();
  });

  it('does not overlap list requests and reports skipped ownership', async () => {
    const pending = deferred<Response>();
    const fetch = vi.fn(() => pending.promise);
    vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useTraffic('prj_1', { pollIntervalMs: 60_000 }));
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());

    await expect(result.current.refresh()).resolves.toBe(false);
    expect(fetch).toHaveBeenCalledOnce();
    await act(async () => pending.resolve(response({ entries: [summary], hasMore: false })));
    await waitFor(() => expect(result.current.loading).toBe(false));
  });

  it('pauses interval polling while preserving manual refresh', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(() => Promise.resolve(response({
      entries: [summary], latestId: summary.id, hasMore: false,
    })));
    vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useTraffic('prj_1', { pollIntervalMs: 10 }));
    await act(async () => { await Promise.resolve(); });
    act(() => result.current.setPaused(true));
    const pausedAt = fetch.mock.calls.length;

    await act(async () => vi.advanceTimersByTimeAsync(50));
    expect(fetch).toHaveBeenCalledTimes(pausedAt);
    await act(async () => { expect(await result.current.refresh()).toBe(true); });
    expect(fetch).toHaveBeenCalledTimes(pausedAt + 1);
    vi.useRealTimers();
  });

  it('refreshes only the current selected detail and returns its canonical value', async () => {
    let detailCall = 0;
    const fetch = vi.fn((url: string | URL | Request) => {
      if (String(url).endsWith('/traffic/traffic_1')) {
        detailCall += 1;
        return Promise.resolve(response({
          ...summary,
          status: detailCall === 1 ? 200 : 204,
          request: {},
          response: {},
        }));
      }
      return Promise.resolve(response({ entries: [summary], hasMore: false }));
    });
    vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useTraffic('prj_1', { pollIntervalMs: 60_000 }));
    await waitFor(() => expect(result.current.entries).toHaveLength(1));
    act(() => result.current.select('traffic_1'));
    await waitFor(() => expect(result.current.selected?.status).toBe(200));

    let refreshPromise!: ReturnType<typeof result.current.refreshSelected>;
    act(() => { refreshPromise = result.current.refreshSelected(); });
    await act(async () => { await refreshPromise; });
    expect((await refreshPromise)?.status).toBe(204);
    expect(result.current.selected?.status).toBe(204);
  });

  it('keeps a committed list owner valid through an interrupted Project render', async () => {
    const poll = deferred<Response>();
    const suspension = new Promise<never>(() => undefined);
    let projectALists = 0;
    const fetch = vi.fn((url: string | URL | Request) => {
      if (String(url).includes('/prj_2/')) {
        return Promise.resolve(response({ entries: [], hasMore: false }));
      }
      projectALists += 1;
      return projectALists === 1
        ? Promise.resolve(response({ entries: [summary], hasMore: false }))
        : poll.promise;
    });
    vi.stubGlobal('fetch', fetch);
    const { rerender } = render(concurrentTrafficView('prj_1', false, suspension));
    await screen.findByText('Traffic: traffic_1');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Traffic' }));

    act(() => {
      startTransition(() => rerender(concurrentTrafficView('prj_2', true, suspension)));
    });
    expect(screen.queryByText('Suspended Project')).not.toBeInTheDocument();
    await act(async () => poll.resolve(response({
      entries: [{ ...summary, id: 'traffic_committed_a' }],
      hasMore: false,
    })));

    expect(await screen.findByText('Traffic: traffic_1,traffic_committed_a')).toBeVisible();
    expect(fetch.mock.calls.some(([url]) => String(url).includes('/prj_2/'))).toBe(false);
  });

  it('keeps a committed detail owner valid through an interrupted Project render', async () => {
    const detail = deferred<Response>();
    const suspension = new Promise<never>(() => undefined);
    const fetch = vi.fn((url: string | URL | Request) => String(url).endsWith('/traffic/traffic_1')
      ? detail.promise
      : Promise.resolve(response({ entries: [summary], hasMore: false })));
    vi.stubGlobal('fetch', fetch);
    const { rerender } = render(concurrentTrafficView('prj_1', false, suspension));
    await screen.findByText('Traffic: traffic_1');
    fireEvent.click(screen.getByRole('button', { name: 'Select Traffic' }));

    act(() => {
      startTransition(() => rerender(concurrentTrafficView('prj_2', true, suspension)));
    });
    await act(async () => detail.resolve(response({ ...summary, request: {}, response: {} })));

    expect(await screen.findByText('Detail: traffic_1')).toBeVisible();
  });

  it('keeps a committed clear owner valid through an interrupted Project render', async () => {
    const clearing = deferred<Response>();
    const suspension = new Promise<never>(() => undefined);
    const fetch = vi.fn((_url: string | URL | Request, options?: RequestInit) => options?.method === 'DELETE'
      ? clearing.promise
      : Promise.resolve(response({ entries: [summary], hasMore: false })));
    vi.stubGlobal('fetch', fetch);
    const { rerender } = render(concurrentTrafficView('prj_1', false, suspension));
    await screen.findByText('Traffic: traffic_1');
    fireEvent.click(screen.getByRole('button', { name: 'Clear Traffic' }));

    act(() => {
      startTransition(() => rerender(concurrentTrafficView('prj_2', true, suspension)));
    });
    await act(async () => clearing.resolve(new Response(null, { status: 204 })));

    expect(await screen.findByText('Traffic:')).toBeVisible();
    expect(screen.getByText('List settled')).toBeVisible();
  });

  it('clears only the selected Project through the canonical route', async () => {
    const fetch = vi.fn((_url: string | URL | Request, options?: RequestInit) => Promise.resolve(
      options?.method === 'DELETE'
        ? new Response(null, { status: 204 })
        : response({ entries: [summary], latestId: summary.id, hasMore: false }),
    ));
    vi.stubGlobal('fetch', fetch);

    const { result } = renderHook(() => useTraffic('prj_1', { pollIntervalMs: 60_000 }));
    await waitFor(() => expect(result.current.entries).toHaveLength(1));
    await act(async () => result.current.clear());

    expect(fetch).toHaveBeenCalledWith(
      '/api/admin/projects/prj_1/traffic',
      expect.objectContaining({ method: 'DELETE' }),
    );
    expect(result.current.entries).toEqual([]);
  });

  it('permits Project B loading and ignores old Project A clear success after A-B-A', async () => {
    const oldClear = deferred<Response>();
    let oldClearSignal: AbortSignal | undefined;
    let projectALists = 0;
    const freshA = { ...summary, id: 'traffic_fresh_a', path: '/fresh-a' };
    const projectB = { ...summary, id: 'traffic_b', projectId: 'prj_2', path: '/project-b' };
    const fetch = vi.fn((url: string | URL | Request, options?: RequestInit) => {
      const value = String(url);
      if (options?.method === 'DELETE') {
        oldClearSignal = options.signal as AbortSignal;
        return oldClear.promise;
      }
      if (value.includes('/prj_2/')) {
        return Promise.resolve(response({ entries: [projectB], hasMore: false }));
      }
      projectALists += 1;
      return Promise.resolve(response({
        entries: [projectALists === 1 ? summary : freshA],
        hasMore: false,
      }));
    });
    vi.stubGlobal('fetch', fetch);
    const { result, rerender } = renderHook(
      ({ projectId }) => useTraffic(projectId, { pollIntervalMs: 60_000 }),
      { initialProps: { projectId: 'prj_1' } },
    );
    await waitFor(() => expect(result.current.entries[0]?.id).toBe('traffic_1'));
    let clearing!: Promise<boolean>;
    act(() => { clearing = result.current.clear(); });

    rerender({ projectId: 'prj_2' });
    expect(oldClearSignal?.aborted).toBe(true);
    await waitFor(() => expect(result.current.entries[0]?.id).toBe('traffic_b'));
    rerender({ projectId: 'prj_1' });
    await waitFor(() => expect(result.current.entries[0]?.id).toBe('traffic_fresh_a'));
    await act(async () => oldClear.resolve(new Response(null, { status: 204 })));
    await clearing;

    expect(result.current.entries[0]?.id).toBe('traffic_fresh_a');
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('ignores old Project A clear failure after returning to a new A generation', async () => {
    const oldClear = deferred<Response>();
    const fetch = vi.fn((url: string | URL | Request, options?: RequestInit) => {
      if (options?.method === 'DELETE') return oldClear.promise;
      const projectId = String(url).includes('/prj_2/') ? 'prj_2' : 'prj_1';
      return Promise.resolve(response({
        entries: [{ ...summary, projectId }],
        hasMore: false,
      }));
    });
    vi.stubGlobal('fetch', fetch);
    const { result, rerender } = renderHook(
      ({ projectId }) => useTraffic(projectId, { pollIntervalMs: 60_000 }),
      { initialProps: { projectId: 'prj_1' } },
    );
    await waitFor(() => expect(result.current.entries).toHaveLength(1));
    let clearing!: Promise<boolean>;
    act(() => { clearing = result.current.clear(); });
    rerender({ projectId: 'prj_2' });
    await waitFor(() => expect(result.current.entries[0]?.projectId).toBe('prj_2'));
    rerender({ projectId: 'prj_1' });
    await waitFor(() => expect(result.current.entries[0]?.projectId).toBe('prj_1'));

    await act(async () => oldClear.reject(new Error('stale clear failure')));
    await clearing;
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('does not let old clear settlement end the current generation poll or replace its list error', async () => {
    const oldClear = deferred<Response>();
    const currentPoll = deferred<Response>();
    let projectALists = 0;
    const fetch = vi.fn((url: string | URL | Request, options?: RequestInit) => {
      if (options?.method === 'DELETE') return oldClear.promise;
      if (String(url).includes('/prj_2/')) {
        return Promise.resolve(response({ entries: [], hasMore: false }));
      }
      projectALists += 1;
      if (projectALists === 2) return currentPoll.promise;
      return Promise.resolve(response({ entries: [summary], hasMore: false }));
    });
    vi.stubGlobal('fetch', fetch);
    const { result, rerender } = renderHook(
      ({ projectId }) => useTraffic(projectId, { pollIntervalMs: 60_000 }),
      { initialProps: { projectId: 'prj_1' } },
    );
    await waitFor(() => expect(result.current.entries).toHaveLength(1));
    act(() => { void result.current.clear(); });
    rerender({ projectId: 'prj_2' });
    await waitFor(() => expect(result.current.loading).toBe(false));
    rerender({ projectId: 'prj_1' });
    await waitFor(() => expect(result.current.loading).toBe(true));

    await act(async () => oldClear.resolve(new Response(null, { status: 204 })));
    expect(result.current.loading).toBe(true);
    await act(async () => currentPoll.reject(new Error('current poll failure')));
    await waitFor(() => expect(result.current.error?.message).toBe('current poll failure'));
    expect(result.current.loading).toBe(false);
  });

  it('publishes current clear failure only to its owning generation', async () => {
    const fetch = vi.fn((_url: string | URL | Request, options?: RequestInit) => options?.method === 'DELETE'
      ? Promise.reject(new Error('Current clear failure'))
      : Promise.resolve(response({ entries: [summary], hasMore: false })));
    vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useTraffic('prj_1', { pollIntervalMs: 60_000 }));
    await waitFor(() => expect(result.current.entries).toHaveLength(1));

    await act(async () => result.current.clear());

    expect(result.current.error?.message).toBe('Current clear failure');
    expect(result.current.loading).toBe(false);
  });

  it('replaces detail loading with the owning request error after rejection', async () => {
    const fetch = vi.fn((url: string | URL | Request) => String(url).endsWith('/traffic/traffic_1')
      ? Promise.reject(new Error('Traffic detail unavailable'))
      : Promise.resolve(response({ entries: [summary], latestId: summary.id, hasMore: false })));
    vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useTraffic('prj_1', { pollIntervalMs: 60_000 }));
    await waitFor(() => expect(result.current.entries).toHaveLength(1));

    act(() => result.current.select('traffic_1'));
    expect(result.current.detailLoading).toBe(true);
    await waitFor(() => expect(result.current.error?.message).toBe('Traffic detail unavailable'));
    expect(result.current.detailLoading).toBe(false);
    expect(result.current.selected).toBeNull();
  });

  it('does not let a stale Project detail finally clear the current request owner', async () => {
    const projectADetail = deferred<Response>();
    const projectBDetail = deferred<Response>();
    let projectADetailSignal: AbortSignal | undefined;
    const fetch = vi.fn((url: string | URL | Request, options?: RequestInit) => {
      const value = String(url);
      if (value.endsWith('/traffic/traffic_1')) {
        if (value.includes('/prj_1/')) projectADetailSignal = options?.signal as AbortSignal;
        return value.includes('/prj_1/') ? projectADetail.promise : projectBDetail.promise;
      }
      const projectSummary = value.includes('/prj_1/') ? summary : { ...summary, projectId: 'prj_2' };
      return Promise.resolve(response({ entries: [projectSummary], hasMore: false }));
    });
    vi.stubGlobal('fetch', fetch);
    const { result, rerender } = renderHook(
      ({ projectId }) => useTraffic(projectId, { pollIntervalMs: 60_000 }),
      { initialProps: { projectId: 'prj_1' } },
    );
    await waitFor(() => expect(result.current.entries).toHaveLength(1));
    act(() => result.current.select('traffic_1'));
    rerender({ projectId: 'prj_2' });
    expect(projectADetailSignal?.aborted).toBe(true);
    await waitFor(() => expect(result.current.entries[0]?.projectId).toBe('prj_2'));
    act(() => result.current.select('traffic_1'));
    expect(result.current.detailLoading).toBe(true);

    await act(async () => projectADetail.reject(new Error('stale Project failure')));
    expect(result.current.detailLoading).toBe(true);
    expect(result.current.error).toBeNull();
    await act(async () => projectBDetail.reject(new Error('current Project failure')));
    await waitFor(() => expect(result.current.error?.message).toBe('current Project failure'));
    expect(result.current.detailLoading).toBe(false);
  });

  it('keeps a detail error through concurrent polling and clears it on detail retry success', async () => {
    const polled = deferred<Response>();
    let listCalls = 0;
    let detailCalls = 0;
    const detail = { ...summary, request: {}, response: {} };
    const fetch = vi.fn((url: string | URL | Request) => {
      if (String(url).endsWith('/traffic/traffic_1')) {
        detailCalls += 1;
        return detailCalls === 1
          ? Promise.reject(new Error('Current detail failure'))
          : Promise.resolve(response(detail));
      }
      listCalls += 1;
      return listCalls === 1
        ? Promise.resolve(response({ entries: [summary], hasMore: false }))
        : polled.promise;
    });
    vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useTraffic('prj_1', { pollIntervalMs: 60_000 }));
    await waitFor(() => expect(result.current.entries).toHaveLength(1));
    act(() => result.current.select('traffic_1'));
    await waitFor(() => expect(result.current.error?.message).toBe('Current detail failure'));

    let refresh!: Promise<boolean>;
    act(() => { refresh = result.current.refresh(); });
    expect(result.current.loading).toBe(true);
    expect(result.current.error?.message).toBe('Current detail failure');
    await act(async () => polled.resolve(response({ entries: [summary], hasMore: false })));
    await refresh;
    expect(result.current.error?.message).toBe('Current detail failure');

    act(() => result.current.select('traffic_1'));
    expect(result.current.error).toBeNull();
    await waitFor(() => expect(result.current.selected?.id).toBe('traffic_1'));
    expect(result.current.error).toBeNull();
    expect(result.current.detailLoading).toBe(false);
  });

  it('clears only the list error after a successful list retry', async () => {
    let attempts = 0;
    const fetch = vi.fn(() => {
      attempts += 1;
      return attempts === 1
        ? Promise.reject(new Error('List polling failed'))
        : Promise.resolve(response({ entries: [summary], hasMore: false }));
    });
    vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useTraffic('prj_1', { pollIntervalMs: 60_000 }));
    await waitFor(() => expect(result.current.error?.message).toBe('List polling failed'));

    await act(async () => result.current.refresh());

    expect(result.current.error).toBeNull();
    expect(result.current.entries).toHaveLength(1);
  });

  it('does not publish stale list or detail errors after switching Projects', async () => {
    const projectAList = deferred<Response>();
    let projectAListSignal: AbortSignal | undefined;
    const fetch = vi.fn((url: string | URL | Request, options?: RequestInit) => {
      const value = String(url);
      if (value.includes('/prj_1/')) {
        projectAListSignal = options?.signal as AbortSignal;
        return projectAList.promise;
      }
      return Promise.resolve(response({
        entries: [{ ...summary, projectId: 'prj_2' }],
        hasMore: false,
      }));
    });
    vi.stubGlobal('fetch', fetch);
    const { result, rerender } = renderHook(
      ({ projectId }) => useTraffic(projectId, { pollIntervalMs: 60_000 }),
      { initialProps: { projectId: 'prj_1' } },
    );
    rerender({ projectId: 'prj_2' });
    expect(projectAListSignal?.aborted).toBe(true);
    await waitFor(() => expect(result.current.entries[0]?.projectId).toBe('prj_2'));

    await act(async () => projectAList.reject(new Error('stale list failure')));
    expect(result.current.error).toBeNull();
  });
});
