import { useCallback, useEffect, useRef, useState } from 'react';

import { trafficApi, type ApiClientError } from '../api/client';
import type {
  TrafficJsonSearchResult,
  TrafficJsonSearchSkipped,
} from '../api/types';

export interface UseTrafficSearchReturn {
  query: string;
  setQuery(value: string): void;
  results: TrafficJsonSearchResult[];
  skipped: TrafficJsonSearchSkipped;
  activeQuery: string;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  hasMore: boolean;
  loadMore(): void;
  reset(): void;
}

interface UseTrafficSearchOptions {
  enabled?: boolean;
  debounceMs?: number;
}

function zeroSkipped(): TrafficJsonSearchSkipped {
  return {
    unavailable: 0,
    truncated: 0,
    evicted: 0,
    unsupportedEncoding: 0,
    invalidUtf8: 0,
    notJson: 0,
    changedDuringSearch: 0,
    searchBudgetExceeded: 0,
  };
}

function addSkipped(
  base: TrafficJsonSearchSkipped,
  next: TrafficJsonSearchSkipped,
): TrafficJsonSearchSkipped {
  return {
    unavailable: base.unavailable + next.unavailable,
    truncated: base.truncated + next.truncated,
    evicted: base.evicted + next.evicted,
    unsupportedEncoding: base.unsupportedEncoding + next.unsupportedEncoding,
    invalidUtf8: base.invalidUtf8 + next.invalidUtf8,
    notJson: base.notJson + next.notJson,
    changedDuringSearch: base.changedDuringSearch + next.changedDuringSearch,
    searchBudgetExceeded: base.searchBudgetExceeded + next.searchBudgetExceeded,
  };
}

interface SearchState {
  results: TrafficJsonSearchResult[];
  skipped: TrafficJsonSearchSkipped;
  activeQuery: string;
  cursor?: string;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
}

const IDLE: SearchState = {
  results: [],
  skipped: zeroSkipped(),
  activeQuery: '',
  loading: false,
  loadingMore: false,
  error: null,
};

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'Traffic search failed';
}

export function useTrafficSearch(
  projectId: string | undefined,
  options: UseTrafficSearchOptions = {},
): UseTrafficSearchReturn {
  const { enabled = true, debounceMs = 300 } = options;
  const [query, setQuery] = useState('');
  const [state, setState] = useState<SearchState>(IDLE);
  const generation = useRef(0);
  const controller = useRef<AbortController | undefined>(undefined);
  const owner = useRef(projectId);
  const cursor = useRef<string | undefined>(undefined);
  const sessionId = useRef<string | undefined>(undefined);

  // Releasing the ephemeral server session frees its slot before the idle TTL.
  const releaseSession = useCallback((releaseProjectId: string | undefined) => {
    const openSession = sessionId.current;
    sessionId.current = undefined;
    if (openSession === undefined || releaseProjectId === undefined) return;
    void trafficApi.deleteSearchSession(releaseProjectId, openSession).catch(() => undefined);
  }, []);

  const cancel = useCallback(() => {
    controller.current?.abort();
    controller.current = undefined;
  }, []);

  const run = useCallback(async (searchQuery: string, mode: 'reset' | 'more') => {
    if (!projectId) return;
    const activeOwner = generation.current += 1;
    cancel();
    const abort = new AbortController();
    controller.current = abort;
    setState(current => (mode === 'reset'
      ? { ...IDLE, activeQuery: searchQuery, loading: true }
      : { ...current, loadingMore: true, error: null }));
    try {
      const page = await trafficApi.search(
        projectId,
        { query: searchQuery, limit: 100, ...(mode === 'more' && cursor.current !== undefined ? { cursor: cursor.current } : {}) },
        abort.signal,
      );
      if (generation.current !== activeOwner || owner.current !== projectId) return;
      if (mode === 'reset' && sessionId.current !== undefined && sessionId.current !== page.searchSessionId) {
        releaseSession(projectId);
      }
      sessionId.current = page.searchSessionId;
      cursor.current = page.nextCursor;
      setState(current => {
        const previous = mode === 'reset' ? [] : current.results;
        const baseSkipped = mode === 'reset' ? zeroSkipped() : current.skipped;
        return {
          results: [...previous, ...page.results],
          skipped: addSkipped(baseSkipped, page.skipped),
          activeQuery: searchQuery,
          cursor: page.nextCursor,
          loading: false,
          loadingMore: false,
          error: null,
        };
      });
    } catch (error) {
      if (generation.current !== activeOwner || owner.current !== projectId) return;
      if (error instanceof Error && error.name === 'AbortError') return;
      const message = (error as ApiClientError).code === 'TRAFFIC_SEARCH_EXPIRED'
        ? 'Search results expired; run the search again.'
        : errorMessage(error);
      setState(current => ({ ...current, loading: false, loadingMore: false, error: message }));
    } finally {
      if (controller.current === abort) controller.current = undefined;
    }
  }, [cancel, projectId, releaseSession]);

  const reset = useCallback(() => {
    generation.current += 1;
    cancel();
    releaseSession(projectId);
    cursor.current = undefined;
    setQuery('');
    setState(IDLE);
  }, [cancel, projectId, releaseSession]);

  const loadMore = useCallback(() => {
    if (cursor.current === undefined || state.loading || state.loadingMore) return;
    void run(state.activeQuery, 'more');
  }, [run, state.activeQuery, state.loading, state.loadingMore]);

  // Reset when the Project changes so results never cross owners.
  useEffect(() => {
    if (owner.current === projectId) return;
    const previousOwner = owner.current;
    owner.current = projectId;
    generation.current += 1;
    cancel();
    releaseSession(previousOwner);
    cursor.current = undefined;
    setQuery('');
    setState(IDLE);
  }, [cancel, projectId, releaseSession]);

  // Debounced submit on query changes.
  useEffect(() => {
    const trimmed = query.trim();
    if (!enabled || !projectId) return;
    if (trimmed.length === 0) {
      generation.current += 1;
      cancel();
      cursor.current = undefined;
      // An empty query synchronizes the panel back to its idle state.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setState(IDLE);
      return;
    }
    const timer = window.setTimeout(() => { void run(trimmed, 'reset'); }, debounceMs);
    return () => window.clearTimeout(timer);
  }, [cancel, debounceMs, enabled, projectId, query, run]);

  useEffect(() => () => {
    cancel();
    releaseSession(owner.current);
  }, [cancel, releaseSession]);

  return {
    query,
    setQuery,
    results: state.results,
    skipped: state.skipped,
    activeQuery: state.activeQuery,
    loading: state.loading,
    loadingMore: state.loadingMore,
    error: state.error,
    hasMore: state.cursor !== undefined,
    loadMore,
    reset,
  };
}
