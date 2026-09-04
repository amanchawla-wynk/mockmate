import { useRef, useState } from 'react';
import { ApiClientError, projectsApi, statesApi } from '../api/client';
import type { AppStateSummary, EndpointSummary, Project } from '../api/types';

export interface AppStateSwitcherProps {
  project: Project;
  states: AppStateSummary[];
  endpoints: EndpointSummary[];
  onActivated(project: Project): void;
}

export function AppStateSwitcher({ project, states, endpoints, onActivated }: AppStateSwitcherProps) {
  const [pending, setPending] = useState<AppStateSummary>();
  const [error, setError] = useState<string>();
  const [modePendingOwner, setModePendingOwner] = useState<string>();
  const projectOwner = `${project.id}:${project.revision}:${project.appStateMode}`;
  const projectOwnerRef = useRef(projectOwner);
  projectOwnerRef.current = projectOwner;
  const modeOperation = useRef<{ owner: string; request: number } | undefined>(undefined);
  const nextRequest = useRef(0);
  const mockReadyCount = endpoints.filter(endpoint => endpoint.mode === 'mock' && endpoint.mockReady).length;

  const activate = async (state: AppStateSummary, allowFallback: boolean) => {
    try {
      const saved = await statesApi.setSelection(project.id, project.revision, {
        activeStateId: state.id,
        allowFallback,
      });
      setPending(undefined);
      onActivated(saved);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to activate App State');
    }
  };

  const toggleMode = async () => {
    const owner = projectOwner;
    if (modeOperation.current?.owner === owner) return;
    const operation = { owner, request: ++nextRequest.current };
    modeOperation.current = operation;
    setModePendingOwner(owner);
    setError(undefined);
    const ownsOperation = () => modeOperation.current === operation && projectOwnerRef.current === owner;
    try {
      const mode = project.appStateMode === 'enabled' ? 'disabled' : 'enabled';
      const saved = await statesApi.setMode(project.id, mode, project.revision);
      if (ownsOperation()) onActivated(saved);
    } catch (caught) {
      if (!ownsOperation()) return;
      if (caught instanceof ApiClientError && caught.status === 409) {
        setError(caught.currentRevision === undefined
          ? caught.message
          : `Server revision ${caught.currentRevision}`);
      } else if (!(caught instanceof ApiClientError) || caught.status === 0 || caught.status >= 500) {
        try {
          const canonical = await projectsApi.get(project.id);
          if (ownsOperation()) onActivated(canonical);
        } catch {
          if (ownsOperation()) {
            setError('App State mode outcome is unknown. Refresh the Project before trying again.');
          }
        }
      } else {
        setError(caught.message);
      }
    } finally {
      if (modeOperation.current === operation) {
        modeOperation.current = undefined;
        setModePendingOwner(undefined);
      }
    }
  };

  return (
    <section className="space-y-3 rounded-lg border border-gray-200 bg-white p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-900">Active App State</h3>
        <div className="flex items-center gap-3">
          <span className="text-xs text-gray-500">
            {mockReadyCount} Mock-ready {mockReadyCount === 1 ? 'Endpoint' : 'Endpoints'}
          </span>
          <button type="button" disabled={modePendingOwner === projectOwner} onClick={() => void toggleMode()} className="rounded border border-gray-300 px-2 py-1 text-xs disabled:opacity-50">
            {project.appStateMode === 'enabled' ? 'Disable App States' : 'Enable App States'}
          </button>
        </div>
      </div>
      {error ? <p className="text-sm text-red-700">{error}</p> : null}
      {project.appStateMode === 'disabled' ? (
        <p className="text-xs text-gray-600">App State selection is dormant while mode is disabled. Active and base State IDs are retained.</p>
      ) : null}
      <div className="flex flex-wrap gap-2" aria-disabled={project.appStateMode === 'disabled'}>
        {states.map(state => (
          <button
            key={state.id}
            type="button"
            aria-label={`Activate ${state.name}`}
            onClick={() => {
              if (state.missingEndpointIds.length > 0) setPending(state);
              else void activate(state, false);
            }}
            className={`rounded border px-3 py-2 text-left text-xs ${project.activeStateId === state.id ? 'border-blue-400 bg-blue-50 text-blue-800' : 'border-gray-300 bg-white text-gray-700'}`}
          >
            <span className="block font-medium">{state.name}</span>
            <span className="block text-gray-500">{state.boundEndpointCount}/{state.totalEndpointCount} bound</span>
          </button>
        ))}
      </div>
      {pending ? (
        <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <p>{pending.missingEndpointIds.length} endpoints will fall back</p>
          <div className="mt-2 flex gap-2">
            <button type="button" onClick={() => void activate(pending, true)} className="rounded bg-amber-700 px-3 py-1.5 text-xs font-medium text-white">Activate with fallback</button>
            <button type="button" onClick={() => setPending(undefined)} className="rounded border border-amber-400 px-3 py-1.5 text-xs">Cancel</button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
