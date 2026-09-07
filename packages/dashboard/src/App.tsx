import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { endpointsApi, statesApi } from './api/client';
import type { AppState, EndpointDetail, Project } from './api/types';
import Layout from './components/Layout';
import type { ViewType } from './components/ProjectList';
import { ConfirmDialog } from './components/ConfirmDialog';
import { EndpointList } from './components/EndpointList';
import { EndpointEditor } from './components/EndpointEditor';
import { AppStateSwitcher } from './components/AppStateSwitcher';
import { AppStateEditor } from './components/AppStateEditor';
import { ImportWizard } from './components/import/ImportWizard';
import { RepositoryDiagnostics } from './components/RepositoryDiagnostics';
import { InterceptionSettings } from './components/InterceptionSettings';
import { StaticFilesView } from './components/StaticFilesView';
import { TrafficView } from './components/TrafficView';
import { BodyDocumentCacheProvider } from './components/BodyDocumentCacheProvider';
import { useEndpoints } from './hooks/useEndpoints';
import type { EndpointPublicationToken } from './hooks/useEndpoints';
import { useTraffic } from './hooks/useTraffic';
import { useRepositoryDiagnostics } from './hooks/useRepositoryDiagnostics';
import { useStates } from './hooks/useStates';
import type { StatePublicationToken } from './hooks/useStates';
import { useUnsavedChangesGuard } from './hooks/useUnsavedChangesGuard';
import { createBodyDocumentCache } from './state/bodyDocumentCache';
import { useBodyDocumentCache } from './state/bodyDocumentCacheContext';

interface ImportSettlementOwner {
  projectId: string;
  draftKey: string;
}

function App() {
  const [activeView, setActiveView] = useState<ViewType>('endpoints');
  const [bodyDocumentCache] = useState(createBodyDocumentCache);
  const guard = useUnsavedChangesGuard();
  const guardRef = useRef(guard);
  const importSettlementRef = useRef<ImportSettlementOwner | undefined>(undefined);
  useLayoutEffect(() => {
    guardRef.current = guard;
  }, [guard]);
  const { diagnostics } = useRepositoryDiagnostics();

  const onDirtyChange = useCallback((key: string, dirty: boolean, discard?: () => void) => {
    if (dirty) {
      guardRef.current.markDirty(key, discard);
    } else {
      guardRef.current.clearDraft(key);
    }
  }, []);

  const attemptNavigation = useCallback((action: () => void, affected: boolean | string[] = true) => {
    if (importSettlementRef.current) return;
    if (affected === false) action();
    else guardRef.current.attemptNavigation(action, Array.isArray(affected) ? affected : undefined);
  }, []);

  const startImportSettlement = useCallback((projectId: string, draftKey: string) => {
    const owner = { projectId, draftKey };
    importSettlementRef.current = owner;
    return owner;
  }, []);

  const finishImportSettlement = useCallback((owner: ImportSettlementOwner) => {
    if (importSettlementRef.current === owner) importSettlementRef.current = undefined;
  }, []);

  return (
    <BodyDocumentCacheProvider cache={bodyDocumentCache}>
      <RepositoryDiagnostics diagnostics={diagnostics} />
      <Layout
        activeView={activeView}
        onSelectView={view => attemptNavigation(() => setActiveView(view))}
        onAttemptNavigation={attemptNavigation}
      >
        {(activeProject, refreshProjects) => (
          <AppContent
            activeProject={activeProject}
            activeView={activeView}
            refreshProjects={refreshProjects}
            onDirtyChange={onDirtyChange}
            onAttemptNavigation={attemptNavigation}
            onImportSettlementStart={startImportSettlement}
            onImportSettlementFinish={finishImportSettlement}
          />
        )}
      </Layout>
      <ConfirmDialog
        isOpen={guard.dialog.open}
        title="Unsaved changes"
        message="Stay to keep editing, or discard the draft and continue."
        confirmLabel="Discard"
        cancelLabel="Stay"
        variant="danger"
        onConfirm={() => {
          if (importSettlementRef.current) return;
          guard.discard();
        }}
        onCancel={guard.stay}
      />
    </BodyDocumentCacheProvider>
  );
}

interface AppContentProps {
  activeProject?: Project;
  activeView: ViewType;
  refreshProjects(): Promise<void>;
  onDirtyChange(key: string, dirty: boolean, discard?: () => void): void;
  onAttemptNavigation(action: () => void, affected?: boolean | string[]): void;
  onImportSettlementStart(projectId: string, draftKey: string): ImportSettlementOwner;
  onImportSettlementFinish(owner: ImportSettlementOwner): void;
}

