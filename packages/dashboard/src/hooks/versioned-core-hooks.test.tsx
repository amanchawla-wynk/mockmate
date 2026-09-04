import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBodyAsset } from './useBodyAsset';
import { useEndpoints } from './useEndpoints';
import { useRepositoryDiagnostics } from './useRepositoryDiagnostics';
import { useStates } from './useStates';
import { useProjects } from './useProjects';

const endpointSummary = {
  schemaVersion: 4 as const,
  id: 'ep_1',
  projectId: 'prj_1',
  name: 'Users',
  baseUrl: 'https://api.example.test',
  mode: 'mock' as const,
  method: 'GET',
  path: '/users',
  queryConstraintCount: 0,
  headerConstraintCount: 0,
  variantCount: 1,
  mockReady: true,
  revision: 1,
};

const endpointDetail = {
  schemaVersion: 4 as const,
  id: endpointSummary.id,
  projectId: endpointSummary.projectId,
  name: endpointSummary.name,
  description: 'User endpoint',
  baseUrl: endpointSummary.baseUrl,
  matcher: { method: 'GET', path: '/users', query: {} },
  mode: 'mock' as const,
  defaultVariantId: 'var_1',
  variants: [{
    id: 'var_1',
    endpointId: 'ep_1',
    name: 'OK',
    status: 200,
    responseHeaders: {},
    revision: 1,
  }],
  revision: 1,
};

const stateSummary = {
  id: 'state_1',
  projectId: 'prj_1',
  name: 'Signed in',
  tags: ['auth'],
  revision: 1,
  boundEndpointCount: 1,
  totalEndpointCount: 1,
  missingEndpointIds: [],
};

const stateDetail = {
  schemaVersion: 4 as const,
  id: 'state_1',
  projectId: 'prj_1',
  name: 'Signed in',
  tags: ['auth'],
  bindings: { ep_1: 'var_1' },
  revision: 1,
};

const corruptProject = {
  severity: 'blocking' as const,
  code: 'CORRUPT_PROJECT',
  file: 'projects/prj_1/project.json',
  message: 'Project is corrupt',
  recovery: 'Repair the Project file.',
  projectId: 'prj_1',
};

const corruptEndpoint = {
  severity: 'blocking' as const,
  code: 'CORRUPT_ENDPOINT',
  file: 'projects/prj_1/endpoints/ep_1.json',
  message: 'Endpoint is corrupt',
  recovery: 'Repair the Endpoint file.',
  projectId: 'prj_1',
};

const projectSummary = {
  id: 'prj_1',
  name: 'Project',
  revision: 1,
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const workspace = {
  schemaVersion: 4 as const,
  revision: 1,
};

const canonicalProject = {
  schemaVersion: 4 as const,
  ...projectSummary,
  appStateMode: 'enabled' as const,
  createdAt: '2026-01-01T00:00:00.000Z',
};

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init.headers },
  });
}

function binaryResponse(body: BodyInit, contentType: string): Response {
  return new Response(body, { headers: { 'Content-Type': contentType } });
}

function requests(): string[] {
  return vi.mocked(fetch).mock.calls.map(([url]) => String(url));
}

interface PendingRequest {
  url: string;
  signal: AbortSignal;
  resolve(response: Response): void;
  reject(error: Error): void;
}

function deferredFetches(): { fetch: typeof fetch; pending: PendingRequest[] } {
  const pending: PendingRequest[] = [];
  const deferred = vi.fn((url: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      pending.push({
        url: String(url),
        signal: init?.signal as AbortSignal,
        resolve,
        reject,
      });
    })) as typeof fetch;
  return { fetch: deferred, pending };
}

function abortableDeferredFetches(): { fetch: typeof fetch; pending: PendingRequest[] } {
  const pending: PendingRequest[] = [];
  const deferred = vi.fn((url: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      const signal = init?.signal as AbortSignal;
      const abort = () => reject(new DOMException('Aborted', 'AbortError'));
      const settle = (callback: () => void) => {
        signal.removeEventListener('abort', abort);
        callback();
      };
      pending.push({
        url: String(url),
        signal,
        resolve: response => settle(() => resolve(response)),
        reject: error => settle(() => reject(error)),
      });
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    })) as typeof fetch;
  return { fetch: deferred, pending };
}

