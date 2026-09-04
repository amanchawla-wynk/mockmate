import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import App from './App';
import { endpointsApi, importApi, statesApi } from './api/client';
import type {
  AppState,
  AppStateSummary,
  EndpointDetail,
  EndpointSummary,
  ImportCommitResult,
  ImportPreview,
  Project,
} from './api/types';
import type { ViewType } from './components/ProjectList';

const projectA: Project = {
  schemaVersion: 4,
  id: 'prj_a',
  name: 'Project A',
  appStateMode: 'enabled',
  revision: 1,
  createdAt: '2026-08-31T00:00:00.000Z',
  updatedAt: '2026-08-31T00:00:00.000Z',
};
const projectB: Project = { ...projectA, id: 'prj_b', name: 'Project B' };
const endpoint: EndpointDetail = {
  schemaVersion: 4,
  id: 'ep_existing',
  projectId: projectA.id,
  name: 'Existing Endpoint',
  baseUrl: 'https://api.example.test',
  matcher: { method: 'GET', path: '/existing' },
  mode: 'mock',
  defaultVariantId: 'var_existing',
  variants: [{
    id: 'var_existing',
    endpointId: 'ep_existing',
    name: 'Fallback',
    status: 200,
    responseHeaders: {},
    revision: 1,
  }],
  revision: 1,
};
const endpointSummary: EndpointSummary = {
  schemaVersion: 4,
  id: endpoint.id,
  projectId: endpoint.projectId,
  name: endpoint.name,
  baseUrl: endpoint.baseUrl,
  mode: endpoint.mode,
  method: endpoint.matcher.method,
  path: endpoint.matcher.path,
  queryConstraintCount: 0,
  headerConstraintCount: 0,
  variantCount: endpoint.variants.length,
  mockReady: true,
  revision: endpoint.revision,
};
const state: AppState = {
  schemaVersion: 4,
  id: 'state_1',
  projectId: projectA.id,
  name: 'Default',
  tags: [],
  expectedUi: '',
  bindings: {},
  revision: 1,
};
const stateSummary: AppStateSummary = {
  id: state.id,
  projectId: state.projectId,
  name: state.name,
  tags: [],
  revision: 1,
  boundEndpointCount: 0,
  totalEndpointCount: 1,
  missingEndpointIds: [],
};
const commitResult: ImportCommitResult = {
  createdEndpointIds: ['ep_created'],
  updatedEndpointIds: [],
  createdVariantIds: ['var_created'],
  skippedItemIds: [],
};

const endpointReads = vi.hoisted(() => ({
  refresh: vi.fn(),
  selectEndpoint: vi.fn(),
}));
const stateReads = vi.hoisted(() => ({
  refresh: vi.fn(),
  reloadSelected: vi.fn(),
}));
let layoutProject = projectA;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function preview(): ImportPreview {
  return {
    snapshotToken: 'snapshot-1',
    sourceType: 'curl',
    items: [{
      id: 'create-item',
      memberIds: ['member-1'],
      locations: [{ type: 'curl', commandIndex: 0 }],
      breadcrumbs: [[]],
      name: 'Create imported Endpoint',
      baseUrl: 'https://api.example.test',
      matcher: { method: 'GET', path: '/imported' },
      requests: [{ query: [], headers: [] }],
      responses: [{
        name: 'OK',
        status: 200,
        responseHeaders: {},
        body: { kind: 'none' },
        identity: 'response-1',
      }],
      proposedAction: 'create',
      allowedActions: ['create', 'skip'],
      exactTargets: [],
      overlaps: [],
      warnings: [],
      errors: [],
      selectedByDefault: true,
      createEffect: { createsEndpoint: true, createsVariants: 1 },
    }],
    unresolvedMembers: [],
    unresolvedVariables: [],
    warnings: [],
    discoveredOrigins: ['https://api.example.test'],
    affectedStates: [],
    summary: { valid: 1, invalid: 0, create: 1, merge: 0, skip: 0 },
  };
}

