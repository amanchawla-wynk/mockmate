import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { endpointsApi, projectsApi, statesApi, variantsApi } from './api/client';
import type { AppState, EndpointDetail, EndpointSummary, Project, ProjectRuntimeSettings } from './api/types';
import type { ImportWizardProps } from './components/import/ImportWizard';
import type { ViewType } from './components/ProjectList';

const project: Project = {
  schemaVersion: 4,
  id: 'prj_1',
  name: 'Streaming UI',
  appStateMode: 'enabled',
  revision: 7,
  createdAt: '2026-08-28T00:00:00.000Z',
  updatedAt: '2026-08-28T00:00:00.000Z',
};
const secondProject: Project = {
  ...project,
  id: 'prj_2',
  name: 'Second Project',
};
const endpoint: EndpointDetail = {
  schemaVersion: 4,
  id: 'ep_playback',
  projectId: project.id,
  name: 'Playback authorization',
  baseUrl: 'https://api.example.test',
  matcher: { method: 'GET', path: '/playback' },
  mode: 'mock',
  defaultVariantId: 'var_0',
  variants: Array.from({ length: 5 }, (_, index) => ({
    id: `var_${index}`,
    endpointId: 'ep_playback',
    name: `Variant ${index}`,
    status: 200,
    responseHeaders: {},
    revision: 0,
  })),
  revision: 4,
};
const summary: EndpointSummary = {
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
const endpointSummaries = [summary];
const appState: AppState = {
  schemaVersion: 4,
  id: 'state_1',
  projectId: project.id,
  name: 'Signed in',
  tags: [],
  expectedUi: '',
  bindings: { ep_playback: 'var_0' },
  revision: 3,
};
const secondAppState: AppState = {
  ...appState,
  id: 'state_2',
  projectId: secondProject.id,
  name: 'Second state',
};
const secondEndpoint: EndpointDetail = {
  ...endpoint,
  id: 'ep_second',
  projectId: secondProject.id,
  name: 'Second endpoint',
  defaultVariantId: 'var_second',
  variants: [{
    ...endpoint.variants[0],
    id: 'var_second',
    endpointId: 'ep_second',
  }],
};
const secondSummary: EndpointSummary = {
  ...summary,
  id: secondEndpoint.id,
  projectId: secondEndpoint.projectId,
  name: secondEndpoint.name,
  variantCount: secondEndpoint.variants.length,
};

let layoutProject = project;
const appStateEditorRenders = vi.hoisted(() => [] as Array<{
  projectId: string;
  endpointProjectIds: string[];
}>);
const stateHookSpies = vi.hoisted(() => ({
  selectState: vi.fn(),
  beginStatePublication: vi.fn(),
  publishState: vi.fn(),
  refresh: vi.fn(async () => true),
  reloadSelected: vi.fn(async () => true),
}));
const stateHookOverride = vi.hoisted(() => ({
  current: undefined as undefined | ((projectId?: string) => Record<string, unknown>),
}));
const endpointHookSpies = vi.hoisted(() => ({
  refresh: vi.fn(),
  reloadSelected: vi.fn(),
  selectEndpoint: vi.fn(),
}));
const endpointRefreshOverride = vi.hoisted(() => ({
  current: undefined as undefined | (() => Promise<boolean>),
}));
const importWizardHarness = vi.hoisted(() => ({
  props: undefined as ImportWizardProps | undefined,
  reset: vi.fn(),
}));
const refreshProjects = vi.hoisted(() => vi.fn(async () => undefined));
const trafficHookCalls = vi.hoisted(() => vi.fn());

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(next => { resolve = next; });
  return { promise, resolve };
}

vi.mock('./api/client', () => ({
  endpointsApi: {
    list: vi.fn(), get: vi.fn(), create: vi.fn(), update: vi.fn(),
    delete: vi.fn(), deletionImpact: vi.fn(),
  },
  interceptionGuidanceApi: { get: vi.fn() },
  projectsApi: { getRuntimeSettings: vi.fn(), update: vi.fn(), updateRuntimeSettings: vi.fn() },
  variantsApi: {
    create: vi.fn(), delete: vi.fn(), deletionImpact: vi.fn(), update: vi.fn(),
  },
  bodiesApi: { download: vi.fn(), upload: vi.fn() },
  statesApi: { create: vi.fn(), delete: vi.fn(), setSelection: vi.fn(), update: vi.fn() },
  trafficApi: { list: vi.fn(), detail: vi.fn(), clear: vi.fn(), promote: vi.fn() },
}));

vi.mock('./components/Layout', async () => {
  interface MockLayoutProps {
    activeView: ViewType;
    onSelectView(view: ViewType): void;
    onAttemptNavigation(action: () => void): void;
    children(project: Project, refresh: () => Promise<void>): ReactNode;
  }

  function MockLayout({ activeView, onSelectView, onAttemptNavigation, children }: MockLayoutProps) {
    const [, renderProject] = useState(0);
    return (
      <div>
        <button role="tab" aria-selected={activeView === 'endpoints'} onClick={() => onSelectView('endpoints')}>Endpoints</button>
        <button role="tab" aria-selected={activeView === 'states'} onClick={() => onSelectView('states')}>App States</button>
        <button role="tab" aria-selected={activeView === 'traffic'} onClick={() => onSelectView('traffic')}>Traffic</button>
        <button role="tab" aria-selected={activeView === 'intercept'} onClick={() => onSelectView('intercept')}>Proxy Intercept</button>
        <button type="button" onClick={() => onAttemptNavigation(() => {
          layoutProject = secondProject;
          renderProject(value => value + 1);
        })}>Switch Project</button>
        {children(layoutProject, refreshProjects)}
      </div>
    );
  }

  return {
    default: MockLayout,
  };
});

