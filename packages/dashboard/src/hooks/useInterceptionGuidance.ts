import { useCallback, useLayoutEffect, useRef, useState } from 'react';

import { interceptionGuidanceApi } from '../api/client';
import type { InterceptionGuidance } from '../api/types';

export interface UseInterceptionGuidanceResult {
  guidance?: InterceptionGuidance;
  loading: boolean;
  error?: string;
  refresh(): Promise<void>;
}

interface GuidanceState {
  owner: string;
  guidance?: InterceptionGuidance;
  loading: boolean;
  error?: string;
}

export function useInterceptionGuidance(
  projectId: string | undefined,
  discoveredOrigins: readonly string[],
): UseInterceptionGuidanceResult {
  const originsKey = JSON.stringify([...new Set(discoveredOrigins)].sort());
  const owner = `${projectId ?? ''}:${originsKey}`;
  const [state, setState] = useState<GuidanceState>({ owner, loading: false });
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  const controllerRef = useRef<AbortController | undefined>(undefined);
  const ownedState = state.owner === owner ? state : { owner, loading: false };

  const refresh = useCallback(async () => {
    controllerRef.current?.abort();
    if (!projectId) {
      setState({ owner, loading: false });
      return;
    }
    const controller = new AbortController();
    controllerRef.current = controller;
    setState(current => current.owner === owner
      ? { ...current, loading: true, error: undefined }
      : { owner, loading: true });
    try {
      const guidance = await interceptionGuidanceApi.get(
        projectId,
        JSON.parse(originsKey) as string[],
        controller.signal,
      );
      if (controllerRef.current !== controller || ownerRef.current !== owner) return;
      setState({ owner, guidance, loading: false });
    } catch (caught) {
      if (controllerRef.current !== controller
        || ownerRef.current !== owner
        || (caught instanceof Error && caught.name === 'AbortError')) return;
      setState({
        owner,
        loading: false,
        error: caught instanceof Error ? caught.message : 'Failed to load interception guidance',
      });
    } finally {
      if (controllerRef.current === controller) controllerRef.current = undefined;
    }
  }, [originsKey, owner, projectId]);

  useLayoutEffect(() => {
    void refresh();
    return () => {
      controllerRef.current?.abort();
      controllerRef.current = undefined;
    };
  }, [refresh]);

  return {
    guidance: ownedState.guidance,
    loading: ownedState.loading,
    error: ownedState.error,
    refresh,
  };
}