describe('canonical lazy dashboard hooks', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loads endpoint summaries without details or body requests', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse([endpointSummary]));

    const { result } = renderHook(() => useEndpoints('prj_1'));

    await waitFor(() => expect(result.current.endpoints).toEqual([endpointSummary]));
    expect(requests()).toEqual(['/api/admin/projects/prj_1/endpoints']);
  });

  it('returns Endpoint canonical read results while retaining local errors', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse([endpointSummary]));
    const { result } = renderHook(() => useEndpoints('prj_1'));
    await waitFor(() => expect(result.current.endpoints).toEqual([endpointSummary]));
    vi.mocked(fetch).mockRejectedValueOnce(new Error('Endpoint canonical failure'));

    let failed: boolean | undefined;
    await act(async () => { failed = await result.current.refresh(); });

    expect(failed).toBe(false);
    expect(result.current.error?.message).toBe('Endpoint canonical failure');

    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse([{ ...endpointSummary, revision: 2 }]));
    let retried: boolean | undefined;
    await act(async () => { retried = await result.current.refresh(); });
    expect(retried).toBe(true);
    expect(result.current.endpoints[0]?.revision).toBe(2);
    expect(result.current.error).toBeUndefined();
  });

  it('aborts stale endpoint detail when selection changes', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse([endpointSummary]));
    const deferred = deferredFetches();
    vi.mocked(fetch).mockImplementationOnce(deferred.fetch).mockImplementationOnce(deferred.fetch);
    const { result } = renderHook(() => useEndpoints('prj_1'));
    await waitFor(() => expect(result.current.endpoints).toEqual([endpointSummary]));

    act(() => result.current.selectEndpoint('ep_1'));
    act(() => result.current.selectEndpoint('ep_2'));

    expect(deferred.pending[0]?.signal.aborted).toBe(true);
    expect(deferred.pending[1]?.signal.aborted).toBe(false);
  });

  it.each(['resolve', 'reject'] as const)(
    'does not let stale endpoint detail %s clear current loading or state',
    async staleOutcome => {
      vi.mocked(fetch).mockResolvedValueOnce(jsonResponse([endpointSummary]));
      const deferred = deferredFetches();
      vi.mocked(fetch).mockImplementationOnce(deferred.fetch).mockImplementationOnce(deferred.fetch);
      const { result } = renderHook(() => useEndpoints('prj_1'));
      await waitFor(() => expect(result.current.endpoints).toEqual([endpointSummary]));

      act(() => result.current.selectEndpoint('ep_old'));
      act(() => result.current.selectEndpoint('ep_new'));
      await act(async () => {
        if (staleOutcome === 'resolve') {
          deferred.pending[0]?.resolve(jsonResponse({ ...endpointDetail, id: 'ep_old' }));
        } else {
          deferred.pending[0]?.reject(new Error('stale failure'));
        }
        await Promise.resolve();
      });

      expect(result.current.detailLoading).toBe(true);
      expect(result.current.selectedEndpoint).toBeUndefined();
      expect(result.current.error).toBeUndefined();

      await act(async () => {
        deferred.pending[1]?.resolve(jsonResponse({ ...endpointDetail, id: 'ep_new' }));
      });
      expect(result.current.selectedEndpoint?.id).toBe('ep_new');
      expect(result.current.detailLoading).toBe(false);
    },
  );

  it.each(['resolve', 'reject'] as const)(
    'keeps Endpoint data and loading owned by the newest manual refresh after stale %s',
    async staleOutcome => {
      vi.mocked(fetch).mockResolvedValueOnce(jsonResponse([endpointSummary]));
      const { result } = renderHook(() => useEndpoints('prj_1'));
      await waitFor(() => expect(result.current.endpoints).toEqual([endpointSummary]));
      const deferred = deferredFetches();
      vi.mocked(fetch).mockImplementation(deferred.fetch);

      let first: Promise<boolean> | undefined;
      let second: Promise<boolean> | undefined;
      act(() => {
        first = result.current.refresh();
        second = result.current.refresh();
      });
      await act(async () => {
        if (staleOutcome === 'resolve') {
          deferred.pending[0]?.resolve(jsonResponse([{ ...endpointSummary, id: 'ep_stale' }]));
        } else {
          deferred.pending[0]?.reject(new Error('stale Endpoint refresh'));
        }
        await first;
      });

      expect(result.current.endpoints).toEqual([endpointSummary]);
      expect(result.current.loading).toBe(true);
      expect(result.current.error).toBeUndefined();

      await act(async () => {
        deferred.pending[1]?.resolve(jsonResponse([{ ...endpointSummary, id: 'ep_current' }]));
        await second;
      });
      expect(result.current.endpoints[0]?.id).toBe('ep_current');
      expect(result.current.loading).toBe(false);
    },
  );

  it.each(['resolve', 'reject'] as const)(
    'does not let a stale Project list %s overwrite the current Project lifecycle',
    async staleOutcome => {
      const deferred = deferredFetches();
      vi.stubGlobal('fetch', deferred.fetch);
      const { result, rerender } = renderHook(
        ({ projectId }) => useEndpoints(projectId),
        { initialProps: { projectId: 'project-a' } },
      );
      await waitFor(() => expect(deferred.pending).toHaveLength(1));

      rerender({ projectId: 'project-b' });
      await waitFor(() => expect(deferred.pending).toHaveLength(2));
      expect(deferred.pending[0]?.signal.aborted).toBe(true);
      await act(async () => {
        deferred.pending[1]?.resolve(jsonResponse([{ ...endpointSummary, projectId: 'project-b' }]));
      });
      await waitFor(() => expect(result.current.endpoints[0]?.projectId).toBe('project-b'));

      await act(async () => {
        if (staleOutcome === 'resolve') {
          deferred.pending[0]?.resolve(jsonResponse([{ ...endpointSummary, projectId: 'project-a' }]));
        } else {
          deferred.pending[0]?.reject(new Error('stale list failure'));
        }
      });

      expect(result.current.endpoints[0]?.projectId).toBe('project-b');
      expect(result.current.loading).toBe(false);
      expect(result.current.error).toBeUndefined();
    },
  );

  it('aborts list and detail work during cleanup', async () => {
    const deferred = deferredFetches();
    vi.stubGlobal('fetch', deferred.fetch);
    const listHook = renderHook(() => useEndpoints('prj_1'));
    await waitFor(() => expect(deferred.pending).toHaveLength(1));
    listHook.unmount();
    expect(deferred.pending[0]?.signal.aborted).toBe(true);

    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse([endpointSummary]));
    const detailHook = renderHook(() => useEndpoints('prj_1'));
    await waitFor(() => expect(detailHook.result.current.endpoints).toEqual([endpointSummary]));
    act(() => detailHook.result.current.selectEndpoint('ep_1'));
    await waitFor(() => expect(deferred.pending).toHaveLength(2));
    detailHook.unmount();
    expect(deferred.pending[1]?.signal.aborted).toBe(true);
  });

  it('publishes authoritative Endpoint detail and rejects stale detail completion', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse([endpointSummary]));
    const { result } = renderHook(() => useEndpoints('prj_1'));
    await waitFor(() => expect(result.current.endpoints).toEqual([endpointSummary]));
    const deferred = deferredFetches();
    vi.mocked(fetch).mockImplementation(deferred.fetch);
    act(() => result.current.selectEndpoint('ep_1'));
    await waitFor(() => expect(deferred.pending).toHaveLength(1));
    const saved = { ...endpointDetail, name: 'Saved Endpoint', revision: 5 };

    expect(result.current.beginEndpointPublication).toBeTypeOf('function');
    const publication = result.current.beginEndpointPublication();
    expect(result.current.publishEndpoint).toBeTypeOf('function');
    let accepted: boolean | undefined;
    act(() => { accepted = result.current.publishEndpoint(publication, saved); });
    expect(accepted).toBe(true);
    expect(deferred.pending[0]?.signal.aborted).toBe(true);
    await act(async () => {
      deferred.pending[0]?.resolve(jsonResponse({ ...endpointDetail, name: 'Stale Endpoint' }));
    });

    expect(result.current.selectedEndpoint).toEqual(saved);
    expect(result.current.selectedEndpointId).toBe(saved.id);
    expect(result.current.detailLoading).toBe(false);

    const stalePublication = result.current.beginEndpointPublication();
    act(() => result.current.selectEndpoint('ep_newer'));
    await waitFor(() => expect(deferred.pending).toHaveLength(2));
    let staleAccepted: boolean | undefined;
    act(() => { staleAccepted = result.current.publishEndpoint(stalePublication, { ...saved, revision: 6 }); });
    expect(staleAccepted).toBe(false);
    expect(deferred.pending[1]?.signal.aborted).toBe(false);
    expect(result.current.selectedEndpointId).toBe('ep_newer');
    expect(result.current.detailLoading).toBe(true);
  });

  it.each([
    ['cleared', undefined],
    ['changed', 'ep_2'],
  ] as const)('rejects Endpoint publication after selection is %s', async (_case, nextSelection) => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse([endpointSummary]));
    const { result } = renderHook(() => useEndpoints('prj_1'));
    await waitFor(() => expect(result.current.endpoints).toEqual([endpointSummary]));
    vi.mocked(fetch).mockResolvedValue(jsonResponse(endpointDetail));
    act(() => result.current.selectEndpoint('ep_1'));
    await waitFor(() => expect(result.current.selectedEndpoint?.id).toBe('ep_1'));
    const publication = result.current.beginEndpointPublication();
    if (nextSelection) {
      vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ ...endpointDetail, id: nextSelection }));
    }

    act(() => result.current.selectEndpoint(nextSelection));
    let accepted: boolean | undefined;
    act(() => { accepted = result.current.publishEndpoint(publication, { ...endpointDetail, revision: 5 }); });

    expect(accepted).toBe(false);
    expect(result.current.selectedEndpointId).toBe(nextSelection);
    if (nextSelection) {
      await waitFor(() => expect(result.current.selectedEndpoint?.id).toBe(nextSelection));
      expect(result.current.selectedEndpoint?.revision).toBe(endpointDetail.revision);
    } else {
      expect(result.current.selectedEndpoint).toBeUndefined();
    }
  });

  it('keeps Endpoint reload detail owned across stale, aborted, selection, and Project generations', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse([endpointSummary]))
      .mockResolvedValueOnce(jsonResponse(endpointDetail));
    const { result, rerender } = renderHook(
      ({ projectId }) => useEndpoints(projectId),
      { initialProps: { projectId: 'prj_1' } },
    );
    await waitFor(() => expect(result.current.endpoints).toEqual([endpointSummary]));
    act(() => result.current.selectEndpoint('ep_1'));
    await waitFor(() => expect(result.current.selectedEndpoint).toEqual(endpointDetail));

    const deferred = deferredFetches();
    vi.mocked(fetch).mockImplementation(deferred.fetch);
    let olderReload: Promise<boolean> | undefined;
    let newerReload: Promise<boolean> | undefined;
    act(() => {
      olderReload = result.current.reloadSelected();
      newerReload = result.current.reloadSelected();
    });
    expect(deferred.pending[0]?.signal.aborted).toBe(true);
    expect(result.current.selectedEndpoint).toEqual(endpointDetail);
    expect(result.current.detailLoading).toBe(true);

    act(() => result.current.selectEndpoint('ep_2'));
    await waitFor(() => expect(deferred.pending).toHaveLength(3));
    await act(async () => {
      deferred.pending[2]?.resolve(jsonResponse({ ...endpointDetail, id: 'ep_2', name: 'Second' }));
    });
    expect(result.current.selectedEndpoint?.id).toBe('ep_2');

    rerender({ projectId: 'prj_2' });
    await waitFor(() => expect(deferred.pending).toHaveLength(4));
    await act(async () => {
      deferred.pending[3]?.resolve(jsonResponse([{ ...endpointSummary, id: 'ep_3', projectId: 'prj_2' }]));
    });
    act(() => result.current.selectEndpoint('ep_3'));
    await waitFor(() => expect(deferred.pending).toHaveLength(5));
    await act(async () => {
      deferred.pending[4]?.resolve(jsonResponse({ ...endpointDetail, id: 'ep_3', projectId: 'prj_2', name: 'Current' }));
    });

    await act(async () => {
      deferred.pending[1]?.resolve(jsonResponse({ ...endpointDetail, name: 'Newer stale reload', revision: 2 }));
      await newerReload;
      deferred.pending[0]?.resolve(jsonResponse({ ...endpointDetail, name: 'Older stale reload', revision: 3 }));
      await olderReload;
    });
    expect(result.current.selectedEndpoint).toMatchObject({
      id: 'ep_3', projectId: 'prj_2', name: 'Current',
    });
    expect(result.current.detailLoading).toBe(false);
    expect(result.current.error).toBeUndefined();
  });

  it('reports selected Endpoint reload success and failure without changing selection', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse([endpointSummary]))
      .mockResolvedValueOnce(jsonResponse(endpointDetail));
    const { result } = renderHook(() => useEndpoints('prj_1'));
    await waitFor(() => expect(result.current.endpoints).toEqual([endpointSummary]));
    act(() => result.current.selectEndpoint('ep_1'));
    await waitFor(() => expect(result.current.selectedEndpoint).toEqual(endpointDetail));
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ ...endpointDetail, name: 'Canonical import', revision: 2 }))
      .mockRejectedValueOnce(new Error('selected Endpoint refresh failed'));

    let succeeded = false;
    await act(async () => { succeeded = await result.current.reloadSelected(); });
    expect(succeeded).toBe(true);
    expect(result.current.selectedEndpointId).toBe('ep_1');
    expect(result.current.selectedEndpoint).toMatchObject({ name: 'Canonical import', revision: 2 });

    let failed = true;
    await act(async () => { failed = await result.current.reloadSelected(); });
    expect(failed).toBe(false);
    expect(result.current.selectedEndpointId).toBe('ep_1');
  });

  it('does not let a retained Endpoint reload callback abort a newer Project detail owner', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse([endpointSummary]))
      .mockResolvedValueOnce(jsonResponse(endpointDetail));
    const { result, rerender } = renderHook(
      ({ projectId }) => useEndpoints(projectId),
      { initialProps: { projectId: 'prj_1' } },
    );
    await waitFor(() => expect(result.current.endpoints).toEqual([endpointSummary]));
    act(() => result.current.selectEndpoint('ep_1'));
    await waitFor(() => expect(result.current.selectedEndpoint).toEqual(endpointDetail));
    const retainedReloadSelected = result.current.reloadSelected;

    const deferred = deferredFetches();
    vi.mocked(fetch).mockImplementation(deferred.fetch);
    rerender({ projectId: 'prj_2' });
    await waitFor(() => expect(deferred.pending).toHaveLength(1));
    await act(async () => {
      deferred.pending[0]?.resolve(jsonResponse([{ ...endpointSummary, id: 'ep_3', projectId: 'prj_2' }]));
    });
    act(() => result.current.selectEndpoint('ep_3'));
    await waitFor(() => expect(deferred.pending).toHaveLength(2));

    let retainedReload: Promise<boolean> | undefined;
    act(() => {
      retainedReload = retainedReloadSelected();
    });
    expect(deferred.pending).toHaveLength(2);
    expect(deferred.pending[1]?.signal.aborted).toBe(false);

    await act(async () => {
      deferred.pending[1]?.resolve(jsonResponse({
        ...endpointDetail,
        id: 'ep_3',
        projectId: 'prj_2',
        name: 'Current',
      }));
      await retainedReload;
    });
    expect(result.current.selectedEndpoint).toMatchObject({
      id: 'ep_3', projectId: 'prj_2', name: 'Current',
    });
    expect(result.current.detailLoading).toBe(false);
    expect(result.current.error).toBeUndefined();
  });

  it('loads state summaries and defers detail until selected', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse([stateSummary]))
      .mockResolvedValueOnce(jsonResponse(stateDetail));
    const { result } = renderHook(() => useStates('prj_1'));
    await waitFor(() => expect(result.current.states).toEqual([stateSummary]));
    expect(requests()).toEqual(['/api/admin/projects/prj_1/states']);

    act(() => result.current.selectState('state_1'));
    await waitFor(() => expect(result.current.selectedState).toEqual(stateDetail));
    expect(requests()[1]).toBe('/api/admin/projects/prj_1/states/state_1');
  });

  it('returns State list read results while retaining local errors', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse([stateSummary]));
    const { result } = renderHook(() => useStates('prj_1'));
    await waitFor(() => expect(result.current.states).toEqual([stateSummary]));
    vi.mocked(fetch).mockRejectedValueOnce(new Error('State canonical failure'));

    let failed: boolean | undefined;
    await act(async () => { failed = await result.current.refresh(); });

    expect(failed).toBe(false);
    expect(result.current.error?.message).toBe('State canonical failure');

    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse([{ ...stateSummary, revision: 2 }]));
    let retried: boolean | undefined;
    await act(async () => { retried = await result.current.refresh(); });
    expect(retried).toBe(true);
    expect(result.current.states[0]?.revision).toBe(2);
    expect(result.current.error).toBeUndefined();
  });

  it('treats no selected State as successful and reports selected-detail failure', async () => {
    const empty = renderHook(() => useStates(undefined));
    await expect(empty.result.current.reloadSelected()).resolves.toBe(true);
    empty.unmount();

    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse([stateSummary]))
      .mockResolvedValueOnce(jsonResponse(stateDetail));
    const { result } = renderHook(() => useStates('prj_1'));
    await waitFor(() => expect(result.current.states).toEqual([stateSummary]));
    act(() => result.current.selectState('state_1'));
    await waitFor(() => expect(result.current.selectedState).toEqual(stateDetail));
    vi.mocked(fetch).mockRejectedValueOnce(new Error('Selected State canonical failure'));

    let failed: boolean | undefined;
    await act(async () => { failed = await result.current.reloadSelected(); });

    expect(failed).toBe(false);
    expect(result.current.error?.message).toBe('Selected State canonical failure');
  });

  it('rejects an App State publication after selection ownership changes', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse([stateSummary]))
      .mockResolvedValueOnce(jsonResponse(stateDetail))
      .mockResolvedValueOnce(jsonResponse({ ...stateDetail, id: 'state_2', name: 'Second' }));
    const { result } = renderHook(() => useStates('prj_1'));
    await waitFor(() => expect(result.current.states).toEqual([stateSummary]));
    act(() => result.current.selectState('state_1'));
    await waitFor(() => expect(result.current.selectedState).toEqual(stateDetail));
    const publication = result.current.beginStatePublication();

    act(() => result.current.selectState('state_2'));
    await waitFor(() => expect(result.current.selectedState?.id).toBe('state_2'));

    let accepted = true;
    act(() => {
      accepted = result.current.publishState(publication, {
        ...stateDetail,
        name: 'Late saved State A',
        revision: stateDetail.revision + 1,
      });
    });

    expect(accepted).toBe(false);
    expect(result.current.selectedState).toMatchObject({ id: 'state_2', name: 'Second' });
  });

  it.each(['resolve', 'reject'] as const)(
    'keeps State data and loading owned by the newest manual refresh after stale %s',
    async staleOutcome => {
      vi.mocked(fetch).mockResolvedValueOnce(jsonResponse([stateSummary]));
      const { result } = renderHook(() => useStates('prj_1'));
      await waitFor(() => expect(result.current.states).toEqual([stateSummary]));
      const deferred = deferredFetches();
      vi.mocked(fetch).mockImplementation(deferred.fetch);

      let first: Promise<boolean> | undefined;
      let second: Promise<boolean> | undefined;
      act(() => {
        first = result.current.refresh();
        second = result.current.refresh();
      });
      await act(async () => {
        if (staleOutcome === 'resolve') {
          deferred.pending[0]?.resolve(jsonResponse([{ ...stateSummary, id: 'state_stale' }]));
        } else {
          deferred.pending[0]?.reject(new Error('stale State refresh'));
        }
        await first;
      });

      expect(result.current.states).toEqual([stateSummary]);
      expect(result.current.loading).toBe(true);
      expect(result.current.error).toBeUndefined();

      await act(async () => {
        deferred.pending[1]?.resolve(jsonResponse([{ ...stateSummary, id: 'state_current' }]));
        await second;
      });
      expect(result.current.states[0]?.id).toBe('state_current');
      expect(result.current.loading).toBe(false);
    },
  );

  it('keeps App State reload detail owned across stale, aborted, selection, and Project generations', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse([stateSummary]))
      .mockResolvedValueOnce(jsonResponse(stateDetail));
    const { result, rerender } = renderHook(
      ({ projectId }) => useStates(projectId),
      { initialProps: { projectId: 'prj_1' } },
    );
    await waitFor(() => expect(result.current.states).toEqual([stateSummary]));
    act(() => result.current.selectState('state_1'));
    await waitFor(() => expect(result.current.selectedState).toEqual(stateDetail));

    const deferred = deferredFetches();
    vi.mocked(fetch).mockImplementation(deferred.fetch);
    let olderReload: Promise<boolean> | undefined;
    let newerReload: Promise<boolean> | undefined;
    act(() => {
      olderReload = result.current.reloadSelected();
      newerReload = result.current.reloadSelected();
    });
    expect(deferred.pending[0]?.signal.aborted).toBe(true);
    expect(result.current.selectedState).toEqual(stateDetail);
    expect(result.current.detailLoading).toBe(true);

    act(() => result.current.selectState('state_2'));
    await waitFor(() => expect(deferred.pending).toHaveLength(3));
    await act(async () => {
      deferred.pending[2]?.resolve(jsonResponse({ ...stateDetail, id: 'state_2', name: 'Second' }));
    });
    expect(result.current.selectedState?.id).toBe('state_2');

    rerender({ projectId: 'prj_2' });
    await waitFor(() => expect(deferred.pending).toHaveLength(4));
    await act(async () => {
      deferred.pending[3]?.resolve(jsonResponse([{ ...stateSummary, id: 'state_3', projectId: 'prj_2' }]));
    });
    act(() => result.current.selectState('state_3'));
    await waitFor(() => expect(deferred.pending).toHaveLength(5));
    await act(async () => {
      deferred.pending[4]?.resolve(jsonResponse({ ...stateDetail, id: 'state_3', projectId: 'prj_2', name: 'Current' }));
    });

    await act(async () => {
      deferred.pending[1]?.resolve(jsonResponse({ ...stateDetail, name: 'Newer stale reload', revision: 2 }));
      await newerReload;
      deferred.pending[0]?.resolve(jsonResponse({ ...stateDetail, name: 'Older stale reload', revision: 3 }));
      await olderReload;
    });
    expect(result.current.selectedState).toMatchObject({
      id: 'state_3', projectId: 'prj_2', name: 'Current',
    });
    expect(result.current.detailLoading).toBe(false);
    expect(result.current.error).toBeUndefined();
  });

  it('does not let a retained App State reload callback abort a newer Project detail owner', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse([stateSummary]))
      .mockResolvedValueOnce(jsonResponse(stateDetail));
    const { result, rerender } = renderHook(
      ({ projectId }) => useStates(projectId),
      { initialProps: { projectId: 'prj_1' } },
    );
    await waitFor(() => expect(result.current.states).toEqual([stateSummary]));
    act(() => result.current.selectState('state_1'));
    await waitFor(() => expect(result.current.selectedState).toEqual(stateDetail));
    const retainedReloadSelected = result.current.reloadSelected;

    const deferred = deferredFetches();
    vi.mocked(fetch).mockImplementation(deferred.fetch);
    rerender({ projectId: 'prj_2' });
    await waitFor(() => expect(deferred.pending).toHaveLength(1));
    await act(async () => {
      deferred.pending[0]?.resolve(jsonResponse([{ ...stateSummary, id: 'state_3', projectId: 'prj_2' }]));
    });
    act(() => result.current.selectState('state_3'));
    await waitFor(() => expect(deferred.pending).toHaveLength(2));

    let retainedReload: Promise<boolean> | undefined;
    act(() => {
      retainedReload = retainedReloadSelected();
    });
    expect(deferred.pending).toHaveLength(2);
    expect(deferred.pending[1]?.signal.aborted).toBe(false);

    await act(async () => {
      deferred.pending[1]?.resolve(jsonResponse({
        ...stateDetail,
        id: 'state_3',
        projectId: 'prj_2',
        name: 'Current',
      }));
      await retainedReload;
    });
    expect(result.current.selectedState).toMatchObject({
      id: 'state_3', projectId: 'prj_2', name: 'Current',
    });
    expect(result.current.detailLoading).toBe(false);
    expect(result.current.error).toBeUndefined();
  });

  it('does not download a body until explicitly opened', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(binaryResponse('body', 'application/json'));
    const { result } = renderHook(() => useBodyAsset('prj_1'));
    expect(requests()).toEqual([]);

    await act(() => result.current.open('a'.repeat(64)));

    expect(requests()).toEqual([`/api/admin/projects/prj_1/bodies/${'a'.repeat(64)}`]);
  });

  it('aborts stale body work and keeps the newest body lifecycle', async () => {
    const deferred = deferredFetches();
    vi.stubGlobal('fetch', deferred.fetch);
    const { result } = renderHook(() => useBodyAsset('prj_1'));

    let first: Promise<Response> | undefined;
    let second: Promise<Response> | undefined;
    act(() => {
      first = result.current.open('a'.repeat(64));
      second = result.current.open('b'.repeat(64));
    });
    expect(deferred.pending[0]?.signal.aborted).toBe(true);
    await act(async () => {
      deferred.pending[0]?.resolve(binaryResponse('old', 'text/plain'));
      await first;
    });
    expect(result.current.loading).toBe(true);
    expect(result.current.response).toBeUndefined();

    await act(async () => {
      deferred.pending[1]?.resolve(binaryResponse('new', 'text/plain'));
      await second;
    });
    expect(result.current.assetId).toBe('b'.repeat(64));
    expect(result.current.loading).toBe(false);
  });

  it('ignores a stale body error without finalizing the current open', async () => {
    const deferred = deferredFetches();
    vi.stubGlobal('fetch', deferred.fetch);
    const { result } = renderHook(() => useBodyAsset('prj_1'));

    let first: Promise<Response> | undefined;
    let second: Promise<Response> | undefined;
    act(() => {
      first = result.current.open('a'.repeat(64));
      second = result.current.open('b'.repeat(64));
    });
    await act(async () => {
      deferred.pending[0]?.reject(new Error('stale body failure'));
      await expect(first).rejects.toThrow('stale body failure');
    });
    expect(result.current.loading).toBe(true);
    expect(result.current.response).toBeUndefined();
    expect(result.current.error).toBeUndefined();

    await act(async () => {
      deferred.pending[1]?.resolve(binaryResponse('current', 'text/plain'));
      await second;
    });
    expect(result.current.assetId).toBe('b'.repeat(64));
    expect(result.current.loading).toBe(false);
  });

  it('loads global and Project diagnostics independently', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ diagnostics: [corruptProject] }))
      .mockResolvedValueOnce(jsonResponse({ projectId: 'prj_1', diagnostics: [corruptEndpoint] }));
    const global = renderHook(() => useRepositoryDiagnostics());
    await waitFor(() => expect(global.result.current.diagnostics).toEqual([corruptProject]));
    global.unmount();

    const project = renderHook(() => useRepositoryDiagnostics('prj_1'));
    await waitFor(() => expect(project.result.current.diagnostics).toEqual([corruptEndpoint]));

    expect(requests()).toEqual(['/api/admin/diagnostics', '/api/admin/projects/prj_1/diagnostics']);
  });

  it.each(['resolve', 'reject'] as const)(
    'keeps diagnostics and loading owned by the newest manual refresh after stale %s',
    async staleOutcome => {
      vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ diagnostics: [corruptProject] }));
      const { result } = renderHook(() => useRepositoryDiagnostics());
      await waitFor(() => expect(result.current.diagnostics).toEqual([corruptProject]));
      const deferred = deferredFetches();
      vi.mocked(fetch).mockImplementation(deferred.fetch);

      let first: Promise<void> | undefined;
      let second: Promise<void> | undefined;
      act(() => {
        first = result.current.refresh();
        second = result.current.refresh();
      });
      await act(async () => {
        if (staleOutcome === 'resolve') {
          deferred.pending[0]?.resolve(jsonResponse({ diagnostics: [corruptEndpoint] }));
        } else {
          deferred.pending[0]?.reject(new Error('stale diagnostics refresh'));
        }
        await first;
      });

      expect(result.current.diagnostics).toEqual([corruptProject]);
      expect(result.current.loading).toBe(true);
      expect(result.current.error).toBeUndefined();

      await act(async () => {
        deferred.pending[1]?.resolve(jsonResponse({ diagnostics: [] }));
        await second;
      });
      expect(result.current.diagnostics).toEqual([]);
      expect(result.current.loading).toBe(false);
    },
  );

  it('loads Project summaries, workspace, and only the active Project detail', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse([projectSummary]))
      .mockResolvedValueOnce(jsonResponse({ schemaVersion: 4, activeProjectId: 'prj_1', revision: 1 }))
      .mockResolvedValueOnce(jsonResponse(canonicalProject));

    const { result } = renderHook(() => useProjects());

    await waitFor(() => expect(result.current.activeProject).toEqual(canonicalProject));
    expect(result.current.projects).toEqual([projectSummary]);
    expect(requests()).toEqual([
      '/api/admin/projects',
      '/api/admin/workspace',
      '/api/admin/projects/prj_1',
    ]);
  });

  it.each(['resolve', 'reject'] as const)(
    'keeps versioned Project data and loading owned by the newest manual refresh after stale %s',
    async staleOutcome => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(jsonResponse([projectSummary]))
        .mockResolvedValueOnce(jsonResponse(workspace));
      const { result } = renderHook(() => useProjects());
      await waitFor(() => expect(result.current.loading).toBe(false));
      const deferred = deferredFetches();
      vi.mocked(fetch).mockImplementation(deferred.fetch);

      let first: Promise<void> | undefined;
      let second: Promise<void> | undefined;
      act(() => {
        first = result.current.refresh();
        second = result.current.refresh();
      });
      await act(async () => {
        if (staleOutcome === 'resolve') {
          deferred.pending[0]?.resolve(jsonResponse([{ ...projectSummary, id: 'prj_stale' }]));
        } else {
          deferred.pending[0]?.reject(new Error('stale Project refresh'));
        }
        deferred.pending[1]?.resolve(jsonResponse(workspace));
        await first;
      });

      expect(result.current.projects).toEqual([projectSummary]);
      expect(result.current.loading).toBe(true);
      expect(result.current.error).toBeUndefined();

      await act(async () => {
        deferred.pending[2]?.resolve(jsonResponse([{ ...projectSummary, id: 'prj_current' }]));
        deferred.pending[3]?.resolve(jsonResponse(workspace));
        await second;
      });
      expect(result.current.projects[0]?.id).toBe('prj_current');
      expect(result.current.loading).toBe(false);
    },
  );

  it.each([
    { name: 'Project list', failedIndex: 0, siblingIndex: 1 },
    { name: 'workspace', failedIndex: 1, siblingIndex: 0 },
  ])('preserves a primary $name failure while aborting and settling its sibling', async ({
    failedIndex,
    siblingIndex,
  }) => {
    const deferred = abortableDeferredFetches();
    vi.stubGlobal('fetch', deferred.fetch);
    const hook = renderHook(() => useProjects());
    await waitFor(() => expect(deferred.pending).toHaveLength(2));

    act(() => {
      deferred.pending[failedIndex]?.reject(new Error('primary refresh failure'));
    });
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    expect(deferred.pending[siblingIndex]?.signal.aborted).toBe(true);
    expect(hook.result.current.error?.message).toBe('primary refresh failure');

    act(() => {
      void hook.result.current.refresh();
    });
    await waitFor(() => expect(deferred.pending).toHaveLength(4));
    hook.unmount();
    expect(deferred.pending[2]?.signal.aborted).toBe(true);
    expect(deferred.pending[3]?.signal.aborted).toBe(true);
  });

  it.each([
    {
      name: 'create',
      invoke: (hook: ReturnType<typeof useProjects>) => hook.create({ name: 'Created' }),
      response: () => jsonResponse(canonicalProject, { status: 201 }),
      expected: canonicalProject,
    },
    {
      name: 'update',
      invoke: (hook: ReturnType<typeof useProjects>) =>
        hook.update('prj_1', 1, { name: 'Updated' }),
      response: () => jsonResponse({ ...canonicalProject, name: 'Updated' }),
      expected: { ...canonicalProject, name: 'Updated' },
    },
    {
      name: 'setActive',
      invoke: (hook: ReturnType<typeof useProjects>) => hook.setActive('prj_1', 1),
      response: () => jsonResponse({ ...workspace, activeProjectId: 'prj_1', revision: 2 }),
      expected: { ...workspace, activeProjectId: 'prj_1', revision: 2 },
    },
    {
      name: 'remove',
      invoke: (hook: ReturnType<typeof useProjects>) => hook.remove('prj_1', 1),
      response: () => new Response(null, { status: 204 }),
      expected: undefined,
    },
  ])('does not refresh when $name completes after cleanup', async ({ invoke, response, expected }) => {
    let resolveMutation: ((value: Response) => void) | undefined;
    const fetch = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      if (!init?.method && String(url).endsWith('/projects')) {
        return Promise.resolve(jsonResponse([projectSummary]));
      }
      if (!init?.method && String(url).endsWith('/workspace')) {
        return Promise.resolve(jsonResponse(workspace));
      }
      return new Promise<Response>(resolve => {
        resolveMutation = resolve;
      });
    });
    vi.stubGlobal('fetch', fetch);
    const hook = renderHook(() => useProjects());
    await waitFor(() => expect(hook.result.current.loading).toBe(false));

    const mutation = invoke(hook.result.current);
    await waitFor(() => expect(resolveMutation).toBeDefined());
    hook.unmount();
    resolveMutation?.(response());

    await expect(mutation).resolves.toEqual(expected);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