vi.mock('./components/import/ImportWizard', () => ({
  ImportWizard: (props: ImportWizardProps) => {
    const [complete, setComplete] = useState(false);
    importWizardHarness.props = props;
    if (!props.isOpen) return null;
    return (
      <div role="dialog" aria-label="Import API requests" data-project-id={props.projectId}>
        {complete ? <button type="button" onClick={props.onViewEndpoints}>View Endpoints</button> : (
          <>
            <button type="button" onClick={() => props.onDirtyChange(true, importWizardHarness.reset)}>Make import dirty</button>
            <button type="button" onClick={() => setComplete(true)}>Simulate complete</button>
          </>
        )}
        <button type="button" onClick={props.onRequestClose}>Close import</button>
      </div>
    );
  },
}));

vi.mock('./hooks/useEndpoints', async importOriginal => {
  const original = await importOriginal<typeof import('./hooks/useEndpoints')>();
  return {
    ...original,
    useEndpoints: (projectId?: string) => {
      const endpoints = original.useEndpoints(projectId);
      return {
        ...endpoints,
        selectEndpoint: (id: string | undefined) => {
          endpointHookSpies.selectEndpoint(id);
          endpoints.selectEndpoint(id);
        },
        refresh: () => {
          endpointHookSpies.refresh();
          return endpointRefreshOverride.current?.() ?? endpoints.refresh();
        },
        reloadSelected: () => {
          endpointHookSpies.reloadSelected();
          return endpoints.reloadSelected();
        },
      };
    },
  };
});

vi.mock('./hooks/useRepositoryDiagnostics', () => ({
  useRepositoryDiagnostics: () => ({ diagnostics: [], loading: false, refresh: vi.fn() }),
}));
vi.mock('./hooks/useStates', () => ({
  useStates: (projectId?: string) => {
    if (stateHookOverride.current) return stateHookOverride.current(projectId);
    const state = projectId === secondProject.id ? secondAppState : appState;
    return ({
    states: [{
      id: state.id, projectId: state.projectId, name: state.name, tags: [], revision: 3,
      boundEndpointCount: 1, totalEndpointCount: 1,
    }],
    selectedState: state, selectedStateId: state.id,
    loading: false, detailLoading: false,
    selectState: stateHookSpies.selectState,
    beginStatePublication: stateHookSpies.beginStatePublication,
    publishState: stateHookSpies.publishState,
    refresh: stateHookSpies.refresh,
    reloadSelected: stateHookSpies.reloadSelected,
    });
  },
}));
vi.mock('./hooks/useTraffic', () => ({
  useTraffic: (projectId: string | undefined, options: unknown) => {
    trafficHookCalls(projectId, options);
    return {
      entries: [], selected: null, detailLoading: false, loading: false, clearing: false, error: null,
      paused: false, setPaused: vi.fn(), select: vi.fn(), refresh: vi.fn(), refreshSelected: vi.fn(), clear: vi.fn(),
    };
  },
}));

vi.mock('./components/AppStateEditor', async importOriginal => {
  const original = await importOriginal<typeof import('./components/AppStateEditor')>();
  return {
    ...original,
    AppStateEditor: (props: Parameters<typeof original.AppStateEditor>[0]) => {
      appStateEditorRenders.push({
        projectId: props.state.projectId,
        endpointProjectIds: props.endpoints.map(endpoint => endpoint.projectId),
      });
      return <original.AppStateEditor {...props} />;
    },
  };
});

