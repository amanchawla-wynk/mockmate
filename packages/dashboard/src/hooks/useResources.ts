/**
 * Custom hook for managing resources within a project
 */

import { useState, useEffect, useCallback } from 'react';
import { resourcesApi } from '../api/client';
import type { Resource, CreateResourceRequest, UpdateResourceRequest } from '../api/types';

interface UseResourcesReturn {
  resources: Resource[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  createResource: (data: CreateResourceRequest) => Promise<Resource>;
  updateResource: (id: string, data: UpdateResourceRequest) => Promise<Resource>;
  deleteResource: (id: string) => Promise<void>;
}

export function useResources(projectId: string | undefined): UseResourcesReturn {
  const [resources, setResources] = useState<Resource[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!projectId) {
      setResources([]);
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      setError(null);
      const data = await resourcesApi.list(projectId);
      setResources(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load resources');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  const createResource = useCallback(async (data: CreateResourceRequest) => {
    if (!projectId) {
      throw new Error('No active project');
    }

    const resource = await resourcesApi.create(projectId, data);

    // Optimistically add to list
    setResources(prev => [...prev, resource]);

    // Refresh to ensure consistency
    await refresh();

    return resource;
  }, [projectId, refresh]);

  const updateResource = useCallback(async (id: string, data: UpdateResourceRequest) => {
    if (!projectId) {
      throw new Error('No active project');
    }

    const updated = await resourcesApi.update(projectId, id, data);

    // Optimistically update in list
    setResources(prev => prev.map(r => r.id === id ? updated : r));

    // Refresh to ensure consistency
    await refresh();

    return updated;
  }, [projectId, refresh]);

  const deleteResource = useCallback(async (id: string) => {
    if (!projectId) {
      throw new Error('No active project');
    }

    await resourcesApi.delete(projectId, id);

    // Optimistically remove from list
    setResources(prev => prev.filter(r => r.id !== id));

    // Refresh to ensure consistency
    await refresh();
  }, [projectId, refresh]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return {
    resources,
    loading,
    error,
    refresh,
    createResource,
    updateResource,
    deleteResource,
  };
}
