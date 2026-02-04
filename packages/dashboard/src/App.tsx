/**
 * Main application component
 */

import { useEffect, useState } from 'react';
import Layout from './components/Layout';
import { ResourceList } from './components/ResourceList';
import { ResourceEditor } from './components/ResourceEditor';
import { ScenarioEditor } from './components/ScenarioEditor';
import { ScenarioSwitcher } from './components/ScenarioSwitcher';
import { DeviceSetup } from './components/DeviceSetup';
import { useResources } from './hooks/useResources';
import { serverApi } from './api/client';
import type { ServerStatus, Resource } from './api/types';

function App() {
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadStatus();
  }, []);

  const loadStatus = async () => {
    try {
      setLoading(true);
      const data = await serverApi.status();
      setStatus(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect to server');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Layout>
      {(activeProjectId, deactivateProject) => (
        <AppContent
          activeProjectId={activeProjectId}
          deactivateProject={deactivateProject}
          status={status}
          loading={loading}
          error={error}
          onRefreshStatus={loadStatus}
        />
      )}
    </Layout>
  );
}

interface AppContentProps {
  activeProjectId: string | undefined;
  deactivateProject: () => Promise<void>;
  status: ServerStatus | null;
  loading: boolean;
  error: string | null;
  onRefreshStatus: () => Promise<void>;
}

function AppContent({ activeProjectId, deactivateProject, status, loading, error, onRefreshStatus }: AppContentProps) {
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [selectedResource, setSelectedResource] = useState<Resource | null>(null);

  const {
    resources,
    loading: resourcesLoading,
    createResource,
    deleteResource,
    refresh: refreshResources,
  } = useResources(activeProjectId);

  // Clear selectedResource when activeProjectId changes or is cleared
  useEffect(() => {
    setSelectedResource(null);
  }, [activeProjectId]);

  // Update or clear selectedResource when resources change
  useEffect(() => {
    if (selectedResource && resources.length > 0) {
      const updated = resources.find(r => r.id === selectedResource.id);
      if (updated) {
        // Resource still exists, update it with latest data
        setSelectedResource(updated);
      } else {
        // Resource was deleted, clear selection
        setSelectedResource(null);
      }
    } else if (selectedResource && resources.length === 0) {
      // No resources left, clear selection
      setSelectedResource(null);
    }
  }, [resources]);

  return (
    <>
      <div className="flex h-full gap-6">
        {/* Resources Section */}
        {activeProjectId ? (
          <div className="w-96 bg-white rounded-lg shadow flex flex-col">
            <ResourceList
              resources={resources}
              onSelectResource={setSelectedResource}
              onNewResource={() => setIsEditorOpen(true)}
              onDeleteResource={deleteResource}
              loading={resourcesLoading}
              selectedResourceId={selectedResource?.id}
            />
          </div>
        ) : null}

        {/* Main Content */}
        <div className="flex-1">
          {!activeProjectId ? (
            <div className="space-y-6">
              <h2 className="text-2xl font-bold text-gray-900">Dashboard</h2>

              {/* Server Status Card */}
              <div className="bg-white rounded-lg shadow p-6">
                <h3 className="text-lg font-semibold text-gray-900 mb-4">Server Status</h3>

                {loading && (
                  <div className="text-gray-500">Loading...</div>
                )}

                {error && (
                  <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                    <div className="flex items-center">
                      <svg className="w-5 h-5 text-red-500 mr-2" fill="currentColor" viewBox="0 0 20 20">
                        <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
                      </svg>
                      <span className="text-red-700">{error}</span>
                    </div>
                    <p className="text-sm text-red-600 mt-2">
                      Make sure the MockMate server is running on <code className="bg-red-100 px-1 rounded">http://localhost:3456</code>
                    </p>
                  </div>
                )}

                {status && (
                  <div className="space-y-3">
                    <div className="flex items-center">
                      <div className="w-2 h-2 bg-green-500 rounded-full mr-2"></div>
                      <span className="text-sm text-gray-600">Status:</span>
                      <span className="ml-2 text-sm font-medium text-gray-900 capitalize">{status.status}</span>
                    </div>

                    <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3">
                      <p className="text-sm text-yellow-700">No active project</p>
                      <p className="text-xs text-yellow-600 mt-1">Create a project from the sidebar to get started</p>
                    </div>

                    <div className="text-xs text-gray-500">
                      Last updated: {new Date(status.timestamp).toLocaleString()}
                    </div>
                  </div>
                )}
              </div>

              {/* Device Setup Card */}
              <DeviceSetup httpPort={3456} httpsPort={3457} />

              {/* Welcome Card */}
              <div className="bg-indigo-50 border border-indigo-200 rounded-lg p-6">
                <h3 className="text-lg font-semibold text-indigo-900 mb-2">Welcome to MockMate!</h3>
                <p className="text-indigo-700 mb-4">
                  MockMate is a local mock API server designed for mobile developers. Get started by creating a project and adding resources.
                </p>
                <div className="space-y-2 text-sm text-indigo-600">
                  <div className="flex items-start">
                    <svg className="w-5 h-5 mr-2 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                    </svg>
                    <span>Create projects to organize your mock APIs</span>
                  </div>
                  <div className="flex items-start">
                    <svg className="w-5 h-5 mr-2 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                    </svg>
                    <span>Add resources with multiple scenarios (default, empty, error, etc.)</span>
                  </div>
                  <div className="flex items-start">
                    <svg className="w-5 h-5 mr-2 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                    </svg>
                    <span>Switch scenarios instantly without code changes</span>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-6">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <button
                    onClick={deactivateProject}
                    className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 transition-colors"
                  >
                    <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 19l-7-7m0 0l7-7m-7 7h18"/>
                    </svg>
                    <span>Back to Dashboard</span>
                  </button>
                  <h2 className="text-2xl font-bold text-gray-900">Resources</h2>
                </div>
                {status?.activeProject && (
                  <ScenarioSwitcher
                    projectId={activeProjectId}
                    resources={resources}
                    activeScenario={status.activeProject.activeScenario}
                    onSwitch={async () => {
                      await onRefreshStatus();
                      await refreshResources();
                    }}
                  />
                )}
              </div>

              {selectedResource ? (
                <div className="bg-white rounded-lg shadow p-6">
                  <ScenarioEditor
                    projectId={activeProjectId}
                    resource={selectedResource}
                    onUpdate={refreshResources}
                  />
                </div>
              ) : (
                <div className="bg-gray-50 border-2 border-dashed border-gray-300 rounded-lg p-12 text-center">
                  <svg
                    className="w-16 h-16 mx-auto text-gray-400 mb-4"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={1.5}
                      d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                    />
                  </svg>
                  <p className="text-gray-600 mb-2">No resource selected</p>
                  <p className="text-sm text-gray-500">
                    Select a resource from the list or create a new one to get started
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Resource Editor Modal */}
      <ResourceEditor
        isOpen={isEditorOpen}
        onClose={() => setIsEditorOpen(false)}
        onSubmit={createResource}
        projectId={activeProjectId}
      />
    </>
  );
}

export default App;
