import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { ApiClientError, endpointsApi } from '../api/client';
import type { EndpointDetail, EndpointSummary } from '../api/types';

export interface UseEndpointsResult {
  endpoints: EndpointSummary[];
  selectedEndpoint?: EndpointDetail;
  selectedEndpointId?: string;
  loading: boolean;
  detailLoading: boolean;
  error?: ApiClientError;
  selectEndpoint(id: string | undefined): void;
  beginEndpointPublication(): EndpointPublicationToken;
  publishEndpoint(publication: EndpointPublicationToken, endpoint: EndpointDetail): boolean;
  refresh(): Promise<boolean>;
  reloadSelected(): Promise<boolean>;
}

export interface EndpointPublicationToken {
  readonly projectId: string | undefined;
  readonly selectedEndpointId: string | undefined;
  readonly projectGeneration: number;
  readonly detailGeneration: number;
}

interface EndpointsState {
  projectId: string | undefined;
  generation: number;
  endpoints: EndpointSummary[];
  selectedEndpoint?: EndpointDetail;
  selectedEndpointId?: string;
  loading: boolean;
  detailLoading: boolean;
  error?: ApiClientError;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function clientError(error: unknown, message: string): ApiClientError {
  if (error instanceof ApiClientError) return error;
  return new ApiClientError(0, 'NETWORK_ERROR', error instanceof Error ? error.message : message, '');
}

export function useEndpoints(projectId: string | undefined): UseEndpointsResult {
  const [state, setState] = useState<EndpointsState>({
    projectId,
    generation: 0,
    endpoints: [],
    loading: false,
    detailLoading: false,
  });
  const listControllerRef = useRef<AbortController | null>(null);
  const detailControllerRef = useRef<AbortController | null>(null);

  if (state.projectId !== projectId) {
    setState({
      projectId,
      generation: state.generation + 1,
      endpoints: [],
      loading: false,
      detailLoading: false,
    });
  }
  const generation = state.projectId === projectId ? state.generation : state.generation + 1;
  const detailOwnerRef = useRef<{
    projectId: string | undefined;
    generation: number;
    detailGeneration: number;
    selectedEndpointId: string | undefined;
  }>({ projectId, generation, detailGeneration: 0, selectedEndpointId: undefined });
  detailOwnerRef.current = {
    projectId,
    generation,
    detailGeneration: detailOwnerRef.current.detailGeneration,
    selectedEndpointId: state.projectId === projectId && state.generation === generation
      ? state.selectedEndpointId
      : undefined,
  };

  const refresh = useCallback(async () => {
    listControllerRef.current?.abort();
    listControllerRef.current = null;
    if (!projectId) return true;

    const controller = new AbortController();
    listControllerRef.current = controller;
    setState(current => current.projectId === projectId && current.generation === generation
      ? { ...current, loading: true, error: undefined }
      : current);
    try {
      const endpoints = await endpointsApi.list(projectId, controller.signal);
      if (listControllerRef.current !== controller) return false;
      setState(current => current.projectId === projectId && current.generation === generation
        ? { ...current, endpoints }
        : current);
      return true;
    } catch (error) {
      if (!isAbort(error) && listControllerRef.current === controller) {
        setState(current => current.projectId === projectId && current.generation === generation
          ? { ...current, error: clientError(error, 'Failed to load endpoints') }
          : current);
      }
      return false;
    } finally {
      if (listControllerRef.current === controller) {
        listControllerRef.current = null;
        setState(current => current.projectId === projectId && current.generation === generation
          ? { ...current, loading: false }
          : current);
      }
    }
  }, [generation, projectId]);

  const selectEndpoint = useCallback((id: string | undefined) => {
    const owner = detailOwnerRef.current;
    if (owner.projectId !== projectId || owner.generation !== generation) return;
    detailOwnerRef.current = {
      ...owner,
      detailGeneration: owner.detailGeneration + 1,
      selectedEndpointId: id,
    };
    detailControllerRef.current?.abort();
    detailControllerRef.current = null;
    setState(current => current.projectId === projectId && current.generation === generation
      ? {
          ...current,
          selectedEndpointId: id,
          selectedEndpoint: undefined,
          detailLoading: false,
          error: undefined,
        }
      : current);
    if (!projectId || !id) return;

    const controller = new AbortController();
    detailControllerRef.current = controller;
    setState(current => current.projectId === projectId && current.generation === generation
      ? { ...current, detailLoading: true }
      : current);
    void endpointsApi.get(projectId, id, controller.signal)
      .then(selectedEndpoint => {
        if (detailControllerRef.current !== controller) return;
        setState(current => current.projectId === projectId && current.generation === generation
          ? { ...current, selectedEndpoint }
          : current);
      })
      .catch(error => {
        if (!isAbort(error) && detailControllerRef.current === controller) {
          setState(current => current.projectId === projectId && current.generation === generation
            ? { ...current, error: clientError(error, 'Failed to load endpoint') }
            : current);
        }
      })
      .finally(() => {
        if (detailControllerRef.current === controller) {
          detailControllerRef.current = null;
          setState(current => current.projectId === projectId && current.generation === generation
            ? { ...current, detailLoading: false }
            : current);
        }
      });
  }, [generation, projectId]);

  const beginEndpointPublication = useCallback((): EndpointPublicationToken => {
    const owner = detailOwnerRef.current;
    return {
      projectId: owner.projectId,
      selectedEndpointId: owner.selectedEndpointId,
      projectGeneration: owner.generation,
      detailGeneration: owner.detailGeneration,
    };
  }, []);

  const publishEndpoint = useCallback((publication: EndpointPublicationToken, endpoint: EndpointDetail): boolean => {
    const owner = detailOwnerRef.current;
    if (
      !owner.projectId
      || endpoint.projectId !== owner.projectId
      || publication.projectId !== owner.projectId
      || publication.projectGeneration !== owner.generation
      || publication.detailGeneration !== owner.detailGeneration
      || publication.selectedEndpointId !== owner.selectedEndpointId
      || (publication.selectedEndpointId !== undefined && publication.selectedEndpointId !== endpoint.id)
    ) return false;
    detailControllerRef.current?.abort();
    detailControllerRef.current = null;
    detailOwnerRef.current = { ...owner, selectedEndpointId: endpoint.id };
    setState(current => current.projectId === owner.projectId && current.generation === owner.generation
      ? {
          ...current,
          selectedEndpointId: endpoint.id,
          selectedEndpoint: endpoint,
          detailLoading: false,
          error: undefined,
        }
      : current);
    return true;
  }, []);

  const reloadSelected = useCallback(async () => {
    const publication = beginEndpointPublication();
    if (!projectId
      || !publication.selectedEndpointId
      || publication.projectId !== projectId
      || publication.projectGeneration !== generation) return true;

    detailControllerRef.current?.abort();
    const controller = new AbortController();
    detailControllerRef.current = controller;
    setState(current => current.projectId === publication.projectId
      && current.generation === publication.projectGeneration
      && current.selectedEndpointId === publication.selectedEndpointId
      ? { ...current, detailLoading: true, error: undefined }
      : current);
    try {
      const endpoint = await endpointsApi.get(
        projectId,
        publication.selectedEndpointId,
        controller.signal,
      );
      if (detailControllerRef.current !== controller) return false;
      return publishEndpoint(publication, endpoint);
    } catch (error) {
      if (!isAbort(error) && detailControllerRef.current === controller) {
        setState(current => current.projectId === publication.projectId
          && current.generation === publication.projectGeneration
          && current.selectedEndpointId === publication.selectedEndpointId
          ? { ...current, error: clientError(error, 'Failed to reload endpoint') }
          : current);
      }
      return false;
    } finally {
      if (detailControllerRef.current === controller) {
        detailControllerRef.current = null;
        setState(current => current.projectId === publication.projectId
          && current.generation === publication.projectGeneration
          && current.selectedEndpointId === publication.selectedEndpointId
          ? { ...current, detailLoading: false }
          : current);
      }
    }
  }, [beginEndpointPublication, generation, projectId, publishEndpoint]);

  useLayoutEffect(() => {
    listControllerRef.current?.abort();
    detailControllerRef.current?.abort();
    listControllerRef.current = null;
    detailControllerRef.current = null;
    if (projectId) void refresh();
    return () => {
      listControllerRef.current?.abort();
      detailControllerRef.current?.abort();
      listControllerRef.current = null;
      detailControllerRef.current = null;
    };
  }, [generation, projectId, refresh]);

  const ownsState = state.projectId === projectId;
  return {
    endpoints: ownsState ? state.endpoints : [],
    selectedEndpoint: ownsState ? state.selectedEndpoint : undefined,
    selectedEndpointId: ownsState ? state.selectedEndpointId : undefined,
    loading: ownsState && state.loading,
    detailLoading: ownsState && state.detailLoading,
    error: ownsState ? state.error : undefined,
    selectEndpoint,
    beginEndpointPublication,
    publishEndpoint,
    refresh,
    reloadSelected,
  };
}