function AppContent({
  activeProject,
  activeView,
  refreshProjects,
  onDirtyChange,
  onAttemptNavigation,
  onImportSettlementStart,
  onImportSettlementFinish,
}: AppContentProps) {
  const projectId = activeProject?.id;
  const bodyDocumentCache = useBodyDocumentCache();
  const bodyDocumentProject = useRef(projectId);
  const endpoints = useEndpoints(projectId);
  const states = useStates(projectId);
  const [endpointEditorOpen, setEndpointEditorOpen] = useState(false);
  const importContext = `${projectId ?? ''}:${activeView}`;
  const [importVisibility, setImportVisibility] = useState({ context: importContext, open: false });
  const [importGuidance, setImportGuidance] = useState<{ projectId?: string; origins: readonly string[] }>({
    projectId,
    origins: [],
  });
  if (importVisibility.context !== importContext) {
    setImportVisibility({ context: importContext, open: false });
  }
  if (importGuidance.projectId !== projectId) {
    setImportGuidance({ projectId, origins: [] });
  }
  const importOpen = importVisibility.context === importContext && importVisibility.open;
  const setImportOpen = (open: boolean) => setImportVisibility({ context: importContext, open });
  const importDraftKey = projectId ? `import:${projectId}` : 'import';
  const activeImportSettlementRef = useRef<ImportSettlementOwner | undefined>(undefined);
  const retainedImportDraftRef = useRef<string | undefined>(undefined);
  const stateEndpointRequestKey = activeView === 'states' && projectId && endpoints.endpoints.length > 0
    ? `${projectId}:${endpoints.endpoints.map(endpoint => `${endpoint.id}:${endpoint.revision}`).join(',')}`
    : undefined;
  const [loadedStateEndpoints, setLoadedStateEndpoints] = useState<{
    requestKey: string;
    endpoints: EndpointDetail[];
  }>();
  const stateEndpoints = loadedStateEndpoints && loadedStateEndpoints.requestKey === stateEndpointRequestKey
    ? loadedStateEndpoints.endpoints
    : [];
  const traffic = useTraffic(projectId, { enabled: activeView === 'traffic', pollIntervalMs: 1000 });

  useLayoutEffect(() => {
    const previousProject = bodyDocumentProject.current;
    bodyDocumentProject.current = projectId;
    if (previousProject !== undefined && previousProject !== projectId) {
      bodyDocumentCache.invalidateProject(previousProject);
    }
  }, [bodyDocumentCache, projectId]);

  useLayoutEffect(() => () => {
    if (retainedImportDraftRef.current === importDraftKey) {
      retainedImportDraftRef.current = undefined;
    }
    const owner = activeImportSettlementRef.current;
    if (!owner || owner.projectId !== projectId) return;
    activeImportSettlementRef.current = undefined;
    onImportSettlementFinish(owner);
  }, [importDraftKey, onImportSettlementFinish, projectId]);

  const handleImportSettlementChange = useCallback((pending: boolean) => {
    if (pending) {
      if (!projectId) return;
      const current = activeImportSettlementRef.current;
      if (current?.projectId === projectId && current.draftKey === importDraftKey) return;
      activeImportSettlementRef.current = onImportSettlementStart(projectId, importDraftKey);
      return;
    }
    const owner = activeImportSettlementRef.current;
    if (!owner) return;
    activeImportSettlementRef.current = undefined;
    onImportSettlementFinish(owner);
  }, [importDraftKey, onImportSettlementFinish, onImportSettlementStart, projectId]);

  useEffect(() => {
    if (!stateEndpointRequestKey || !projectId) return;
    const controller = new AbortController();
    void Promise.all(endpoints.endpoints.map(endpoint => endpointsApi.get(
      projectId,
      endpoint.id,
      controller.signal,
    ))).then(details => setLoadedStateEndpoints({
      requestKey: stateEndpointRequestKey,
      endpoints: details,
    })).catch(error => {
      if (!(error instanceof Error && error.name === 'AbortError')) console.error(error);
    });
    return () => controller.abort();
  }, [endpoints.endpoints, projectId, stateEndpointRequestKey]);

  if (!activeProject || !projectId) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-sm text-gray-500">
        Create or select a Project to configure Endpoints and App States.
      </div>
    );
  }

  const title: Record<ViewType, string> = {
    endpoints: 'Endpoints',
    states: 'App States',
    traffic: 'Traffic',
    intercept: 'Proxy Intercept',
    files: 'Static Files',
  };

  const saveEndpoint = (publication: EndpointPublicationToken, saved: EndpointDetail): boolean => {
    const accepted = endpoints.publishEndpoint(publication, saved);
    void endpoints.refresh();
    return accepted;
  };

  const saveState = (publication: StatePublicationToken, saved: AppState): boolean => {
    const accepted = states.publishState(publication, saved);
    if (accepted) void states.refresh();
    return accepted;
  };

  const createState = async () => {
    const saved = await statesApi.create(projectId, {
      name: 'New App State', tags: [], bindings: {},
    });
    await states.refresh();
    states.selectState(saved.id);
  };

  const handleEndpointDeleted = async () => {
    endpoints.selectEndpoint(undefined);
    setEndpointEditorOpen(false);
    await Promise.all([endpoints.refresh(), states.refresh()]);
    await states.reloadSelected();
  };

  const handleStateDeleted = async (stateId: string) => {
    if (states.selectedStateId === stateId) states.selectState(undefined);
    await Promise.all([states.refresh(), refreshProjects()]);
  };

  const closeImport = () => onAttemptNavigation(() => {
    setImportOpen(false);
  }, [importDraftKey]);

  const refreshImportCanonicalData = async () => {
    const listResults = await Promise.all([endpoints.refresh(), states.refresh()]);
    const detailResults = await Promise.all([
      endpoints.reloadSelected(),
      states.reloadSelected(),
    ]);
    if (listResults.includes(false) || detailResults.includes(false)) {
      throw new Error('Canonical dashboard refresh failed');
    }
  };

  const handleImportCommitted = async () => {
    retainedImportDraftRef.current = importDraftKey;
    await refreshImportCanonicalData();
    if (retainedImportDraftRef.current === importDraftKey) {
      retainedImportDraftRef.current = undefined;
    }
    onDirtyChange(importDraftKey, false);
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-white">
      <div className="flex h-12 flex-shrink-0 items-center border-b border-gray-200 bg-[#F3F3F3] px-3">
        <h2 className="text-sm font-semibold text-gray-800">
          {activeProject.name}<span className="mx-2 text-gray-400">/</span><span className="font-normal text-gray-600">{title[activeView]}</span>
        </h2>
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {activeView === 'endpoints' ? (
          <div className="flex h-full min-h-0">
            <div className="w-80 flex-shrink-0 border-r border-gray-200">
              <EndpointList
                endpoints={endpoints.endpoints}
                selectedEndpointId={endpoints.selectedEndpointId}
                loading={endpoints.loading}
                onImport={() => onAttemptNavigation(() => setImportOpen(true))}
                onSelect={id => onAttemptNavigation(() => {
                  endpoints.selectEndpoint(id);
                  setEndpointEditorOpen(true);
                })}
                onCreate={() => onAttemptNavigation(() => {
                  endpoints.selectEndpoint(undefined);
                  setEndpointEditorOpen(true);
                })}
              />
            </div>
            <div className="min-w-0 flex-1 overflow-hidden bg-gray-50">
              {endpointEditorOpen ? (
                endpoints.detailLoading ? <p className="p-5 text-sm text-gray-500">Loading Endpoint...</p> : (
                  <EndpointEditor
                    key={endpoints.selectedEndpoint?.id ?? 'new'}
                    projectId={projectId}
                    project={activeProject}
                    endpoint={endpoints.selectedEndpoint}
                    onEndpointSaveStarted={() => {
                      const publication = endpoints.beginEndpointPublication();
                      return saved => saveEndpoint(publication, saved);
                    }}
                    onSaved={saved => void saveEndpoint(endpoints.beginEndpointPublication(), saved)}
                    onDeleted={() => void handleEndpointDeleted()}
                    onClose={() => onAttemptNavigation(() => setEndpointEditorOpen(false))}
                    onDirtyChange={onDirtyChange}
                    onAttemptNavigation={(action, draftKeys) => onAttemptNavigation(action, draftKeys)}
                  />
                )
              ) : <div className="flex h-full items-center justify-center text-sm text-gray-400">Select an Endpoint to edit its Variants.</div>}
            </div>
          </div>
        ) : null}

        {activeView === 'states' ? (
          <div className="h-full overflow-y-auto bg-gray-50 p-5">
            <AppStateSwitcher
              project={activeProject}
              states={states.states}
              endpoints={endpoints.endpoints}
              onActivated={() => void refreshProjects()}
            />
            <div className="mt-5 grid gap-5 lg:grid-cols-[18rem_1fr]">
              <section className="rounded-lg border border-gray-200 bg-white p-3">
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-gray-900">App States</h3>
                  <button
                    type="button"
                    onClick={() => onAttemptNavigation(() => void createState())}
                    className="rounded bg-blue-600 px-2 py-1 text-xs text-white"
                  >
                    New
                  </button>
                </div>
                {states.states.map(state => (
                  <button key={state.id} type="button" onClick={() => onAttemptNavigation(() => states.selectState(state.id))} className={`mb-1 w-full rounded px-3 py-2 text-left text-sm ${states.selectedStateId === state.id ? 'bg-blue-50 text-blue-800' : 'hover:bg-gray-50'}`}>
                    <span className="block font-medium">{state.name}</span>
                    <span className="text-xs text-gray-500">{state.boundEndpointCount}/{state.totalEndpointCount} bound</span>
                  </button>
                ))}
              </section>
              <div>
                {states.detailLoading ? <p className="text-sm text-gray-500">Loading App State...</p> : null}
                {states.selectedState ? (
                   <AppStateEditor
                      key={`${states.selectedState.projectId}:${states.selectedState.id}:${states.selectedState.revision}`}
                     state={states.selectedState}
                     project={activeProject}
                     endpoints={stateEndpoints}
                     onSaveStarted={() => {
                       const publication = states.beginStatePublication();
                       return saved => saveState(publication, saved);
                     }}
                       onRefresh={async () => { await states.reloadSelected(); }}
                     onDeleted={stateId => void handleStateDeleted(stateId)}
                     onDirtyChange={onDirtyChange}
                     onAttemptNavigation={(action, draftKeys) => onAttemptNavigation(action, draftKeys)}
                   />
                ) : <p className="p-8 text-center text-sm text-gray-400">Select an App State to edit stable bindings.</p>}
              </div>
            </div>
          </div>
        ) : null}

        {activeView === 'traffic' ? (
          <TrafficView
            traffic={traffic.entries}
            selectedTraffic={traffic.selected}
            detailLoading={traffic.detailLoading}
            onSelectTraffic={id => traffic.select(id)}
            loading={traffic.loading || traffic.clearing}
            listError={traffic.error?.message}
            detailError={traffic.error?.message}
            paused={traffic.paused}
            onTogglePaused={traffic.setPaused}
            onClear={() => void traffic.clear()}
            onRefresh={() => void traffic.refresh()}
            projectId={projectId}
            states={states.states}
            defaultStateId={activeProject.activeStateId}
            refreshPromotionCanonical={async result => {
              const listReads = Promise.all([endpoints.refresh(), states.refresh()]);
              const detailReads = Promise.all([endpoints.reloadSelected(), states.reloadSelected()]);
              const targetReads: Array<Promise<unknown>> = [];
              if (result !== undefined) {
                targetReads.push(endpointsApi.get(projectId, result.endpointId));
                if (result.stateId !== undefined) targetReads.push(statesApi.get(projectId, result.stateId));
              }
              const selectedTrafficRequest = traffic.refreshSelected();
              const [listResults, selectedDetailResults, , selectedTraffic] = await Promise.all([
                listReads,
                detailReads,
                Promise.all(targetReads),
                selectedTrafficRequest,
              ]);
              if (listResults.includes(false)
                || selectedDetailResults.includes(false)
                || selectedTraffic === null) {
                throw new Error('Canonical promotion refresh failed');
              }
              return selectedTraffic;
            }}
          />
        ) : null}
        {activeView === 'intercept' ? (
          <div className="h-full overflow-y-auto p-6">
            <InterceptionSettings
              key={activeProject.id}
              project={activeProject}
              discoveredOrigins={importGuidance.projectId === projectId ? importGuidance.origins : []}
              onUpdate={() => void refreshProjects()}
              onDirtyChange={onDirtyChange}
            />
          </div>
        ) : null}
        {activeView === 'files' ? <StaticFilesView projectId={projectId} /> : null}
      </div>
      {importOpen && activeView === 'endpoints' ? (
        <ImportWizard
          isOpen
          projectId={projectId}
          onDirtyChange={(dirty, discard) => {
            if (!dirty && (
              activeImportSettlementRef.current?.draftKey === importDraftKey
              || retainedImportDraftRef.current === importDraftKey
            )) return;
            onDirtyChange(
              importDraftKey,
              dirty,
              () => {
                if (retainedImportDraftRef.current === importDraftKey) {
                  retainedImportDraftRef.current = undefined;
                }
                discard();
                setImportOpen(false);
              },
            );
          }}
          onRequestClose={closeImport}
          onCommitted={handleImportCommitted}
          onCommitOutcomeUnknown={refreshImportCanonicalData}
          onSettlementChange={handleImportSettlementChange}
          onDiscoveredOrigins={origins => setImportGuidance({ projectId, origins })}
          onViewEndpoints={() => setImportOpen(false)}
        />
      ) : null}
    </div>
  );
}

export default App;
