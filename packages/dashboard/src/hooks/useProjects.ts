/**
 * Custom hook for managing projects
 */

import { useState, useEffect, useCallback } from 'react';
import { projectsApi } from '../api/client';
import type { Project, CreateProjectRequest } from '../api/types';

interface UseProjectsReturn {
  projects: Project[];
  activeProjectId: string | undefined;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  createProject: (data: CreateProjectRequest) => Promise<Project>;
  activateProject: (id: string) => Promise<void>;
  deactivateProject: () => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
}

export function useProjects(): UseProjectsReturn {
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await projectsApi.list();
      setProjects(data.projects);
      setActiveProjectId(data.activeProjectId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load projects');
    } finally {
      setLoading(false);
    }
  }, []);

  const createProject = useCallback(async (data: CreateProjectRequest) => {
    const project = await projectsApi.create(data);

    // Optimistically update the list
    setProjects(prev => [project, ...prev]);

    // Refresh to get accurate state
    await refresh();

    return project;
  }, [refresh]);

  const activateProject = useCallback(async (id: string) => {
    await projectsApi.activate(id);
    setActiveProjectId(id);

    // Refresh to ensure consistency
    await refresh();
  }, [refresh]);

  const deactivateProject = useCallback(async () => {
    await projectsApi.deactivate();
    setActiveProjectId(undefined);

    // Refresh to ensure consistency
    await refresh();
  }, [refresh]);

  const deleteProject = useCallback(async (id: string) => {
    await projectsApi.delete(id);

    // Optimistically remove from list
    setProjects(prev => prev.filter(p => p.id !== id));

    if (activeProjectId === id) {
      setActiveProjectId(undefined);
    }

    // Refresh to ensure consistency
    await refresh();
  }, [activeProjectId, refresh]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return {
    projects,
    activeProjectId,
    loading,
    error,
    refresh,
    createProject,
    activateProject,
    deactivateProject,
    deleteProject,
  };
}
