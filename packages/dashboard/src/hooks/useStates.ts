import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { ApiClientError, statesApi } from '../api/client';
import type { AppState, AppStateSummary } from '../api/types';

export interface UseStatesResult {
  states: AppStateSummary[];
  selectedState?: AppState;
  selectedStateId?: string;
  loading: boolean;
  detailLoading: boolean;
  error?: ApiClientError;
  selectState(id: string | undefined): void;
  beginStatePublication(): StatePublicationToken;
  publishState(publication: StatePublicationToken, state: AppState): boolean;
  refresh(): Promise<boolean>;
  reloadSelected(): Promise<boolean>;
}

export interface StatePublicationToken {
  readonly projectId: string | undefined;
  readonly selectedStateId: string | undefined;
  readonly projectGeneration: number;
  readonly detailGeneration: number;
}

interface StatesState {
  projectId: string | undefined;
  generation: number;
  states: AppStateSummary[];
  selectedState?: AppState;
  selectedStateId?: string;
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

export function useStates(projectId: string | undefined): UseStatesResult {
  const [state, setState] = useState<StatesState>({
    projectId,
    generation: 0,
    states: [],
    loading: false,
    detailLoading: false,
  });
  const listControllerRef = useRef<AbortController | null>(null);
  const detailControllerRef = useRef<AbortController | null>(null);
  const detailGenerationRef = useRef(0);

  if (state.projectId !== projectId) {
    setState({
      projectId,
      generation: state.generation + 1,
      states: [],
      loading: false,
      detailLoading: false,
    });
  }
  const generation = state.projectId === projectId ? state.generation : state.generation + 1;
  const detailOwnerRef = useRef<{
    projectId: string | undefined;
    generation: number;
    selectedStateId: string | undefined;
  }>({ projectId, generation, selectedStateId: undefined });
  detailOwnerRef.current = {
    projectId,
    generation,
    selectedStateId: state.projectId === projectId && state.generation === generation
      ? state.selectedStateId
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
      const states = await statesApi.list(projectId, controller.signal);
      if (listControllerRef.current !== controller) return false;
      setState(current => current.projectId === projectId && current.generation === generation
        ? { ...current, states }
        : current);
      return true;
    } catch (error) {
      if (!isAbort(error) && listControllerRef.current === controller) {
        setState(current => current.projectId === projectId && current.generation === generation
          ? { ...current, error: clientError(error, 'Failed to load states') }
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

  const selectState = useCallback((id: string | undefined) => {
    const owner = detailOwnerRef.current;
    if (owner.projectId !== projectId || owner.generation !== generation) return;
    detailOwnerRef.current = { ...owner, selectedStateId: id };
    detailGenerationRef.current += 1;
    detailControllerRef.current?.abort();
    detailControllerRef.current = null;
    setState(current => current.projectId === projectId && current.generation === generation
      ? {
          ...current,
          selectedStateId: id,
          selectedState: undefined,
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
    void statesApi.get(projectId, id, controller.signal)
      .then(selectedState => {
        if (detailControllerRef.current !== controller) return;
        setState(current => current.projectId === projectId && current.generation === generation
          ? { ...current, selectedState }
          : current);
      })
      .catch(error => {
        if (!isAbort(error) && detailControllerRef.current === controller) {
          setState(current => current.projectId === projectId && current.generation === generation
            ? { ...current, error: clientError(error, 'Failed to load state') }
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

  const reloadSelected = useCallback(async () => {
    const selectedStateId = state.projectId === projectId
      && state.generation === generation
      ? state.selectedStateId
      : undefined;
    const owner = detailOwnerRef.current;
    if (!projectId
      || !selectedStateId
      || owner.projectId !== projectId
      || owner.generation !== generation
      || owner.selectedStateId !== selectedStateId) return true;

    const requestGeneration = ++detailGenerationRef.current;
    detailControllerRef.current?.abort();
    const controller = new AbortController();
    detailControllerRef.current = controller;
    setState(current => current.projectId === projectId
      && current.generation === generation
      && current.selectedStateId === selectedStateId
      ? { ...current, detailLoading: true, error: undefined }
      : current);
    try {
      const selectedState = await statesApi.get(projectId, selectedStateId, controller.signal);
      if (detailControllerRef.current !== controller
        || detailGenerationRef.current !== requestGeneration) return false;
      setState(current => current.projectId === projectId
        && current.generation === generation
        && current.selectedStateId === selectedStateId
        ? { ...current, selectedState }
        : current);
      return true;
    } catch (error) {
      if (!isAbort(error) && detailControllerRef.current === controller) {
        setState(current => current.projectId === projectId
          && current.generation === generation
          && current.selectedStateId === selectedStateId
          ? { ...current, error: clientError(error, 'Failed to reload state') }
          : current);
      }
      return false;
    } finally {
      if (detailControllerRef.current === controller) {
        detailControllerRef.current = null;
        setState(current => current.projectId === projectId
          && current.generation === generation
          && current.selectedStateId === selectedStateId
          ? { ...current, detailLoading: false }
          : current);
      }
    }
  }, [generation, projectId, state.generation, state.projectId, state.selectedStateId]);

  const beginStatePublication = useCallback((): StatePublicationToken => {
    const owner = detailOwnerRef.current;
    return {
      projectId: owner.projectId,
      selectedStateId: owner.selectedStateId,
      projectGeneration: owner.generation,
      detailGeneration: detailGenerationRef.current,
    };
  }, []);

  const publishState = useCallback((publication: StatePublicationToken, selectedState: AppState): boolean => {
    const owner = detailOwnerRef.current;
    if (
      !owner.projectId
      || selectedState.projectId !== owner.projectId
      || selectedState.id !== owner.selectedStateId
      || publication.projectId !== owner.projectId
      || publication.selectedStateId !== owner.selectedStateId
      || publication.projectGeneration !== owner.generation
      || publication.detailGeneration !== detailGenerationRef.current
    ) return false;

    detailControllerRef.current?.abort();
    detailControllerRef.current = null;
    setState(current => current.projectId === owner.projectId && current.generation === owner.generation
      ? {
          ...current,
          selectedState,
          selectedStateId: selectedState.id,
          detailLoading: false,
          error: undefined,
        }
      : current);
    return true;
  }, []);

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
    states: ownsState ? state.states : [],
    selectedState: ownsState ? state.selectedState : undefined,
    selectedStateId: ownsState ? state.selectedStateId : undefined,
    loading: ownsState && state.loading,
    detailLoading: ownsState && state.detailLoading,
    error: ownsState ? state.error : undefined,
    selectState,
    beginStatePublication,
    publishState,
    refresh,
    reloadSelected,
  };
}
