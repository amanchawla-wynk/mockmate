import { useCallback, useEffect, useState } from 'react';
import Layout from './components/Layout';
import { ResourceList } from './components/ResourceList';
import { ResourceEditor } from './components/ResourceEditor';
import { ScenarioEditor } from './components/ScenarioEditor';
import { ScenarioSwitcher } from './components/ScenarioSwitcher';
import { BaseScenarioSwitcher } from './components/BaseScenarioSwitcher';
import { useResources } from './hooks/useResources';
import { useLogs } from './hooks/useLogs';
import { serverApi } from './api/client';
import { PassthroughSettings } from './components/PassthroughSettings';
import { LogsView } from './components/LogsView';
import { TrafficView } from './components/TrafficView';
import { StaticFilesView } from './components/StaticFilesView';
import type { ServerStatus, Resource, Project } from './api/types';
import type { ViewType } from './components/ProjectList';

function App() {
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [activeView, setActiveView] = useState<ViewType>('traffic');

  const loadStatus = useCallback(async () => {
    try {
      const data = await serverApi.status();
      setStatus(data);
    } catch (err) {
      console.error(err);
    }
  }, []);

  useEffect(() => {
    loadStatus();
    const id = window.setInterval(loadStatus, 1000);
    return () => window.clearInterval(id);
  }, [loadStatus]);

  return (
    <Layout activeView={activeView} onSelectView={setActiveView}>
      {(activeProjectId, _deactivateProject, activeProject, refreshProjects) => (
        <AppContent
          activeProjectId={activeProjectId}
          activeProject={activeProject}
          refreshProjects={refreshProjects}
          status={status}
          onRefreshStatus={loadStatus}
          activeView={activeView}
        />
      )}
    </Layout>
  );
}

interface AppContentProps {
  activeProjectId: string | undefined;
  activeProject: Project | undefined;
  refreshProjects: () => Promise<void>;
  status: ServerStatus | null;
  onRefreshStatus: () => Promise<void>;
  activeView: ViewType;
}