vi.mock('./components/Layout', () => {
  interface MockLayoutProps {
    activeView: ViewType;
    onSelectView(view: ViewType): void;
    onAttemptNavigation(action: () => void): void;
    children(project: Project, refresh: () => Promise<void>): ReactNode;
  }

  function MockLayout({ activeView, onSelectView, onAttemptNavigation, children }: MockLayoutProps) {
    const [, rerenderProject] = useState(0);
    const showProject = (project: Project) => {
      layoutProject = project;
      rerenderProject(value => value + 1);
    };
    return (
      <div>
        <button role="tab" aria-selected={activeView === 'endpoints'} onClick={() => onSelectView('endpoints')}>Endpoints</button>
        <button role="tab" aria-selected={activeView === 'states'} onClick={() => onSelectView('states')}>App States</button>
        <button type="button" onClick={() => onAttemptNavigation(() => showProject(projectB))}>Switch Project</button>
        <button type="button" onClick={() => showProject(projectB)}>Force Project B</button>
        {children(layoutProject, async () => undefined)}
      </div>
    );
  }

  return { default: MockLayout };
});

vi.mock('./hooks/useEndpoints', async importOriginal => {
  const original = await importOriginal<typeof import('./hooks/useEndpoints')>();
  return {
    ...original,
    useEndpoints: (projectId?: string) => {
      const endpoints = original.useEndpoints(projectId);
      return {
        ...endpoints,
        selectEndpoint: (id: string | undefined) => {
          endpointReads.selectEndpoint(id);
          endpoints.selectEndpoint(id);
        },
        refresh: () => {
          endpointReads.refresh();
          return endpoints.refresh();
        },
      };
    },
  };
});

vi.mock('./hooks/useStates', async importOriginal => {
  const original = await importOriginal<typeof import('./hooks/useStates')>();
  return {
    ...original,
    useStates: (projectId?: string) => {
      const states = original.useStates(projectId);
      return {
        ...states,
        refresh: () => {
          stateReads.refresh();
          return states.refresh();
        },
        reloadSelected: () => {
          stateReads.reloadSelected();
          return states.reloadSelected();
        },
      };
    },
  };
});

vi.mock('./hooks/useRepositoryDiagnostics', () => ({
  useRepositoryDiagnostics: () => ({ diagnostics: [], loading: false, refresh: vi.fn() }),
}));
vi.mock('./hooks/useTraffic', () => ({
  useTraffic: () => ({
    traffic: [], selectedTraffic: null, detailLoading: false, loading: false, error: null,
    paused: false, setPaused: vi.fn(), selectTraffic: vi.fn(), refresh: vi.fn(), clear: vi.fn(),
  }),
}));

async function openReview(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Import' }));
  await user.type(screen.getByRole('textbox', { name: 'cURL commands' }), 'curl https://api.example.test/imported');
  await user.click(screen.getByRole('button', { name: 'Preview import' }));
  await screen.findByRole('heading', { name: 'Review import' });
}

async function selectCanonicalDetails(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('tab', { name: 'App States' }));
  const stateRow = (await screen.findAllByRole('button', { name: /Default/ }))
    .find(button => !button.hasAttribute('aria-label'));
  expect(stateRow).toBeDefined();
  await user.click(stateRow!);
  await waitFor(() => expect(statesApi.get).toHaveBeenCalled());
  await user.click(screen.getByRole('tab', { name: 'Endpoints' }));
  await user.click(await screen.findByRole('button', { name: /Existing Endpoint/ }));
  await screen.findByLabelText('Endpoint name');
  endpointReads.selectEndpoint.mockClear();
}

