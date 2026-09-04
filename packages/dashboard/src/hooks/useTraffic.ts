import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { trafficApi, type ApiClientError } from '../api/client';
import type { TrafficDetail, TrafficSummary } from '../api/types';

export interface UseTrafficReturn {
  entries: TrafficSummary[];
  selected: TrafficDetail | null;
  detailLoading: boolean;
  loading: boolean;
  clearing: boolean;
  error: ApiClientError | Error | null;
  paused: boolean;
  setPaused(value: boolean): void;
  select(trafficId: string | null): void;
  refresh(): Promise<boolean>;
  refreshSelected(): Promise<TrafficDetail | null>;
  clear(): Promise<boolean>;
}

interface UseTrafficOptions {
  enabled?: boolean;
  pollIntervalMs?: number;
}

interface TrafficState {
  generation: number;
  entries: TrafficSummary[];
  selected: TrafficDetail | null;
  loading: boolean;
  detailLoading: boolean;
  clearing: boolean;
  listError: Error | null;
  detailError: Error | null;
  clearError: Error | null;
}

interface ProjectOwner {
  projectId: string | undefined;
  generation: number;
}

interface OperationOwner {
  project: ProjectOwner;
  controller: AbortController;
}

function operationError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
}

export function useTraffic(
  projectId: string | undefined,
  options: UseTrafficOptions = {},
): UseTrafficReturn {
  const { enabled = true, pollIntervalMs = 1000 } = options;
  const generation = useRef(0);
  const projectOwner = useRef<ProjectOwner>({ projectId, generation: 0 });
  const committedEnabled = useRef(enabled);
  const cursor = useRef<string | undefined>(undefined);
  const selectedId = useRef<string | null>(null);
  const [state, setState] = useState<TrafficState>({
    generation: 0,
    entries: [],
    selected: null,
    loading: false,
    detailLoading: false,
    clearing: false,
    listError: null,
    detailError: null,
    clearError: null,
  });
  const [paused, setPaused] = useState(false);
  const listOperation = useRef<OperationOwner | undefined>(undefined);
  const detailOperation = useRef<OperationOwner | undefined>(undefined);
  const clearOperation = useRef<OperationOwner | undefined>(undefined);

  const refresh = useCallback(async (): Promise<boolean> => {
    const operationOwner = projectOwner.current;
    if (!projectId
      || !enabled
      || operationOwner.projectId !== projectId
      || listOperation.current?.project === operationOwner
      || clearOperation.current?.project === operationOwner) return false;
    const controller = new AbortController();
    const operation = { project: operationOwner, controller };
    listOperation.current = operation;
    setState(current => current.generation === operationOwner.generation
      ? { ...current, loading: true }
      : current);
    try {
      const page = await trafficApi.list(
        projectId,
        { ...(cursor.current === undefined ? {} : { afterId: cursor.current }), limit: 100 },
        controller.signal,
      );
      if (listOperation.current !== operation || projectOwner.current !== operationOwner) return false;
      if (page.reset) cursor.current = page.latestId;
      else if (page.latestId !== undefined) cursor.current = page.latestId;
      const retainedIds = page.reset ? new Set(page.entries.map(entry => entry.id)) : undefined;
      if (retainedIds !== undefined
        && selectedId.current !== null
        && !retainedIds.has(selectedId.current)) {
        selectedId.current = null;
        detailOperation.current?.controller.abort();
        detailOperation.current = undefined;
      }
      setState(current => {
        if (current.generation !== operationOwner.generation) return current;
        const entries = page.reset
          ? page.entries
          : (() => {
            const merged = new Map(current.entries.map(entry => [entry.id, entry]));
            for (const entry of page.entries) merged.set(entry.id, entry);
            return [...merged.values()];
          })();
        return {
          ...current,
          entries,
          selected: retainedIds !== undefined
            && current.selected !== null
            && !retainedIds.has(current.selected.id)
            ? null
            : current.selected,
          detailLoading: retainedIds !== undefined && selectedId.current === null
            ? false
            : current.detailLoading,
          detailError: retainedIds !== undefined && selectedId.current === null
            ? null
            : current.detailError,
          listError: null,
        };
      });
      return true;
    } catch (error) {
      if (listOperation.current === operation
        && projectOwner.current === operationOwner
        && !(error instanceof Error && error.name === 'AbortError')) {
        setState(current => current.generation === operationOwner.generation
          ? { ...current, listError: operationError(error, 'Failed to load Traffic') }
          : current);
      }
      return false;
    } finally {
      if (listOperation.current === operation && projectOwner.current === operationOwner) {
        listOperation.current = undefined;
        setState(current => current.generation === operationOwner.generation
          ? { ...current, loading: false }
          : current);
      }
    }
  }, [enabled, projectId]);

  const loadDetail = useCallback(async (
    trafficId: string,
    operationOwner: ProjectOwner,
  ): Promise<TrafficDetail | null> => {
    if (!projectId || operationOwner.projectId !== projectId || selectedId.current !== trafficId) return null;
    detailOperation.current?.controller.abort();
    const controller = new AbortController();
    const operation = { project: operationOwner, controller };
    detailOperation.current = operation;
    setState(current => current.generation === operationOwner.generation
      ? { ...current, detailLoading: true, detailError: null }
      : current);
    try {
      const detail = await trafficApi.detail(projectId, trafficId, controller.signal);
      if (detailOperation.current !== operation
        || projectOwner.current !== operationOwner
        || selectedId.current !== trafficId) return null;
      setState(current => current.generation === operationOwner.generation
        ? { ...current, selected: detail, detailError: null }
        : current);
      return detail;
    } catch (error) {
      if (detailOperation.current === operation
        && projectOwner.current === operationOwner
        && selectedId.current === trafficId
        && !(error instanceof Error && error.name === 'AbortError')) {
        setState(current => current.generation === operationOwner.generation
          ? { ...current, detailError: operationError(error, 'Failed to load Traffic detail') }
          : current);
      }
      return null;
    } finally {
      if (detailOperation.current === operation && projectOwner.current === operationOwner) {
        detailOperation.current = undefined;
        setState(current => current.generation === operationOwner.generation
          ? { ...current, detailLoading: false }
          : current);
      }
    }
  }, [projectId]);

  const refreshSelected = useCallback((): Promise<TrafficDetail | null> => {
    const operationOwner = projectOwner.current;
    const trafficId = selectedId.current;
    if (trafficId === null) return Promise.resolve(null);
    return loadDetail(trafficId, operationOwner);
  }, [loadDetail]);

  const select = useCallback((trafficId: string | null) => {
    const operationOwner = projectOwner.current;
    if (operationOwner.projectId !== projectId) return;
    detailOperation.current?.controller.abort();
    detailOperation.current = undefined;
    selectedId.current = trafficId;
    setState(current => current.generation === operationOwner.generation
      ? { ...current, selected: null, detailLoading: false, detailError: null }
      : current);
    if (trafficId !== null) void loadDetail(trafficId, operationOwner);
  }, [loadDetail, projectId]);

  const clear = useCallback(async (): Promise<boolean> => {
    const operationOwner = projectOwner.current;
    if (!projectId
      || operationOwner.projectId !== projectId
      || clearOperation.current?.project === operationOwner) return false;
    const controller = new AbortController();
    const operation = { project: operationOwner, controller };
    clearOperation.current = operation;
    listOperation.current?.controller.abort();
    detailOperation.current?.controller.abort();
    listOperation.current = undefined;
    detailOperation.current = undefined;
    selectedId.current = null;
    setState(current => current.generation === operationOwner.generation
      ? {
        ...current,
        loading: false,
        clearing: true,
        listError: null,
        detailError: null,
        clearError: null,
        selected: null,
        detailLoading: false,
      }
      : current);
    try {
      await trafficApi.clear(projectId, controller.signal);
      if (clearOperation.current !== operation || projectOwner.current !== operationOwner) return false;
      cursor.current = undefined;
      setState(current => current.generation === operationOwner.generation
        ? { ...current, entries: [], selected: null }
        : current);
      return true;
    } catch (error) {
      if (clearOperation.current === operation
        && projectOwner.current === operationOwner
        && !(error instanceof Error && error.name === 'AbortError')) {
        setState(current => current.generation === operationOwner.generation
          ? { ...current, clearError: operationError(error, 'Failed to clear Traffic') }
          : current);
      }
      return false;
    } finally {
      if (clearOperation.current === operation && projectOwner.current === operationOwner) {
        clearOperation.current = undefined;
        setState(current => current.generation === operationOwner.generation
          ? { ...current, clearing: false }
          : current);
      }
    }
  }, [projectId]);

  useLayoutEffect(() => {
    const projectChanged = projectOwner.current.projectId !== projectId;
    const enabledChanged = committedEnabled.current !== enabled;
    let operationOwner = projectOwner.current;
    if (projectChanged) {
      operationOwner = { projectId, generation: generation.current += 1 };
      projectOwner.current = operationOwner;
      cursor.current = undefined;
      selectedId.current = null;
    }
    committedEnabled.current = enabled;
    if (projectChanged || enabledChanged) {
      const operations = [listOperation.current, detailOperation.current, clearOperation.current];
      listOperation.current = undefined;
      detailOperation.current = undefined;
      clearOperation.current = undefined;
      for (const operation of operations) operation?.controller.abort();
    }
    if (projectChanged) {
      setState({
        generation: operationOwner.generation,
        entries: [],
        selected: null,
        loading: false,
        detailLoading: false,
        clearing: false,
        listError: null,
        detailError: null,
        clearError: null,
      });
    } else if (enabledChanged) {
      setState(current => ({
        ...current,
        loading: false,
        detailLoading: false,
        clearing: false,
      }));
    }
    if (projectId && enabled) void refresh();
  }, [enabled, projectId, refresh]);

  useLayoutEffect(() => () => {
    const operations = [listOperation.current, detailOperation.current, clearOperation.current];
    listOperation.current = undefined;
    detailOperation.current = undefined;
    clearOperation.current = undefined;
    for (const operation of operations) operation?.controller.abort();
  }, []);

  useEffect(() => {
    if (!projectId || !enabled || paused) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') void refresh();
    }, pollIntervalMs);
    return () => window.clearInterval(timer);
  }, [enabled, paused, pollIntervalMs, projectId, refresh]);

  return {
    entries: state.entries,
    selected: state.selected,
    detailLoading: state.detailLoading,
    loading: state.loading,
    clearing: state.clearing,
    error: state.detailError ?? state.clearError ?? state.listError,
    paused,
    setPaused,
    select,
    refresh,
    refreshSelected,
    clear,
  };
}