function AppContent({ activeProjectId, activeProject, refreshProjects, status, onRefreshStatus, activeView }: AppContentProps) {
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [selectedResource, setSelectedResource] = useState<Resource | null>(null);
  const [editingResource, setEditingResource] = useState<Resource | null>(null);

  const {
    resources,
    loading: resourcesLoading,
    createResource,
    updateResource,
    deleteResource,
    refresh: refreshResources,
  } = useResources(activeProjectId);

  const logsEnabled = activeView === 'logs' || activeView === 'traffic';
  const {
    logs,
    loading: logsLoading,
    error: logsError,
    paused: logsPaused,
    setPaused: setLogsPaused,
    refresh: refreshLogs,
    clear: clearLogs,
  } = useLogs({ enabled: logsEnabled, pollIntervalMs: 1000 });

  // Keep server status in sync with active project changes
  useEffect(() => {
    onRefreshStatus();
  }, [activeProjectId, onRefreshStatus]);

  // Clear selectedResource when activeProjectId changes or is cleared
  useEffect(() => {
    setSelectedResource(null);
    setEditingResource(null);
  }, [activeProjectId]);

  // Update or clear selectedResource when resources change
  useEffect(() => {
    if (selectedResource && resources.length > 0) {
      const updated = resources.find(r => r.id === selectedResource.id);
      if (updated) {
        setSelectedResource(updated);
      } else {
        setSelectedResource(null);
      }
    } else if (selectedResource && resources.length === 0) {
      setSelectedResource(null);
    }
  }, [resources, selectedResource]);

  const viewTitles: Record<ViewType, string> = {
    traffic: 'Traffic',
    logs: 'Logs',
    intercept: 'Proxy Intercept',
    resources: 'Rules',
    files: 'Static Files',
  };

  return (
    <>
      <div className="flex flex-col h-full min-h-0 bg-white overflow-hidden">
        {/* Top bar with tools/actions specific to the active view */}
        <div className="h-12 border-b border-gray-200 bg-[#F3F3F3] flex items-center justify-between px-3 flex-shrink-0">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-gray-800">
              {activeProject?.name ? (
                <>
                  {activeProject.name}
                  <span className="mx-2 text-gray-400">/</span>
                </>
              ) : null}
              <span className="text-gray-600 font-normal">
                {viewTitles[activeView]}
              </span>
            </h2>
          </div>
          
          <div className="flex items-center gap-3">
            {status?.activeProject && activeView !== 'resources' && (
              <div className="flex items-center gap-2 text-xs text-gray-700 bg-white border border-gray-200 rounded px-2 py-1">
                <span>
                  Active: <span className="font-mono">{status.activeProject.activeScenario}</span>
                </span>
                <span className="text-gray-300">|</span>
                <span>
                  Base: <span className="font-mono">{status.activeProject.baseScenario ?? 'default'}</span>
                </span>
              </div>
            )}
            {status?.activeProject && activeView === 'resources' && activeProjectId && (
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-600">Active</span>
                  <ScenarioSwitcher
                    projectId={activeProjectId}
                    resources={resources}
                    activeScenario={status.activeProject.activeScenario}
                    onSwitch={async () => {
                      await onRefreshStatus();
                      await refreshResources();
                    }}
                  />
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-600">Base</span>
                  <BaseScenarioSwitcher
                    projectId={activeProjectId}
                    resources={resources}
                    baseScenario={status.activeProject.baseScenario ?? 'default'}
                    onSwitch={async () => {
                      await onRefreshStatus();
                      await refreshResources();
                    }}
                  />
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Content Area */}
        <div className="flex-1 min-h-0 relative overflow-hidden">
          {activeView === 'traffic' ? (
            <TrafficView
              logs={logs}
              loading={logsLoading}
              error={logsError}
              paused={logsPaused}
              onTogglePaused={setLogsPaused}
              onClear={clearLogs}
              onRefresh={refreshLogs}
              projectId={activeProjectId ?? undefined}
              activeScenario={status?.activeProject?.activeScenario}
              onRuleCreated={async () => {
                await refreshResources();
              }}
            />
          ) : activeView === 'logs' ? (
            <LogsView
              logs={logs}
              loading={logsLoading}
              error={logsError}
              paused={logsPaused}
              onTogglePaused={setLogsPaused}
              onClear={clearLogs}
              onRefresh={refreshLogs}
            />
          ) : activeView === 'intercept' ? (
            !activeProject ? (
              <div className="flex-1 p-8 text-center text-gray-500 text-sm">
                Select a domain from the workspace to configure proxy interception.
              </div>
            ) : (
              <div className="p-6 max-w-4xl mx-auto overflow-y-auto h-full">
                <PassthroughSettings
                  project={activeProject}
                  onUpdate={refreshProjects}
                />
              </div>
            )
          ) : activeView === 'files' ? (
            !activeProject || !activeProjectId ? (
              <div className="flex-1 p-8 text-center text-gray-500 text-sm">
                Select a project from the workspace to manage its static files.
              </div>
            ) : (
              <StaticFilesView
                projectId={activeProjectId}
                baseUrl={activeProject.baseUrl}
              />
            )
          ) : activeView === 'resources' ? (
            !activeProject || !activeProjectId ? (
              <div className="flex-1 p-8 text-center text-gray-500 text-sm">
                Select a domain from the workspace to manage its rules.
              </div>
            ) : (
              <div className="flex h-full min-h-0">
                <div className="w-80 border-r border-gray-200 bg-white flex flex-col">
                  <ResourceList
                    resources={resources}
                    onSelectResource={setSelectedResource}
                    onNewResource={() => setIsEditorOpen(true)}
                    onEditResource={(r) => {
                      setEditingResource(r);
                      setIsEditorOpen(true);
                    }}
                    onDeleteResource={deleteResource}
                    loading={resourcesLoading}
                    selectedResourceId={selectedResource?.id}
                  />
                </div>
                <div className="flex-1 bg-gray-50 flex flex-col min-h-0 overflow-y-auto">
                  {selectedResource ? (
                    <div className="p-4">
                      <ScenarioEditor
                        projectId={activeProjectId}
                        resource={selectedResource}
                        onUpdate={refreshResources}
                      />
                    </div>
                  ) : (
                    <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">
                      Select a rule to configure scenarios
                    </div>
                  )}
                </div>
              </div>
            )
          ) : null}
        </div>
      </div>

      {activeProjectId && (
        <ResourceEditor
          isOpen={isEditorOpen}
          onClose={() => {
            setIsEditorOpen(false);
            setEditingResource(null);
          }}
          onCreate={createResource}
          onUpdate={updateResource}
          projectId={activeProjectId}
          resource={editingResource ?? undefined}
        />
      )}
    </>
  );
}

export default App;