function attemptEveryAppNavigation() {
  fireEvent.click(screen.getByRole('tab', { name: 'App States' }));
  fireEvent.click(screen.getByRole('button', { name: 'New Endpoint' }));
  fireEvent.click(screen.getByRole('button', { name: /Existing Endpoint/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Switch Project' }));
  fireEvent.click(screen.getByRole('button', { name: 'Import' }));
  fireEvent.click(screen.getByRole('button', { name: 'Close import' }));
  const wizard = screen.getByRole('dialog', { name: 'Import API requests' });
  fireEvent.keyDown(wizard, { key: 'Escape' });
  fireEvent.click(document.querySelector('[data-modal-backdrop]')!);
}

function expectOwningWizard() {
  expect(screen.getByRole('dialog', { name: 'Import API requests' })).toBeVisible();
  expect(screen.queryByRole('dialog', { name: 'Unsaved changes' })).not.toBeInTheDocument();
  expect(screen.getByRole('tab', { name: 'Endpoints' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('heading', { name: /Project A \/ Endpoints/ })).toBeVisible();
}

describe('App real ImportWizard integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    layoutProject = projectA;
    vi.spyOn(endpointsApi, 'list').mockImplementation(async projectId => (
      projectId === projectA.id ? [endpointSummary] : []
    ));
    vi.spyOn(endpointsApi, 'get').mockResolvedValue(endpoint);
    vi.spyOn(statesApi, 'list').mockImplementation(async projectId => (
      projectId === projectA.id ? [stateSummary] : []
    ));
    vi.spyOn(statesApi, 'get').mockResolvedValue(state);
    vi.spyOn(importApi, 'preview').mockResolvedValue(preview());
  });

  it('locks App navigation through pending confirmed commit and canonical refresh', async () => {
    const user = userEvent.setup();
    const commit = deferred<ImportCommitResult>();
    const endpointRefresh = deferred<EndpointSummary[]>();
    const stateRefresh = deferred<AppStateSummary[]>();
    const selectedStateReload = deferred<AppState>();
    const selectedEndpointReload = deferred<EndpointDetail>();
    vi.spyOn(importApi, 'commit').mockReturnValue(commit.promise);
    render(<App />);
    await selectCanonicalDetails(user);
    await openReview(user);
    vi.mocked(endpointsApi.list).mockReturnValueOnce(endpointRefresh.promise);
    vi.mocked(statesApi.list).mockReturnValueOnce(stateRefresh.promise);
    vi.mocked(statesApi.get).mockReturnValueOnce(selectedStateReload.promise);
    vi.mocked(endpointsApi.get).mockReturnValueOnce(selectedEndpointReload.promise);

    await user.click(screen.getByRole('button', { name: 'Import selected' }));
    expect(screen.getByRole('button', { name: 'Importing...' })).toBeDisabled();
    attemptEveryAppNavigation();
    expectOwningWizard();

    await act(async () => commit.resolve(commitResult));
    expect(await screen.findByRole('heading', { name: 'Refreshing dashboard data' })).toBeVisible();
    const dirtyDuringRefresh = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(dirtyDuringRefresh);
    expect(dirtyDuringRefresh.defaultPrevented).toBe(true);
    attemptEveryAppNavigation();
    expectOwningWizard();

    await act(async () => endpointRefresh.resolve([endpointSummary]));
    await act(async () => stateRefresh.resolve([stateSummary]));
    await waitFor(() => expect(stateReads.reloadSelected).toHaveBeenCalledOnce());
    expect(screen.getByRole('heading', { name: 'Refreshing dashboard data' })).toBeVisible();
    await act(async () => selectedEndpointReload.resolve({
      ...endpoint,
      name: 'Existing Endpoint with imported Variant',
      revision: 2,
    }));
    await act(async () => selectedStateReload.resolve(state));

    expect(await screen.findByRole('heading', { name: 'Import complete' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Review interception checklist' })).toBeVisible();
    expect(screen.getByText('https://api.example.test')).toBeVisible();
    expect(importApi.commit).toHaveBeenCalledOnce();
    expect(endpointReads.selectEndpoint).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'View Endpoints' }));
    expect(screen.getByLabelText('Endpoint name')).toHaveValue('Existing Endpoint with imported Variant');
  });

  it('keeps selected Endpoint refresh failure in settlement and retries without another commit', async () => {
    const user = userEvent.setup();
    vi.spyOn(importApi, 'commit').mockResolvedValue(commitResult);
    render(<App />);
    await selectCanonicalDetails(user);
    await openReview(user);
    vi.mocked(endpointsApi.get).mockRejectedValueOnce(new Error('Selected Endpoint refresh failed'));

    await user.click(screen.getByRole('button', { name: 'Import selected' }));
    expect(await screen.findByRole('heading', { name: 'Dashboard refresh failed' })).toBeVisible();
    expect(importApi.commit).toHaveBeenCalledOnce();

    vi.mocked(endpointsApi.get).mockResolvedValueOnce({ ...endpoint, revision: 2 });
    await user.click(screen.getByRole('button', { name: 'Retry dashboard refresh' }));
    expect(await screen.findByRole('heading', { name: 'Import complete' })).toBeVisible();
    expect(importApi.commit).toHaveBeenCalledOnce();
    expect(endpointReads.selectEndpoint).not.toHaveBeenCalled();
  });

  it('keeps refresh failure guarded and retries canonical reads without another commit', async () => {
    const user = userEvent.setup();
    const retryEndpointRefresh = deferred<EndpointSummary[]>();
    const retryStateRefresh = deferred<AppStateSummary[]>();
    const retrySelectedStateReload = deferred<AppState>();
    vi.spyOn(importApi, 'commit').mockResolvedValue(commitResult);
    render(<App />);
    await selectCanonicalDetails(user);
    await openReview(user);
    vi.mocked(endpointsApi.list).mockRejectedValueOnce(new Error('Endpoint refresh failed'));

    await user.click(screen.getByRole('button', { name: 'Import selected' }));

    expect(await screen.findByRole('heading', { name: 'Dashboard refresh failed' })).toBeVisible();
    const dirtyAfterFailure = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(dirtyAfterFailure);
    expect(dirtyAfterFailure.defaultPrevented).toBe(true);
    expect(importApi.commit).toHaveBeenCalledOnce();

    vi.mocked(endpointsApi.list).mockReturnValueOnce(retryEndpointRefresh.promise);
    vi.mocked(statesApi.list).mockReturnValueOnce(retryStateRefresh.promise);
    vi.mocked(statesApi.get).mockReturnValueOnce(retrySelectedStateReload.promise);
    await user.click(screen.getByRole('button', { name: 'Retry dashboard refresh' }));

    expect(await screen.findByRole('heading', { name: 'Refreshing dashboard data' })).toBeVisible();
    attemptEveryAppNavigation();
    expectOwningWizard();
    await act(async () => retryEndpointRefresh.resolve([endpointSummary]));
    await act(async () => retryStateRefresh.resolve([stateSummary]));
    await waitFor(() => expect(stateReads.reloadSelected).toHaveBeenCalledTimes(2));
    await act(async () => retrySelectedStateReload.resolve(state));
    expect(await screen.findByRole('heading', { name: 'Import complete' })).toBeVisible();
    expect(endpointReads.refresh).toHaveBeenCalledTimes(2);
    expect(stateReads.refresh).toHaveBeenCalledTimes(2);
    expect(stateReads.reloadSelected).toHaveBeenCalledTimes(2);
    expect(importApi.commit).toHaveBeenCalledOnce();
  });

  it('releases retained refresh-failure ownership when the import is discarded', async () => {
    const user = userEvent.setup();
    vi.spyOn(importApi, 'commit').mockResolvedValue(commitResult);
    render(<App />);
    await openReview(user);
    vi.mocked(endpointsApi.list).mockRejectedValueOnce(new Error('Endpoint refresh failed'));
    await user.click(screen.getByRole('button', { name: 'Import selected' }));
    expect(await screen.findByRole('heading', { name: 'Dashboard refresh failed' })).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Close import' }));
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.queryByRole('dialog', { name: 'Import API requests' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Import' }));
    const source = screen.getByRole('textbox', { name: 'cURL commands' });
    await user.type(source, 'curl https://new.example.test');
    await user.clear(source);
    await waitFor(() => {
      const cleanAfterReopen = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(cleanAfterReopen);
      expect(cleanAfterReopen.defaultPrevented).toBe(false);
    });
  });

  it('keeps confirmed settlement owned when selected State detail refresh fails', async () => {
    const user = userEvent.setup();
    vi.spyOn(importApi, 'commit').mockResolvedValue(commitResult);
    render(<App />);
    await selectCanonicalDetails(user);
    await openReview(user);
    vi.mocked(statesApi.get).mockRejectedValueOnce(new Error('Selected State refresh failed'));

    await user.click(screen.getByRole('button', { name: 'Import selected' }));

    expect(await screen.findByRole('heading', { name: 'Dashboard refresh failed' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Import complete' })).not.toBeInTheDocument();
    const dirtyAfterFailure = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(dirtyAfterFailure);
    expect(dirtyAfterFailure.defaultPrevented).toBe(true);
  });

  it('locks unknown publication settlement and exposes unknown state only after canonical reads', async () => {
    const user = userEvent.setup();
    const commit = deferred<ImportCommitResult>();
    const endpointRefresh = deferred<EndpointSummary[]>();
    const stateRefresh = deferred<AppStateSummary[]>();
    const selectedStateReload = deferred<AppState>();
    vi.spyOn(importApi, 'commit').mockReturnValue(commit.promise);
    render(<App />);
    await selectCanonicalDetails(user);
    await openReview(user);
    vi.mocked(endpointsApi.list).mockReturnValueOnce(endpointRefresh.promise);
    vi.mocked(statesApi.list).mockReturnValueOnce(stateRefresh.promise);
    vi.mocked(statesApi.get).mockReturnValueOnce(selectedStateReload.promise);
    await user.click(screen.getByRole('button', { name: 'Import selected' }));

    await act(async () => commit.reject(new TypeError('response decode failed')));
    await waitFor(() => expect(endpointReads.refresh).toHaveBeenCalledOnce());
    expect(screen.queryByText(/outcome is unknown/i)).not.toBeInTheDocument();
    attemptEveryAppNavigation();
    expectOwningWizard();

    await act(async () => endpointRefresh.resolve([endpointSummary]));
    await act(async () => stateRefresh.resolve([stateSummary]));
    await waitFor(() => expect(stateReads.reloadSelected).toHaveBeenCalledOnce());
    expect(screen.queryByText(/outcome is unknown/i)).not.toBeInTheDocument();
    await act(async () => selectedStateReload.resolve(state));

    expect(await screen.findByText(/outcome is unknown/i)).toHaveAttribute('role', 'alert');
    expect(screen.queryByRole('heading', { name: 'Import complete' })).not.toBeInTheDocument();
    expect(importApi.commit).toHaveBeenCalledOnce();
    expect(endpointReads.selectEndpoint).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Endpoint name')).toHaveValue('Existing Endpoint');
  });

  it('reports unknown outcome plus canonical refresh failure from the real hooks', async () => {
    const user = userEvent.setup();
    vi.spyOn(importApi, 'commit').mockRejectedValue(new TypeError('response decode failed'));
    render(<App />);
    await openReview(user);
    vi.mocked(statesApi.list).mockRejectedValueOnce(new Error('State refresh failed'));

    await user.click(screen.getByRole('button', { name: 'Import selected' }));

    expect(await screen.findByText(
      'The import outcome is unknown, and the dashboard could not refresh canonical data. Check Endpoints before trying again.',
    )).toHaveAttribute('role', 'alert');
    expect(screen.queryByRole('heading', { name: 'Import complete' })).not.toBeInTheDocument();
    const dirtyAfterFailure = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(dirtyAfterFailure);
    expect(dirtyAfterFailure.defaultPrevented).toBe(true);
  });

  it('discards only Project A before switching and retains a new Project B draft', async () => {
    const user = userEvent.setup();
    vi.spyOn(importApi, 'commit').mockResolvedValue(commitResult);
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Import' }));
    await user.type(screen.getByRole('textbox', { name: 'cURL commands' }), 'curl https://a.example.test');

    fireEvent.click(screen.getByRole('button', { name: 'Switch Project' }));
    const confirm = screen.getByRole('dialog', { name: 'Unsaved changes' });
    await user.click(within(confirm).getByRole('button', { name: 'Discard' }));

    expect(await screen.findByRole('heading', { name: /Project B \/ Endpoints/ })).toBeVisible();
    expect(screen.queryByRole('dialog', { name: 'Import API requests' })).not.toBeInTheDocument();
    const cleanAfterA = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(cleanAfterA);
    expect(cleanAfterA.defaultPrevented).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Import' }));
    await user.type(screen.getByRole('textbox', { name: 'cURL commands' }), 'curl https://b.example.test');
    const dirtyB = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(dirtyB);
    expect(dirtyB.defaultPrevented).toBe(true);
  });

  it('does not let stale Project A settlement clear or control Project B ownership', async () => {
    const user = userEvent.setup();
    const endpointRefreshA = deferred<EndpointSummary[]>();
    const stateRefreshA = deferred<AppStateSummary[]>();
    vi.spyOn(importApi, 'commit').mockResolvedValue(commitResult);
    render(<App />);
    await openReview(user);
    vi.mocked(endpointsApi.list).mockReturnValueOnce(endpointRefreshA.promise);
    vi.mocked(statesApi.list).mockReturnValueOnce(stateRefreshA.promise);
    await user.click(screen.getByRole('button', { name: 'Import selected' }));
    expect(await screen.findByRole('heading', { name: 'Refreshing dashboard data' })).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Force Project B' }));
    expect(await screen.findByRole('heading', { name: /Project B \/ Endpoints/ })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Import' }));
    await user.type(screen.getByRole('textbox', { name: 'cURL commands' }), 'curl https://b.example.test');

    await act(async () => endpointRefreshA.resolve([endpointSummary]));
    await act(async () => stateRefreshA.resolve([stateSummary]));
    await waitFor(() => expect(stateReads.reloadSelected).toHaveBeenCalledOnce());

    expect(screen.getByRole('textbox', { name: 'cURL commands' })).toHaveValue('curl https://b.example.test');
    expect(screen.queryByRole('heading', { name: 'Import complete' })).not.toBeInTheDocument();
    const dirtyB = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(dirtyB);
    expect(dirtyB.defaultPrevented).toBe(true);
  });
});
