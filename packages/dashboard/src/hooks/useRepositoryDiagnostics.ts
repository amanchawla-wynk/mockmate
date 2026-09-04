import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { ApiClientError, diagnosticsApi } from '../api/client';
import type { RepositoryDiagnostic } from '../api/types';

interface DiagnosticsState {
  projectId: string | undefined;
  generation: number;
  diagnostics: RepositoryDiagnostic[];
  loading: boolean;
  error?: ApiClientError;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function clientError(error: unknown): ApiClientError {
  if (error instanceof ApiClientError) return error;
  return new ApiClientError(
    0,
    'NETWORK_ERROR',
    error instanceof Error ? error.message : 'Failed to load repository diagnostics',
    '',
  );
}

export function useRepositoryDiagnostics(projectId?: string): {
  diagnostics: RepositoryDiagnostic[];
  loading: boolean;
  error?: ApiClientError;
  refresh(): Promise<void>;
} {
  const [state, setState] = useState<DiagnosticsState>({
    projectId,
    generation: 0,
    diagnostics: [],
    loading: false,
  });
  const controllerRef = useRef<AbortController | null>(null);

  if (state.projectId !== projectId) {
    setState({
      projectId,
      generation: state.generation + 1,
      diagnostics: [],
      loading: false,
    });
  }
  const generation = state.projectId === projectId ? state.generation : state.generation + 1;

  const refresh = useCallback(async () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setState(current => current.projectId === projectId && current.generation === generation
      ? { ...current, loading: true, error: undefined }
      : current);
    try {
      const result = projectId
        ? await diagnosticsApi.list(projectId, controller.signal)
        : await diagnosticsApi.listAll(controller.signal);
      if (controllerRef.current !== controller) return;
      setState(current => current.projectId === projectId && current.generation === generation
        ? { ...current, diagnostics: result.diagnostics }
        : current);
    } catch (error) {
      if (!isAbort(error) && controllerRef.current === controller) {
        setState(current => current.projectId === projectId && current.generation === generation
          ? { ...current, error: clientError(error) }
          : current);
      }
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
        setState(current => current.projectId === projectId && current.generation === generation
          ? { ...current, loading: false }
          : current);
      }
    }
  }, [generation, projectId]);

  useLayoutEffect(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    void refresh();
    return () => {
      controllerRef.current?.abort();
      controllerRef.current = null;
    };
  }, [generation, projectId, refresh]);

  const ownsState = state.projectId === projectId;
  return {
    diagnostics: ownsState ? state.diagnostics : [],
    loading: ownsState && state.loading,
    error: ownsState ? state.error : undefined,
    refresh,
  };
}