describe('canonical App shell', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    layoutProject = project;
    stateHookOverride.current = undefined;
    endpointRefreshOverride.current = undefined;
    importWizardHarness.props = undefined;
    appStateEditorRenders.length = 0;
    trafficHookCalls.mockClear();
    vi.mocked(endpointsApi.list).mockImplementation(async projectId => (
      projectId === secondProject.id ? [secondSummary] : endpointSummaries
    ));
    vi.mocked(endpointsApi.get).mockImplementation(async (_projectId, endpointId) => (
      endpointId === secondEndpoint.id ? secondEndpoint : endpoint
    ));
    vi.mocked(projectsApi.getRuntimeSettings).mockImplementation(async projectId => ({
      schemaVersion: 4,
      projectId,
      interceptHosts: [],
      captureRawTraffic: false,
      debugProvenanceHeaders: false,
      revision: 1,
    }));
    vi.mocked(endpointsApi.update).mockImplementation(async (_projectId, _endpointId, _revision, patch) => ({
      ...endpoint,
      ...patch,
      description: patch.description ?? undefined,
      revision: endpoint.revision + 1,
    }));
    vi.mocked(variantsApi.update).mockImplementation(async (_projectId, _endpointId, variantId, _revision, patch) => {
      const original = endpoint.variants.find(variant => variant.id === variantId)!;
      return {
        ...original,
        name: patch.name ?? original.name,
        description: patch.description === null ? undefined : patch.description ?? original.description,
        status: patch.status ?? original.status,
        responseHeaders: patch.responseHeaders ?? original.responseHeaders,
        bodyAssetId: patch.bodyAssetId === null ? undefined : patch.bodyAssetId ?? original.bodyAssetId,
        delayMs: patch.delayMs === null ? undefined : patch.delayMs ?? original.delayMs,
        revision: original.revision + 1,
      };
    });
    vi.mocked(statesApi.create).mockResolvedValue({ ...appState, id: 'state_new', name: 'New App State' });
    vi.mocked(statesApi.delete).mockResolvedValue(undefined);
    stateHookSpies.refresh.mockResolvedValue(true);
    stateHookSpies.reloadSelected.mockResolvedValue(true);
    stateHookSpies.beginStatePublication.mockReturnValue({
      projectId: project.id,
      selectedStateId: appState.id,
      projectGeneration: 0,
      detailGeneration: 0,
    });
    stateHookSpies.publishState.mockReturnValue(true);
    refreshProjects.mockResolvedValue(undefined);
  });

  it('contains no legacy Logs hook, view, route, or create-mock references', () => {
    const sources = [
      'App.tsx',
      'components/ProjectList.tsx',
      'components/TrafficView.tsx',
      'api/client.ts',
    ].map(file => readFileSync(resolve(process.cwd(), 'src', file), 'utf8')).join('\n');

    expect(sources).not.toMatch(/useLogs|LogsView|\/logs|createMockFromLog|create-mock/);
  });

  it('enables Traffic polling only while the Traffic workspace is active', async () => {
    const user = userEvent.setup();
    render(<App />);
    expect(trafficHookCalls).toHaveBeenLastCalledWith('prj_1', {
      enabled: false,
      pollIntervalMs: 1000,
    });

    await user.click(screen.getByRole('tab', { name: 'Traffic' }));
    expect(trafficHookCalls).toHaveBeenLastCalledWith('prj_1', {
      enabled: true,
      pollIntervalMs: 1000,
    });
    await user.click(screen.getByRole('tab', { name: 'Endpoints' }));
    expect(trafficHookCalls).toHaveBeenLastCalledWith('prj_1', {
      enabled: false,
      pollIntervalMs: 1000,
    });
  });

  it('lists Endpoint summaries without loading body content', async () => {
    render(<App />);
    expect(await screen.findByText('Playback authorization')).toBeVisible();
    expect(screen.getByText('5 variants')).toBeVisible();
    expect(endpointsApi.get).not.toHaveBeenCalled();
  });

  it('opens Import only from Endpoints for the active Project and respects an existing draft', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByText('Playback authorization'));
    await user.type(screen.getByLabelText('Endpoint description'), 'Local endpoint draft');

    await user.click(screen.getByRole('button', { name: 'Import' }));
    expect(screen.getByRole('dialog', { name: 'Unsaved changes' })).toBeVisible();
    expect(screen.queryByRole('dialog', { name: 'Import API requests' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.getByRole('dialog', { name: 'Import API requests' })).toHaveAttribute('data-project-id', project.id);
    await user.click(screen.getByRole('button', { name: 'Close import' }));
    await user.click(screen.getByRole('tab', { name: 'App States' }));
    expect(screen.queryByRole('button', { name: 'Import' })).not.toBeInTheDocument();
  });

  it('guards dirty Import close, view navigation, Endpoint actions, and Project switching', async () => {
    const user = userEvent.setup();
    render(<App />);
    importWizardHarness.reset.mockImplementation(() => {
      expect(screen.getByRole('dialog', { name: 'Import API requests' })).toBeVisible();
    });
    await user.click(await screen.findByRole('button', { name: 'Import' }));
    await user.click(screen.getByRole('button', { name: 'Make import dirty' }));

    const dirtyUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(dirtyUnload);
    expect(dirtyUnload.defaultPrevented).toBe(true);

    for (const action of [
      screen.getByRole('tab', { name: 'App States' }),
      screen.getByRole('button', { name: 'New Endpoint' }),
      screen.getByText('Playback authorization'),
      screen.getByRole('button', { name: 'Switch Project' }),
    ]) {
      await user.click(action);
      expect(screen.getByRole('dialog', { name: 'Unsaved changes' })).toBeVisible();
      await user.click(screen.getByRole('button', { name: 'Stay' }));
      expect(screen.getByRole('dialog', { name: 'Import API requests' })).toBeVisible();
    }

    await user.click(screen.getByRole('button', { name: 'Close import' }));
    expect(screen.getByRole('dialog', { name: 'Unsaved changes' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Discard' }));

    expect(importWizardHarness.reset).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog', { name: 'Import API requests' })).not.toBeInTheDocument();
    const cleanUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(cleanUnload);
    expect(cleanUnload.defaultPrevented).toBe(false);
  });

  it('discards exactly the Project A import before an accepted Project B switch', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Import' }));
    await user.click(screen.getByRole('button', { name: 'Make import dirty' }));

    await user.click(screen.getByRole('button', { name: 'Switch Project' }));
    expect(screen.getByRole('dialog', { name: 'Unsaved changes' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Discard' }));

    expect(importWizardHarness.reset).toHaveBeenCalledOnce();
    expect(await screen.findByRole('heading', { name: /Second Project \/ Endpoints/ })).toBeVisible();
    expect(screen.queryByRole('dialog', { name: 'Import API requests' })).not.toBeInTheDocument();
    const cleanUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(cleanUnload);
    expect(cleanUnload.defaultPrevented).toBe(false);
  });

  it('does not execute an already-confirmed discard while import settlement is pending', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Import' }));
    await user.click(screen.getByRole('button', { name: 'Make import dirty' }));
    await user.click(screen.getByRole('button', { name: 'Switch Project' }));
    expect(screen.getByRole('dialog', { name: 'Unsaved changes' })).toBeVisible();

    act(() => importWizardHarness.props!.onSettlementChange(true));
    await user.click(screen.getByRole('button', { name: 'Discard' }));

    expect(importWizardHarness.reset).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: /Streaming UI \/ Endpoints/ })).toBeVisible();
    expect(screen.getByRole('dialog', { name: 'Import API requests' })).toBeVisible();
    expect(screen.getByRole('dialog', { name: 'Unsaved changes' })).toBeVisible();

    act(() => importWizardHarness.props!.onSettlementChange(false));
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(importWizardHarness.reset).toHaveBeenCalledOnce();
    expect(await screen.findByRole('heading', { name: /Second Project \/ Endpoints/ })).toBeVisible();
  });

  it('refreshes canonical Endpoint and State reads in order after confirmed import success', async () => {
    const user = userEvent.setup();
    const endpointRefresh = deferred<boolean>();
    const stateRefresh = deferred<boolean>();
    endpointRefreshOverride.current = () => endpointRefresh.promise;
    stateHookSpies.refresh.mockImplementationOnce(() => stateRefresh.promise);
    render(<App />);
    await user.click(await screen.findByText('Playback authorization'));
    await screen.findByLabelText('Endpoint name');
    endpointHookSpies.selectEndpoint.mockClear();
    endpointHookSpies.refresh.mockClear();
    await user.click(screen.getByRole('button', { name: 'Import' }));
    await user.click(screen.getByRole('button', { name: 'Make import dirty' }));

    let committed!: Promise<void>;
    act(() => {
      committed = importWizardHarness.props!.onCommitted({
        createdEndpointIds: ['ep_created'],
        updatedEndpointIds: [],
        createdVariantIds: ['var_created'],
        skippedItemIds: [],
      });
    });

    expect(endpointHookSpies.refresh).toHaveBeenCalledOnce();
    expect(stateHookSpies.refresh).toHaveBeenCalledOnce();
    expect(stateHookSpies.reloadSelected).not.toHaveBeenCalled();
    expect(endpointHookSpies.reloadSelected).not.toHaveBeenCalled();
    const cleanUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(cleanUnload);
    expect(cleanUnload.defaultPrevented).toBe(true);
    await act(async () => endpointRefresh.resolve(true));
    expect(stateHookSpies.reloadSelected).not.toHaveBeenCalled();
    await act(async () => stateRefresh.resolve(true));
    await act(async () => committed);
    expect(endpointHookSpies.reloadSelected).toHaveBeenCalledOnce();
    expect(stateHookSpies.reloadSelected).toHaveBeenCalledOnce();
    const cleanAfterRefresh = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(cleanAfterRefresh);
    expect(cleanAfterRefresh.defaultPrevented).toBe(false);
    expect(endpointHookSpies.selectEndpoint).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Endpoint name')).toBeVisible();
    expect(refreshProjects).not.toHaveBeenCalled();
  });

  it('uses the same canonical refresh sequence for an unknown import outcome', async () => {
    const user = userEvent.setup();
    const endpointRefresh = deferred<boolean>();
    const stateRefresh = deferred<boolean>();
    endpointRefreshOverride.current = () => endpointRefresh.promise;
    stateHookSpies.refresh.mockImplementationOnce(() => stateRefresh.promise);
    render(<App />);
    await user.click(await screen.findByText('Playback authorization'));
    await screen.findByLabelText('Endpoint name');
    endpointHookSpies.selectEndpoint.mockClear();
    endpointHookSpies.refresh.mockClear();
    await user.click(screen.getByRole('button', { name: 'Import' }));
    await user.click(screen.getByRole('button', { name: 'Make import dirty' }));

    const refreshed = importWizardHarness.props!.onCommitOutcomeUnknown();

    expect(endpointHookSpies.refresh).toHaveBeenCalledOnce();
    expect(stateHookSpies.refresh).toHaveBeenCalledOnce();
    expect(stateHookSpies.reloadSelected).not.toHaveBeenCalled();
    expect(endpointHookSpies.reloadSelected).not.toHaveBeenCalled();
    await act(async () => stateRefresh.resolve(true));
    expect(stateHookSpies.reloadSelected).not.toHaveBeenCalled();
    await act(async () => endpointRefresh.resolve(true));
    await act(async () => refreshed);
    expect(endpointHookSpies.reloadSelected).toHaveBeenCalledOnce();
    expect(stateHookSpies.reloadSelected).toHaveBeenCalledOnce();
    expect(endpointHookSpies.selectEndpoint).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Endpoint name')).toBeVisible();
    expect(refreshProjects).not.toHaveBeenCalled();
    const dirtyUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(dirtyUnload);
    expect(dirtyUnload.defaultPrevented).toBe(true);
  });

  it('closes completed Import through View Endpoints without leaving Endpoints', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Import' }));
    await user.click(screen.getByRole('button', { name: 'Simulate complete' }));

    await user.click(screen.getByRole('button', { name: 'View Endpoints' }));

    expect(screen.queryByRole('dialog', { name: 'Import API requests' })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Endpoints' })).toHaveAttribute('aria-selected', 'true');

    await user.click(screen.getByRole('button', { name: 'Import' }));
    expect(screen.getByRole('button', { name: 'Make import dirty' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'View Endpoints' })).not.toBeInTheDocument();
  });

  it('never renders App State bindings with Endpoint details from another Project', async () => {
    const user = userEvent.setup();
    const pendingSecondEndpoint = deferred<EndpointDetail>();
    const { rerender } = render(<App />);
    await user.click(screen.getByRole('tab', { name: 'App States' }));
    expect(await screen.findByLabelText('Playback authorization variant')).toBeVisible();

    vi.mocked(endpointsApi.get).mockImplementation(async (_projectId, endpointId) => (
      endpointId === secondEndpoint.id ? pendingSecondEndpoint.promise : endpoint
    ));
    appStateEditorRenders.length = 0;
    layoutProject = secondProject;
    rerender(<App />);

    await waitFor(() => expect(endpointsApi.list).toHaveBeenCalledWith(secondProject.id, expect.any(AbortSignal)));
    expect(appStateEditorRenders).not.toContainEqual({
      projectId: secondProject.id,
      endpointProjectIds: [project.id],
    });
  });

  it('hides the previous Project runtime settings while the next Project loads', async () => {
    const user = userEvent.setup();
    const pendingSettings = deferred<ProjectRuntimeSettings>();
    const { rerender } = render(<App />);
    await user.click(screen.getByRole('tab', { name: 'Proxy Intercept' }));
    expect(await screen.findByLabelText('Intercept host patterns')).toBeVisible();
    expect(screen.queryByLabelText('Capture raw traffic')).not.toBeInTheDocument();
    expect(screen.getByText(/Exact Traffic bodies are always retained/)).toBeVisible();

    vi.mocked(projectsApi.getRuntimeSettings).mockImplementation(async projectId => (
      projectId === secondProject.id ? pendingSettings.promise : {
        schemaVersion: 4,
        projectId,
        interceptHosts: [],
        captureRawTraffic: true,
        debugProvenanceHeaders: false,
        revision: 1,
      }
    ));
    await act(async () => {
      layoutProject = secondProject;
      rerender(<App />);
    });

    expect(screen.getByText('Loading runtime settings...')).toBeVisible();
  });

  it('guards dirty App State navigation with Stay', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('tab', { name: 'App States' }));
    const expectedUi = await screen.findByLabelText('Expected UI');
    await user.type(expectedUi, 'Error banner');
    await user.click(screen.getByRole('tab', { name: 'Traffic' }));
    expect(screen.getByRole('dialog', { name: 'Unsaved changes' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Stay' }));
    expect(screen.getByRole('tab', { name: 'App States' })).toHaveAttribute('aria-selected', 'true');
  });

  it('guards New App State with Discard and does not silently replace the dirty entity', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('tab', { name: 'App States' }));
    await user.type(await screen.findByLabelText('Expected UI'), 'Local draft');
    await user.click(screen.getByRole('button', { name: 'New' }));

    expect(statesApi.create).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Unsaved changes' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(statesApi.create).toHaveBeenCalledWith('prj_1', {
      name: 'New App State', tags: [], bindings: {},
    });
  });

  it('keeps an Endpoint draft owned and guarded after saving its sibling Variant', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByText('Playback authorization'));
    await user.type(screen.getByLabelText('Endpoint description'), 'Local endpoint draft');
    await user.clear(screen.getByLabelText('Variant name'));
    await user.type(screen.getByLabelText('Variant name'), 'Saved variant');
    await user.click(screen.getByRole('button', { name: 'Save Variant' }));

    expect(await screen.findByLabelText('Endpoint description')).toHaveValue('Local endpoint draft');
    expect(screen.getByLabelText('Variant name')).toHaveValue('Saved variant');
    const dirtyUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(dirtyUnload);
    expect(dirtyUnload.defaultPrevented).toBe(true);

    await user.click(screen.getByRole('tab', { name: 'App States' }));
    await user.click(screen.getByRole('button', { name: 'Stay' }));
    expect(screen.getByLabelText('Endpoint description')).toHaveValue('Local endpoint draft');
    await user.click(screen.getByRole('tab', { name: 'App States' }));
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    const cleanUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(cleanUnload);
    expect(cleanUnload.defaultPrevented).toBe(false);
  });

  it('keeps a Variant draft owned and guarded after saving its sibling Endpoint', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByText('Playback authorization'));
    await user.clear(screen.getByLabelText('Variant name'));
    await user.type(screen.getByLabelText('Variant name'), 'Local variant draft');
    await user.type(screen.getByLabelText('Endpoint description'), 'Saved endpoint');
    await user.click(screen.getByRole('button', { name: 'Save Endpoint' }));

    expect(await screen.findByLabelText('Endpoint description')).toHaveValue('Saved endpoint');
    expect(screen.getByLabelText('Variant name')).toHaveValue('Local variant draft');
    const dirtyUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(dirtyUnload);
    expect(dirtyUnload.defaultPrevented).toBe(true);

    await user.click(screen.getByRole('tab', { name: 'App States' }));
    await user.click(screen.getByRole('button', { name: 'Stay' }));
    expect(screen.getByLabelText('Variant name')).toHaveValue('Local variant draft');
    await user.click(screen.getByRole('tab', { name: 'App States' }));
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    const cleanUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(cleanUnload);
    expect(cleanUnload.defaultPrevented).toBe(false);
  });

  it('keeps the authoritative saved Endpoint across guarded remount and a second save', async () => {
    const user = userEvent.setup();
    let authoritative = endpoint;
    vi.mocked(endpointsApi.list).mockImplementation(async () => [{
      ...summary,
      name: authoritative.name,
      matcher: authoritative.matcher,
      revision: authoritative.revision,
    }]);
    vi.mocked(endpointsApi.get).mockImplementation(async () => authoritative);
    vi.mocked(endpointsApi.update).mockImplementation(async (_projectId, _endpointId, expectedRevision, patch) => {
      if (expectedRevision !== authoritative.revision) {
        throw new Error(`stale revision ${expectedRevision}`);
      }
      authoritative = {
        ...authoritative,
        name: patch.name ?? authoritative.name,
        description: patch.description === null ? undefined : patch.description ?? authoritative.description,
        baseUrl: patch.baseUrl ?? authoritative.baseUrl,
        matcher: patch.matcher ?? authoritative.matcher,
        revision: authoritative.revision + 1,
      };
      return authoritative;
    });
    render(<App />);
    await user.click(await screen.findByText('Playback authorization'));
    await screen.findByLabelText('Endpoint name');
    await user.clear(screen.getByLabelText('Endpoint name'));
    await user.type(screen.getByLabelText('Endpoint name'), '  Saved Endpoint  ');
    await user.type(screen.getByLabelText('Endpoint description'), '  Saved description  ');
    await user.clear(screen.getByLabelText('Endpoint base URL'));
    await user.type(screen.getByLabelText('Endpoint base URL'), '  https://api.example.test  ');
    await user.click(screen.getByRole('button', { name: 'Save Endpoint' }));

    expect(await screen.findByLabelText('Endpoint name')).toHaveValue('Saved Endpoint');
    expect(screen.getByLabelText('Endpoint description')).toHaveValue('Saved description');
    expect(screen.getByLabelText('Endpoint base URL')).toHaveValue('https://api.example.test');
    const cleanAfterSave = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(cleanAfterSave);
    expect(cleanAfterSave.defaultPrevented).toBe(false);

    await user.clear(screen.getByLabelText('Variant name'));
    await user.type(screen.getByLabelText('Variant name'), 'Discarded sibling draft');
    await user.click(screen.getByRole('tab', { name: 'App States' }));
    expect(screen.getByRole('dialog', { name: 'Unsaved changes' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    await user.click(screen.getByRole('tab', { name: 'Endpoints' }));

    expect(await screen.findByLabelText('Endpoint name')).toHaveValue('Saved Endpoint');
    expect(screen.getByLabelText('Endpoint description')).toHaveValue('Saved description');
    await user.type(screen.getByLabelText('Endpoint description'), ' again');
    await user.click(screen.getByRole('button', { name: 'Save Endpoint' }));
    await waitFor(() => expect(endpointsApi.update).toHaveBeenCalledTimes(2));
    expect(vi.mocked(endpointsApi.update).mock.calls[1]?.[2]).toBe(5);
    expect(screen.queryByText(/stale revision/)).not.toBeInTheDocument();
  });

  it('does not publish a deferred Endpoint save after navigating to New Endpoint', async () => {
    const user = userEvent.setup();
    const pendingSave = deferred<EndpointDetail>();
    vi.mocked(endpointsApi.update).mockReturnValueOnce(pendingSave.promise);
    render(<App />);
    await user.click(await screen.findByText('Playback authorization'));
    await user.type(screen.getByLabelText('Endpoint description'), ' pending');
    await user.click(screen.getByRole('button', { name: 'Save Endpoint' }));
    await waitFor(() => expect(endpointsApi.update).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole('button', { name: 'New Endpoint' }));
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(await screen.findByRole('button', { name: 'Create Endpoint' })).toBeVisible();

    pendingSave.resolve({ ...endpoint, description: 'pending', revision: 5 });

    await waitFor(() => expect(endpointsApi.list).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('button', { name: 'Create Endpoint' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Save Endpoint' })).not.toBeInTheDocument();
  });

  it('keeps a reopened same-revision Endpoint draft dirty after an old save completes', async () => {
    const user = userEvent.setup();
    const oldSave = deferred<EndpointDetail>();
    vi.mocked(endpointsApi.update).mockReturnValueOnce(oldSave.promise);
    render(<App />);
    await user.click(await screen.findByText('Playback authorization'));
    await user.type(screen.getByLabelText('Endpoint description'), ' old save');
    await user.click(screen.getByRole('button', { name: 'Save Endpoint' }));
    await waitFor(() => expect(endpointsApi.update).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole('button', { name: 'New Endpoint' }));
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    await user.click(screen.getByText('Playback authorization'));
    await waitFor(() => expect(screen.getByLabelText('Endpoint description')).toHaveValue(''));
    await user.type(screen.getByLabelText('Endpoint description'), 'current draft');
    const dirtyBefore = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(dirtyBefore);
    expect(dirtyBefore.defaultPrevented).toBe(true);

    await act(async () => {
      oldSave.resolve({ ...endpoint, description: 'old save', revision: 5 });
    });
    await waitFor(() => expect(endpointsApi.list).toHaveBeenCalledTimes(2));

    expect(screen.getByLabelText('Endpoint description')).toHaveValue('current draft');
    const dirtyAfter = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(dirtyAfter);
    expect(dirtyAfter.defaultPrevented).toBe(true);
    await user.click(screen.getByRole('tab', { name: 'App States' }));
    expect(screen.getByRole('dialog', { name: 'Unsaved changes' })).toBeVisible();
  });

  it('does not publish a structural Endpoint reload after navigating to New Endpoint', async () => {
    const user = userEvent.setup();
    const pendingReload = deferred<EndpointDetail>();
    vi.mocked(variantsApi.create).mockResolvedValue({
      id: 'var_created',
      endpointId: endpoint.id,
      name: 'Created',
      status: 200,
      responseHeaders: {},
      revision: 1,
    });
    vi.mocked(endpointsApi.get)
      .mockResolvedValueOnce(endpoint)
      .mockReturnValueOnce(pendingReload.promise);
    render(<App />);
    await user.click(await screen.findByText('Playback authorization'));
    await user.click(await screen.findByRole('button', { name: 'New Variant' }));
    await user.type(screen.getByLabelText('New Variant name'), 'Created');
    await user.click(screen.getByRole('radio', { name: 'Blank Variant' }));
    await user.click(screen.getByRole('button', { name: 'Create Variant' }));
    await waitFor(() => expect(endpointsApi.get).toHaveBeenCalledTimes(2));

    await user.click(screen.getByRole('button', { name: 'New Endpoint' }));
    expect(await screen.findByRole('button', { name: 'Create Endpoint' })).toBeVisible();

    await act(async () => {
      pendingReload.resolve({ ...endpoint, revision: 5 });
    });

    expect(screen.getByRole('button', { name: 'Create Endpoint' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Save Endpoint' })).not.toBeInTheDocument();
  });

  it('keeps a newer dirty App State selected when an older save resolves', async () => {
    const user = userEvent.setup();
    const pendingSave = deferred<AppState>();
    const stateB: AppState = {
      ...appState,
      id: 'state_2',
      name: 'Signed out',
      expectedUi: 'Server B',
      revision: 4,
    };
    function useStateOwnershipOverride(projectId?: string) {
      const [selectedStateId, setSelectedStateId] = useState<string | undefined>(appState.id);
      const selectedStateIdRef = useRef<string | undefined>(selectedStateId);
      useLayoutEffect(() => {
        selectedStateIdRef.current = selectedStateId;
      }, [selectedStateId]);
      const selectedState = selectedStateId === stateB.id ? stateB : appState;
      return {
        states: [appState, stateB].map(candidate => ({
          id: candidate.id,
          projectId: candidate.projectId,
          name: candidate.name,
          tags: candidate.tags,
          revision: candidate.revision,
          boundEndpointCount: 1,
          totalEndpointCount: 1,
        })),
        selectedState,
        selectedStateId,
        loading: false,
        detailLoading: false,
        selectState: (id: string | undefined) => {
          stateHookSpies.selectState(id);
          setSelectedStateId(id);
        },
        beginStatePublication: () => ({
          projectId,
          selectedStateId: selectedStateIdRef.current,
          projectGeneration: 0,
          detailGeneration: 0,
        }),
        publishState: (publication: { selectedStateId?: string }, saved: AppState) => {
          if (publication.selectedStateId !== selectedStateIdRef.current
            || saved.id !== selectedStateIdRef.current) return false;
          setSelectedStateId(saved.id);
          return true;
        },
        refresh: stateHookSpies.refresh,
        reloadSelected: stateHookSpies.reloadSelected,
        projectId,
      };
    }
    stateHookOverride.current = useStateOwnershipOverride;
    vi.mocked(statesApi.update).mockReturnValueOnce(pendingSave.promise);
    render(<App />);
    await user.click(screen.getByRole('tab', { name: 'App States' }));
    await user.type(await screen.findByLabelText('Expected UI'), ' pending A');
    await user.click(screen.getByRole('button', { name: 'Save App State' }));
    await user.click(screen.getByRole('button', { name: 'Signed out 1/1 bound' }));
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    await user.clear(await screen.findByLabelText('Expected UI'));
    await user.type(screen.getByLabelText('Expected UI'), 'Dirty B');

    await act(async () => {
      pendingSave.resolve({ ...appState, expectedUi: 'saved A', revision: 4 });
    });

    expect(screen.getByRole('button', { name: 'Signed out 1/1 bound' })).toHaveClass('bg-blue-50');
    expect(screen.getByLabelText('Expected UI')).toHaveValue('Dirty B');
    expect(stateHookSpies.selectState).not.toHaveBeenCalledWith(appState.id);
  });

  it('guards explicit App State conflict refresh before reloading canonical detail', async () => {
    const user = userEvent.setup();
    vi.mocked(statesApi.update).mockRejectedValue(new Error('conflict'));
    const conflict = Object.assign(new Error('App State changed'), {
      status: 409,
      currentRevision: 8,
    });
    vi.mocked(statesApi.update).mockRejectedValue(conflict);
    render(<App />);
    await user.click(screen.getByRole('tab', { name: 'App States' }));
    await user.type(await screen.findByLabelText('Expected UI'), 'Local state draft');
    await user.click(screen.getByRole('button', { name: 'Save App State' }));
    await screen.findByText('Server revision 8');

    await user.click(screen.getByRole('button', { name: 'Refresh App State' }));
    expect(stateHookSpies.reloadSelected).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Unsaved changes' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Discard' }));

    expect(stateHookSpies.reloadSelected).toHaveBeenCalledOnce();
  });

  it('publishes a deferred App State conflict refresh into canonical editor fields and revision', async () => {
    const user = userEvent.setup();
    const pendingReload = deferred<AppState>();
    const canonicalState: AppState = {
      ...appState,
      name: 'Canonical signed in',
      expectedUi: 'Canonical screen',
      revision: 8,
    };
    function useDeferredRefreshOverride() {
      const [selectedState, setSelectedState] = useState(appState);
      const [detailLoading, setDetailLoading] = useState(false);
      return {
        states: [{
          id: selectedState.id,
          projectId: selectedState.projectId,
          name: selectedState.name,
          tags: selectedState.tags,
          revision: selectedState.revision,
          boundEndpointCount: 1,
          totalEndpointCount: 1,
        }],
        selectedState,
        selectedStateId: selectedState.id,
        loading: false,
        detailLoading,
        selectState: stateHookSpies.selectState,
        beginStatePublication: stateHookSpies.beginStatePublication,
        publishState: stateHookSpies.publishState,
        refresh: stateHookSpies.refresh,
        reloadSelected: async () => {
          setDetailLoading(true);
          const refreshed = await pendingReload.promise;
          setSelectedState(refreshed);
          setDetailLoading(false);
        },
      };
    }
    stateHookOverride.current = useDeferredRefreshOverride;
    vi.mocked(statesApi.update)
      .mockRejectedValueOnce(Object.assign(new Error('App State changed'), {
        status: 409,
        currentRevision: 8,
      }))
      .mockResolvedValueOnce({ ...canonicalState, expectedUi: 'Saved after refresh', revision: 9 });
    render(<App />);
    await user.click(screen.getByRole('tab', { name: 'App States' }));
    await user.type(await screen.findByLabelText('Expected UI'), 'Local state draft');
    await user.click(screen.getByRole('button', { name: 'Save App State' }));
    await screen.findByText('Server revision 8');

    await user.click(screen.getByRole('button', { name: 'Refresh App State' }));
    await user.click(screen.getByRole('button', { name: 'Discard' }));

    expect(screen.getByLabelText('App State name')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Refreshing App State...' })).toBeDisabled();
    await user.type(screen.getByLabelText('Expected UI'), 'must not survive');
    expect(screen.getByLabelText('Expected UI')).not.toHaveValue(expect.stringContaining('must not survive'));

    await act(async () => pendingReload.resolve(canonicalState));

    await waitFor(() => expect(screen.getByLabelText('App State name')).toHaveValue('Canonical signed in'));
    expect(screen.getByLabelText('Expected UI')).toHaveValue('Canonical screen');
    await user.clear(screen.getByLabelText('Expected UI'));
    await user.type(screen.getByLabelText('Expected UI'), 'Saved after refresh');
    await user.click(screen.getByRole('button', { name: 'Save App State' }));
    expect(statesApi.update).toHaveBeenLastCalledWith('prj_1', 'state_1', 8, {
      expectedUi: 'Saved after refresh',
    });
  });

  it('closes Endpoint detail and refreshes canonical Endpoint, State, and selected State data after deletion', async () => {
    const user = userEvent.setup();
    vi.mocked(endpointsApi.deletionImpact).mockResolvedValue({
      endpointId: endpoint.id,
      endpointRevision: endpoint.revision,
      affectedStates: [{ id: appState.id, name: appState.name, revision: appState.revision }],
    });
    vi.mocked(endpointsApi.delete).mockResolvedValue(undefined);
    render(<App />);
    await user.click(await screen.findByText('Playback authorization'));
    await screen.findByLabelText('Endpoint name');

    await user.click(screen.getByText('Endpoint actions'));
    await user.click(screen.getByRole('button', { name: 'Delete Endpoint' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete Endpoint' });
    await user.click(within(dialog).getByRole('button', { name: 'Delete Endpoint' }));

    await waitFor(() => expect(endpointsApi.list).toHaveBeenCalledTimes(2));
    expect(screen.queryByLabelText('Endpoint name')).not.toBeInTheDocument();
    expect(screen.getByText('Select an Endpoint to edit its Variants.')).toBeVisible();
    expect(stateHookSpies.refresh).toHaveBeenCalledOnce();
    expect(stateHookSpies.reloadSelected).toHaveBeenCalledOnce();
  });

  it('clears deleted App State selection and refreshes canonical States and Project fields', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('tab', { name: 'App States' }));
    await screen.findByLabelText('App State name');

    await user.click(screen.getByRole('button', { name: 'Delete App State' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete App State' });
    await user.click(within(dialog).getByRole('button', { name: 'Delete App State' }));

    await waitFor(() => expect(stateHookSpies.refresh).toHaveBeenCalledOnce());
    expect(stateHookSpies.selectState).toHaveBeenCalledWith(undefined);
    expect(refreshProjects).toHaveBeenCalledOnce();
  });
});
