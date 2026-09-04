import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { ApiClientError, projectsApi } from '../api/client';
import type {
  CreateProjectInput,
  Project,
  ProjectPatch,
  ProjectSummary,
  WorkspaceState,
} from '../api/types';

interface ProjectsState {
  projects: ProjectSummary[];
  workspace?: WorkspaceState;
  activeProject?: Project;
  loading: boolean;
  error?: ApiClientError;
}

export interface UseProjectsResult extends ProjectsState {
  refresh(): Promise<void>;
  create(input: CreateProjectInput): Promise<Project>;
  update(projectId: string, expectedRevision: number, patch: ProjectPatch): Promise<Project>;
  setActive(projectId: string | null, expectedRevision: number): Promise<WorkspaceState>;
  remove(projectId: string, expectedRevision: number): Promise<void>;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function clientError(error: unknown): ApiClientError {
  if (error instanceof ApiClientError) return error;
  return new ApiClientError(
    0,
    'NETWORK_ERROR',
    error instanceof Error ? error.message : 'Failed to load Projects',
    '',
  );
}

export function useProjects(): UseProjectsResult {
  const [state, setState] = useState<ProjectsState>({ projects: [], loading: false });
  const generationRef = useRef(0);
  const lifecycleRef = useRef(0);
  const mountedRef = useRef(false);
  const refreshControllerRef = useRef<AbortController | null>(null);
  const detailControllerRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    if (!mountedRef.current) return;
    const generation = ++generationRef.current;
    refreshControllerRef.current?.abort();
    detailControllerRef.current?.abort();
    detailControllerRef.current = null;
    const controller = new AbortController();
    refreshControllerRef.current = controller;
    setState(current => ({ ...current, loading: true, error: undefined }));
    const projectsRequest = projectsApi.list(controller.signal);
    const workspaceRequest = projectsApi.getWorkspace(controller.signal);
    try {
      let projects: ProjectSummary[];
      let workspace: WorkspaceState;
      try {
        [projects, workspace] = await Promise.all([projectsRequest, workspaceRequest]);
      } catch (error) {
        if (!isAbort(error)
          && refreshControllerRef.current === controller
          && generationRef.current === generation) {
          controller.abort();
          await Promise.allSettled([projectsRequest, workspaceRequest]);
          if (refreshControllerRef.current === controller && generationRef.current === generation) {
            setState(current => ({ ...current, error: clientError(error) }));
          }
        }
        return;
      }
      if (refreshControllerRef.current !== controller || generationRef.current !== generation) return;
      setState(current => ({ ...current, projects, workspace }));

      if (!workspace.activeProjectId) {
        setState(current => ({ ...current, activeProject: undefined }));
        return;
      }

      const detailController = new AbortController();
      detailControllerRef.current = detailController;
      const activeProject = await projectsApi.get(workspace.activeProjectId, detailController.signal);
      if (refreshControllerRef.current !== controller
        || detailControllerRef.current !== detailController
        || generationRef.current !== generation) return;
      setState(current => ({ ...current, activeProject }));
    } catch (error) {
      if (!isAbort(error)
        && refreshControllerRef.current === controller
        && generationRef.current === generation) {
        setState(current => ({ ...current, error: clientError(error) }));
      }
    } finally {
      if (refreshControllerRef.current === controller && generationRef.current === generation) {
        refreshControllerRef.current = null;
        detailControllerRef.current = null;
        setState(current => ({ ...current, loading: false }));
      }
    }
  }, []);

  const create = useCallback(async (input: CreateProjectInput) => {
    const lifecycle = lifecycleRef.current;
    const project = await projectsApi.create(input);
    if (mountedRef.current && lifecycleRef.current === lifecycle) await refresh();
    return project;
  }, [refresh]);

  const update = useCallback(async (
    projectId: string,
    expectedRevision: number,
    patch: ProjectPatch,
  ) => {
    const lifecycle = lifecycleRef.current;
    const project = await projectsApi.update(projectId, expectedRevision, patch);
    if (mountedRef.current && lifecycleRef.current === lifecycle) await refresh();
    return project;
  }, [refresh]);

  const setActive = useCallback(async (projectId: string | null, expectedRevision: number) => {
    const lifecycle = lifecycleRef.current;
    const workspace = await projectsApi.setActive(projectId, expectedRevision);
    if (mountedRef.current && lifecycleRef.current === lifecycle) await refresh();
    return workspace;
  }, [refresh]);

  const remove = useCallback(async (projectId: string, expectedRevision: number) => {
    const lifecycle = lifecycleRef.current;
    await projectsApi.delete(projectId, expectedRevision);
    if (mountedRef.current && lifecycleRef.current === lifecycle) await refresh();
  }, [refresh]);

  useLayoutEffect(() => {
    mountedRef.current = true;
    lifecycleRef.current += 1;
    void refresh();
    return () => {
      mountedRef.current = false;
      lifecycleRef.current += 1;
      generationRef.current += 1;
      refreshControllerRef.current?.abort();
      detailControllerRef.current?.abort();
      refreshControllerRef.current = null;
      detailControllerRef.current = null;
    };
  }, [refresh]);

  return { ...state, refresh, create, update, setActive, remove };
}
