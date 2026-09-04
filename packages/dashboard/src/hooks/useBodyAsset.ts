import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { ApiClientError, bodiesApi } from '../api/client';

export interface UseBodyAssetResult {
  assetId?: string;
  response?: Response;
  loading: boolean;
  error?: ApiClientError;
  open(assetId: string): Promise<Response>;
  close(): void;
}

interface BodyState {
  projectId: string | undefined;
  generation: number;
  assetId?: string;
  response?: Response;
  loading: boolean;
  error?: ApiClientError;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function clientError(error: unknown, message: string): ApiClientError {
  if (error instanceof ApiClientError) return error;
  return new ApiClientError(0, 'NETWORK_ERROR', error instanceof Error ? error.message : message, '');
}

export function useBodyAsset(projectId: string | undefined): UseBodyAssetResult {
  const [state, setState] = useState<BodyState>({
    projectId,
    generation: 0,
    loading: false,
  });
  const controllerRef = useRef<AbortController | null>(null);

  if (state.projectId !== projectId) {
    setState({
      projectId,
      generation: state.generation + 1,
      loading: false,
    });
  }
  const generation = state.projectId === projectId ? state.generation : state.generation + 1;

  const open = useCallback(async (assetId: string): Promise<Response> => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    if (!projectId) {
      throw new ApiClientError(0, 'NO_ACTIVE_PROJECT', 'No active Project', '');
    }

    const controller = new AbortController();
    controllerRef.current = controller;
    setState(current => current.projectId === projectId && current.generation === generation
      ? { ...current, assetId, response: undefined, loading: true, error: undefined }
      : current);
    try {
      const response = await bodiesApi.download(projectId, assetId, controller.signal);
      if (controllerRef.current === controller) {
        setState(current => current.projectId === projectId && current.generation === generation
          ? { ...current, response }
          : current);
      }
      return response;
    } catch (error) {
      if (!isAbort(error) && controllerRef.current === controller) {
        setState(current => current.projectId === projectId && current.generation === generation
          ? { ...current, error: clientError(error, 'Failed to download body') }
          : current);
      }
      throw error;
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
        setState(current => current.projectId === projectId && current.generation === generation
          ? { ...current, loading: false }
          : current);
      }
    }
  }, [generation, projectId]);

  const close = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setState(current => current.projectId === projectId && current.generation === generation
      ? { ...current, assetId: undefined, response: undefined, loading: false, error: undefined }
      : current);
  }, [generation, projectId]);

  useLayoutEffect(() => () => {
    controllerRef.current?.abort();
    controllerRef.current = null;
  }, [generation, projectId]);

  const ownsState = state.projectId === projectId;
  return {
    assetId: ownsState ? state.assetId : undefined,
    response: ownsState ? state.response : undefined,
    loading: ownsState && state.loading,
    error: ownsState ? state.error : undefined,
    open,
    close,
  };
}
