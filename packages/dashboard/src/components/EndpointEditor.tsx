import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react';
import { ApiClientError, endpointsApi, variantsApi } from '../api/client';
import type {
  CreateVariantInput,
  EndpointDeletionImpact,
  EndpointDetail,
  EndpointMode,
  HttpMethod,
  MatchExpression,
  Project,
  ResponseVariant,
  VariantDeletionImpact,
} from '../api/types';
import { NewVariantDialog, type NewVariantDialogResult } from './NewVariantDialog';
import { ConfirmDialog } from './ConfirmDialog';
import { VariantEditor } from './VariantEditor';
import { VariantDeleteDialog, type VariantDeleteDialogResult } from './VariantDeleteDialog';

export interface EndpointEditorProps {
  projectId: string;
  project?: Project;
  endpoint?: EndpointDetail;
  onEndpointSaveStarted(): (endpoint: EndpointDetail) => boolean;
  onSaved(endpoint: EndpointDetail): void;
  onDeleted(endpointId: string): void;
  onClose(): void;
  onDirtyChange?(key: string, dirty: boolean, discard?: () => void): void;
  onAttemptNavigation?(action: () => void, draftKeys: string[]): void;
}

function encodeDomIdComponent(stableId: string): string {
  let encoded = '';
  for (let index = 0; index < stableId.length; index += 1) {
    encoded += stableId.charCodeAt(index).toString(16).padStart(4, '0');
  }
  return `u${stableId.length}-${encoded}`;
}

interface MatcherRow {
  id: string;
  name: string;
  operator: MatchExpression['operator'];
  value: string;
}

function queryRows(endpoint?: EndpointDetail): MatcherRow[] {
  let index = 0;
  return Object.entries(endpoint?.matcher.query ?? {}).flatMap(([name, expressions]) => (
    expressions.map(expression => ({ id: `query-${index++}`, name, ...expression }))
  ));
}

function headerRows(endpoint?: EndpointDetail): MatcherRow[] {
  return Object.entries(endpoint?.matcher.headers ?? {}).map(([name, expression], index) => ({
    id: `header-${index}`, name, ...expression,
  }));
}

function comparableRows(rows: MatcherRow[]) {
  return rows.map(({ name, operator, value }) => ({ name, operator, value }));
}

export function EndpointEditor({ projectId, project, endpoint, onEndpointSaveStarted, onSaved, onDeleted, onClose, onDirtyChange, onAttemptNavigation }: EndpointEditorProps) {
  const [currentEndpoint, setCurrentEndpoint] = useState(endpoint);
  const [name, setName] = useState(endpoint?.name ?? '');
  const [description, setDescription] = useState(endpoint?.description ?? '');
  const [method, setMethod] = useState(endpoint?.matcher.method ?? 'GET');
  const [baseUrl, setBaseUrl] = useState(endpoint?.baseUrl ?? '');
  const [mode, setMode] = useState<EndpointMode>(endpoint?.mode ?? 'mock');
  const [queryMatchers, setQueryMatchers] = useState(() => queryRows(endpoint));
  const [headerMatchers, setHeaderMatchers] = useState(() => headerRows(endpoint));
  const matcherRowId = useRef(0);
  const [requestPath, setRequestPath] = useState(endpoint?.matcher.path ?? '/');
  const [selectedVariantId, setSelectedVariantId] = useState(endpoint?.defaultVariantId);
  const [error, setError] = useState<string>();
  const [serverRevision, setServerRevision] = useState<number>();
  const [newVariantOpen, setNewVariantOpen] = useState(false);
  const [newVariantSource, setNewVariantSource] = useState<ResponseVariant>();
  const [deleteRequest, setDeleteRequest] = useState<{
    variant: ResponseVariant;
    impact: VariantDeletionImpact;
  }>();
  const [endpointDeleteImpact, setEndpointDeleteImpact] = useState<EndpointDeletionImpact>();
  const [structuralLoading, setStructuralLoading] = useState(false);
  const [refreshingCanonical, setRefreshingCanonical] = useState<'endpoint' | 'variant'>();
  const [postCommitRecovery, setPostCommitRecovery] = useState<{
    preferredVariantId?: string;
    adoptEndpointFields: boolean;
  }>();
  const [refreshingRecovery, setRefreshingRecovery] = useState(false);
  const [saveOwner, setSaveOwner] = useState<'endpoint' | 'variant'>();
  const saveOwnerRef = useRef<'endpoint' | 'variant' | undefined>(undefined);
  const modeOperationRef = useRef<object | undefined>(undefined);
  const mountedRef = useRef(true);
  const currentEndpointIdRef = useRef(currentEndpoint?.id);
  const currentEndpointRevisionRef = useRef(currentEndpoint?.revision);
  const dirtyVariantKey = useRef<string | undefined>(undefined);
  const key = `endpoint:${projectId}:${currentEndpoint?.id ?? 'new'}:${currentEndpoint?.revision ?? 0}`;
  const dirty = name !== (currentEndpoint?.name ?? '')
    || description !== (currentEndpoint?.description ?? '')
    || method !== (currentEndpoint?.matcher.method ?? 'GET')
    || baseUrl !== (currentEndpoint?.baseUrl ?? '')
    || (!currentEndpoint && mode !== 'mock')
    || JSON.stringify(comparableRows(queryMatchers)) !== JSON.stringify(comparableRows(queryRows(currentEndpoint)))
    || JSON.stringify(comparableRows(headerMatchers)) !== JSON.stringify(comparableRows(headerRows(currentEndpoint)))
    || requestPath !== (currentEndpoint?.matcher.path ?? '/');
  const adoptCanonicalEndpoint = useEffectEvent((nextEndpoint: EndpointDetail, adoptFields: boolean) => {
    setCurrentEndpoint(nextEndpoint);
    if (adoptFields) {
      setName(nextEndpoint.name);
      setDescription(nextEndpoint.description ?? '');
      setMethod(nextEndpoint.matcher.method);
      setBaseUrl(nextEndpoint.baseUrl);
      setMode(nextEndpoint.mode);
      setQueryMatchers(queryRows(nextEndpoint));
      setHeaderMatchers(headerRows(nextEndpoint));
      setRequestPath(nextEndpoint.matcher.path);
    }
    setSelectedVariantId(current => nextEndpoint.variants.some(variant => variant.id === current)
      ? current
      : nextEndpoint.defaultVariantId);
  });

  useLayoutEffect(() => {
    if (!endpoint
      || !currentEndpoint
      || endpoint.id !== currentEndpoint.id
      || endpoint.revision <= currentEndpoint.revision) return;
    const adoptEndpointFields = !dirty;
    // Canonical revisions intentionally synchronize local editor state while preserving dirty fields.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    adoptCanonicalEndpoint(endpoint, adoptEndpointFields);
  }, [currentEndpoint, dirty, endpoint]);

  const discardEndpoint = () => {
    setName(currentEndpoint?.name ?? '');
    setDescription(currentEndpoint?.description ?? '');
    setMethod(currentEndpoint?.matcher.method ?? 'GET');
    setBaseUrl(currentEndpoint?.baseUrl ?? '');
    setMode(currentEndpoint?.mode ?? 'mock');
    setQueryMatchers(queryRows(currentEndpoint));
    setHeaderMatchers(headerRows(currentEndpoint));
    setRequestPath(currentEndpoint?.matcher.path ?? '/');
    setError(undefined);
    setServerRevision(undefined);
  };
  const clearDirtyRegistration = useEffectEvent((draftKey: string) => {
    onDirtyChange?.(draftKey, false);
  });
  const reportDirty = useEffectEvent(() => {
    onDirtyChange?.(key, dirty, discardEndpoint);
  });

  useEffect(() => () => clearDirtyRegistration(key), [key]);
  useEffect(() => reportDirty(), [dirty, key]);
  useLayoutEffect(() => {
    currentEndpointIdRef.current = currentEndpoint?.id;
    currentEndpointRevisionRef.current = currentEndpoint?.revision;
  }, [currentEndpoint?.id, currentEndpoint?.revision]);
  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const acquireSaveOwnership = (owner: 'endpoint' | 'variant') => {
    if (saveOwnerRef.current || structuralLoading || postCommitRecovery) return undefined;
    saveOwnerRef.current = owner;
    setSaveOwner(owner);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (saveOwnerRef.current !== owner) return;
      saveOwnerRef.current = undefined;
      if (mountedRef.current) setSaveOwner(undefined);
    };
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    const releaseSaveOwnership = acquireSaveOwnership('endpoint');
    if (!releaseSaveOwnership) return;
    setError(undefined);
    setServerRevision(undefined);
    const completeSave = onEndpointSaveStarted();
    try {
      const matcher = {
        method,
        path: requestPath,
        ...(queryMatchers.length ? {
          query: queryMatchers.reduce<Record<string, MatchExpression[]>>((result, row) => {
            const name = row.name.trim();
            if (name) (result[name] ??= []).push({ operator: row.operator, value: row.value });
            return result;
          }, {}),
        } : {}),
        ...(headerMatchers.length ? {
          headers: Object.fromEntries(headerMatchers.map(row => [
            row.name.trim().toLowerCase(),
            { operator: row.operator, value: row.value },
          ]).filter(([name]) => name)),
        } : {}),
      };
      const saved = currentEndpoint
        ? await endpointsApi.update(projectId, currentEndpoint.id, currentEndpoint.revision, {
            name: name.trim(),
            description: description.trim() || null,
            baseUrl: baseUrl.trim(),
            matcher,
          })
        : await endpointsApi.create(projectId, {
            name: name.trim(),
            ...(description.trim() ? { description: description.trim() } : {}),
            baseUrl: baseUrl.trim(),
            matcher,
            mode,
            variants: [{ name: 'Default', status: 200, responseHeaders: {} }],
            defaultVariantIndex: 0,
          });
      if (!completeSave(saved)) return;
      onDirtyChange?.(key, false);
      setName(saved.name);
      setDescription(saved.description ?? '');
      setMethod(saved.matcher.method);
      setBaseUrl(saved.baseUrl);
      setMode(saved.mode);
      setQueryMatchers(queryRows(saved));
      setHeaderMatchers(headerRows(saved));
      setRequestPath(saved.matcher.path);
      setCurrentEndpoint(saved);
    } catch (caught) {
      if (typeof caught === 'object' && caught !== null && 'status' in caught && caught.status === 409) {
        setServerRevision('currentRevision' in caught && typeof caught.currentRevision === 'number'
          ? caught.currentRevision : undefined);
      } else {
        setError(caught instanceof Error ? caught.message : 'Failed to save Endpoint');
      }
    } finally {
      releaseSaveOwnership();
    }
  };

  const selectedVariant = currentEndpoint?.variants.find(variant => variant.id === selectedVariantId)
    ?? currentEndpoint?.variants[0];

  // An active App State binds Endpoints to Variants, so Serving now stops deciding what is mocked.
  const appStatesDriving = project?.appStateMode === 'enabled' && project.activeStateId !== undefined;

  const structuralDraftKeys = () => [dirty ? key : undefined, dirtyVariantKey.current]
    .filter((draftKey): draftKey is string => draftKey !== undefined);

  const attemptStructuralAction = (action: () => void) => {
    const draftKeys = structuralDraftKeys();
    if (draftKeys.length > 0 && onAttemptNavigation) onAttemptNavigation(action, draftKeys);
    else action();
  };

  const reportStructuralError = (caught: unknown, fallback: string) => {
    if (caught instanceof ApiClientError && caught.status === 409 && caught.currentRevision !== undefined) {
      setServerRevision(caught.currentRevision);
    } else {
      setError(caught instanceof Error ? caught.message : fallback);
    }
  };

  const refreshCanonicalEndpoint = async (
    completePublication: (endpoint: EndpointDetail) => boolean,
    preferredVariantId?: string,
    adoptEndpointFields = true,
  ): Promise<boolean> => {
    if (!currentEndpoint) return false;
    const operationEndpointId = currentEndpoint.id;
    const refreshed = await endpointsApi.get(projectId, operationEndpointId);
    if (!mountedRef.current || currentEndpointIdRef.current !== operationEndpointId) return false;
    if (!completePublication(refreshed)) return false;
    setCurrentEndpoint(refreshed);
    if (adoptEndpointFields) {
      setName(refreshed.name);
      setDescription(refreshed.description ?? '');
      setMethod(refreshed.matcher.method);
      setBaseUrl(refreshed.baseUrl);
      setMode(refreshed.mode);
      setQueryMatchers(queryRows(refreshed));
      setHeaderMatchers(headerRows(refreshed));
      setRequestPath(refreshed.matcher.path);
    }
    setSelectedVariantId(current => {
      const preferred = preferredVariantId ?? current;
      return refreshed.variants.some(variant => variant.id === preferred)
        ? preferred
        : refreshed.defaultVariantId;
    });
    onSaved(refreshed);
    return true;
  };

  const reloadCommittedChange = async (
    completePublication: (endpoint: EndpointDetail) => boolean,
    preferredVariantId?: string,
    adoptEndpointFields = true,
  ) => {
    const operationEndpointId = currentEndpoint?.id;
    const recordRecovery = () => {
      if (!mountedRef.current || currentEndpointIdRef.current !== operationEndpointId) return;
      setPostCommitRecovery({ preferredVariantId, adoptEndpointFields });
    };
    try {
      const published = await refreshCanonicalEndpoint(
        completePublication,
        preferredVariantId,
        adoptEndpointFields,
      );
      if (!published) recordRecovery();
      return published;
    } catch {
      recordRecovery();
      return false;
    }
  };

  const refreshSavedChanges = async () => {
    if (!postCommitRecovery) return;
    const completePublication = onEndpointSaveStarted();
    setRefreshingRecovery(true);
    try {
      if (await refreshCanonicalEndpoint(
        completePublication,
        postCommitRecovery.preferredVariantId,
        postCommitRecovery.adoptEndpointFields,
      )) {
        setPostCommitRecovery(undefined);
      }
    } catch {
      // The committed mutation remains recoverable through another GET-only refresh.
    } finally {
      setRefreshingRecovery(false);
    }
  };

  const refreshAfterConflict = async (
    preferredVariantId?: string,
    owner: 'endpoint' | 'variant' = 'endpoint',
  ) => {
    const completePublication = onEndpointSaveStarted();
    setRefreshingCanonical(owner);
    setStructuralLoading(true);
    setError(undefined);
    try {
      if (await refreshCanonicalEndpoint(completePublication, preferredVariantId)) {
        setServerRevision(undefined);
      }
    } catch (caught) {
      reportStructuralError(caught, 'Failed to refresh Endpoint');
    } finally {
      setRefreshingCanonical(undefined);
      setStructuralLoading(false);
    }
  };

  const openNewVariant = () => {
    if (!currentEndpoint) return;
    setNewVariantSource(selectedVariant);
    setNewVariantOpen(true);
  };

  const createVariant = async ({ name: variantName, source }: NewVariantDialogResult) => {
    if (!currentEndpoint) return;
    const completePublication = onEndpointSaveStarted();
    let input: CreateVariantInput;
    if (source === 'blank') {
      input = { name: variantName, status: 200, responseHeaders: {} };
    } else {
      if (!newVariantSource) return;
      input = {
          name: variantName,
          ...(newVariantSource.description !== undefined
            ? { description: newVariantSource.description }
            : {}),
          status: newVariantSource.status,
          responseHeaders: structuredClone(newVariantSource.responseHeaders),
          ...(newVariantSource.bodyAssetId !== undefined
            ? { bodyAssetId: newVariantSource.bodyAssetId }
            : {}),
          ...(newVariantSource.delayMs !== undefined ? { delayMs: newVariantSource.delayMs } : {}),
      };
    }
    setStructuralLoading(true);
    setError(undefined);
    setServerRevision(undefined);
    try {
      let created: ResponseVariant;
      try {
        created = await variantsApi.create(
          projectId,
          currentEndpoint.id,
          currentEndpoint.revision,
          input,
        );
      } catch (caught) {
        reportStructuralError(caught, 'Failed to create Variant');
        return;
      }
      setNewVariantOpen(false);
      await reloadCommittedChange(completePublication, created.id);
    } finally {
      setStructuralLoading(false);
    }
  };

  const setServingNow = async () => {
    if (!currentEndpoint || !selectedVariant || appStatesDriving) return;
    const completePublication = onEndpointSaveStarted();
    setStructuralLoading(true);
    setError(undefined);
    setServerRevision(undefined);
    try {
      try {
        await endpointsApi.update(
          projectId,
          currentEndpoint.id,
          currentEndpoint.revision,
          { defaultVariantId: selectedVariant.id },
        );
      } catch (caught) {
        reportStructuralError(caught, 'Failed to set the Serving now Variant');
        return;
      }
      await reloadCommittedChange(completePublication, selectedVariant.id);
    } finally {
      setStructuralLoading(false);
    }
  };

  const openDeleteVariant = async () => {
    if (!currentEndpoint
      || !selectedVariant
      || (currentEndpoint.mode === 'mock' && currentEndpoint.variants.length === 1)) return;
    setStructuralLoading(true);
    setError(undefined);
    setServerRevision(undefined);
    try {
      const impact = await variantsApi.deletionImpact(projectId, currentEndpoint.id, selectedVariant.id);
      setDeleteRequest({ variant: selectedVariant, impact });
    } catch (caught) {
      reportStructuralError(caught, 'Failed to load Variant references');
    } finally {
      setStructuralLoading(false);
    }
  };

  const deleteVariant = async ({ replacementVariantId }: VariantDeleteDialogResult) => {
    if (!currentEndpoint || !deleteRequest) return;
    const request = deleteRequest;
    const completePublication = onEndpointSaveStarted();
    setStructuralLoading(true);
    setError(undefined);
    setServerRevision(undefined);
    try {
      try {
        await variantsApi.delete(
          projectId,
          currentEndpoint.id,
          request.variant.id,
          request.impact.variantRevision,
          ...(replacementVariantId ? [{
            expectedEndpointRevision: request.impact.endpointRevision,
            replacementVariantId,
          }] : []),
        );
      } catch (caught) {
        reportStructuralError(caught, 'Failed to delete Variant');
        if (caught instanceof ApiClientError && caught.status === 409 && caught.currentRevision === undefined) {
          try {
            const impact = await variantsApi.deletionImpact(projectId, currentEndpoint.id, request.variant.id);
            setDeleteRequest(current => current?.variant.id === request.variant.id
              ? { variant: current.variant, impact }
              : current);
          } catch {
            // Keep the domain error and stale dialog available if impact refresh also fails.
          }
        }
        return;
      }
      setDeleteRequest(undefined);
      await reloadCommittedChange(completePublication);
    } finally {
      setStructuralLoading(false);
    }
  };

  const openDeleteEndpoint = async () => {
    if (!currentEndpoint) return;
    setStructuralLoading(true);
    setError(undefined);
    setServerRevision(undefined);
    try {
      setEndpointDeleteImpact(await endpointsApi.deletionImpact(projectId, currentEndpoint.id));
    } catch (caught) {
      reportStructuralError(caught, 'Failed to load Endpoint references');
    } finally {
      setStructuralLoading(false);
    }
  };

  const deleteEndpoint = async () => {
    if (!currentEndpoint || !endpointDeleteImpact) return;
    setStructuralLoading(true);
    setError(undefined);
    setServerRevision(undefined);
    try {
      await endpointsApi.delete(projectId, currentEndpoint.id, endpointDeleteImpact.endpointRevision);
      onDeleted(currentEndpoint.id);
      setEndpointDeleteImpact(undefined);
    } catch (caught) {
      reportStructuralError(caught, 'Failed to delete Endpoint');
    } finally {
      setStructuralLoading(false);
    }
  };

  const recoverVariantDeletionConflict = () => {
    if (!deleteRequest) return;
    const variantId = deleteRequest.variant.id;
    setDeleteRequest(undefined);
    setError(undefined);
    attemptStructuralAction(() => void refreshAfterConflict(variantId, 'variant'));
  };

  const recoverEndpointDeletionConflict = () => {
    setEndpointDeleteImpact(undefined);
    attemptStructuralAction(() => void refreshAfterConflict());
  };

  const changeMode = async (nextMode: EndpointMode) => {
    if (!currentEndpoint || currentEndpoint.mode === nextMode) return;
    if (nextMode === 'mock'
      && (currentEndpoint.variants.length === 0 || !currentEndpoint.defaultVariantId)) return;
    if (modeOperationRef.current) return;
    const operation = {};
    modeOperationRef.current = operation;
    const operationEndpointId = currentEndpoint.id;
    const operationRevision = currentEndpoint.revision;
    const completePublication = onEndpointSaveStarted();
    const ownsOperation = () => modeOperationRef.current === operation
      && mountedRef.current
      && currentEndpointIdRef.current === operationEndpointId
      && currentEndpointRevisionRef.current === operationRevision;
    setStructuralLoading(true);
    setError(undefined);
    setServerRevision(undefined);
    try {
      const saved = await endpointsApi.setMode(
        projectId,
        operationEndpointId,
        nextMode,
        operationRevision,
      );
      if (!ownsOperation() || !completePublication(saved)) return;
      setCurrentEndpoint(saved);
      setMode(saved.mode);
      onSaved(saved);
    } catch (caught) {
      if (!ownsOperation()) return;
      if (caught instanceof ApiClientError && caught.status === 409) {
        reportStructuralError(caught, 'Failed to change Endpoint mode');
      } else if (!(caught instanceof ApiClientError) || caught.status === 0 || caught.status >= 500) {
        try {
          const refreshed = await endpointsApi.get(projectId, operationEndpointId);
          if (!ownsOperation() || !completePublication(refreshed)) return;
          setCurrentEndpoint(refreshed);
          setMode(refreshed.mode);
          setSelectedVariantId(current => refreshed.variants.some(variant => variant.id === current)
            ? current
            : refreshed.defaultVariantId);
          onSaved(refreshed);
          if (refreshed.mode !== nextMode) {
            setError('Endpoint mode change was not observed after canonical refresh. Review before trying again.');
          }
        } catch {
          if (ownsOperation()) {
            setPostCommitRecovery({ preferredVariantId: selectedVariantId, adoptEndpointFields: false });
            setError('Endpoint mode outcome is unknown. Refresh saved changes before trying again.');
          }
        }
      } else {
        reportStructuralError(caught, 'Failed to change Endpoint mode');
      }
    } finally {
      if (modeOperationRef.current === operation) modeOperationRef.current = undefined;
      if (mountedRef.current && currentEndpointIdRef.current === operationEndpointId) {
        setStructuralLoading(false);
      }
    }
  };

  const mutationLocked = structuralLoading || saveOwner !== undefined || postCommitRecovery !== undefined;
  const endpointDomId = encodeDomIdComponent(currentEndpoint?.id ?? '');
  const variantTabId = (variantId: string) => (
    `endpoint-${endpointDomId}-variant-${encodeDomIdComponent(variantId)}-tab`
  );
  const variantPanelId = (variantId: string) => (
    `endpoint-${endpointDomId}-variant-${encodeDomIdComponent(variantId)}-panel`
  );
  const selectVariant = (variantId: string, focus = false) => {
    if (mutationLocked) return;
    const draftKey = dirtyVariantKey.current;
    const guarded = draftKey !== undefined && onAttemptNavigation !== undefined;
    const action = () => {
      setSelectedVariantId(variantId);
      if (focus || guarded) document.getElementById(variantTabId(variantId))?.focus();
    };
    if (guarded) {
      if (selectedVariant) document.getElementById(variantTabId(selectedVariant.id))?.focus();
      onAttemptNavigation(action, [draftKey]);
    } else action();
  };

  const handleVariantTabKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    variantIndex: number,
  ) => {
    if (mutationLocked || !currentEndpoint) return;
    let targetIndex: number | undefined;
    if (event.key === 'ArrowRight') targetIndex = (variantIndex + 1) % currentEndpoint.variants.length;
    if (event.key === 'ArrowLeft') {
      targetIndex = (variantIndex - 1 + currentEndpoint.variants.length) % currentEndpoint.variants.length;
    }
    if (event.key === 'Home') targetIndex = 0;
    if (event.key === 'End') targetIndex = currentEndpoint.variants.length - 1;
    if (targetIndex === undefined) return;
    event.preventDefault();
    selectVariant(currentEndpoint.variants[targetIndex].id, true);
  };

  return (
    <div className="h-full overflow-y-auto p-5">
      <div className="mb-3 flex justify-end">
        <button type="button" onClick={onClose} className="text-sm text-gray-500 hover:text-gray-800">Close</button>
      </div>
      {postCommitRecovery ? (
        <div className="mb-4 flex items-center justify-between gap-3 rounded bg-amber-50 p-2 text-sm text-amber-800">
          <span>Change saved, refresh failed</span>
          <button
            type="button"
            disabled={refreshingRecovery}
            onClick={() => void refreshSavedChanges()}
            className="font-medium underline disabled:opacity-50"
          >
            {refreshingRecovery ? 'Refreshing saved changes...' : 'Refresh saved changes'}
          </button>
        </div>
      ) : null}
      <form onSubmit={save}>
        <fieldset disabled={mutationLocked} className="space-y-4 rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-base font-semibold text-gray-900">{currentEndpoint ? 'Edit Endpoint' : 'Create Endpoint'}</h3>
          <div className="flex items-center gap-3">
            {currentEndpoint ? (
              <details className="relative text-sm">
                <summary className="cursor-pointer select-none text-gray-600">Endpoint actions</summary>
                <div className="absolute right-0 z-10 mt-2 flex min-w-40 flex-col rounded border border-gray-200 bg-white p-2 shadow-sm">
                  <button
                    type="button"
                    disabled={structuralLoading}
                    onClick={() => attemptStructuralAction(() => void openDeleteEndpoint())}
                    className="rounded px-2 py-1 text-left text-xs text-red-700 hover:bg-red-50 disabled:opacity-50"
                  >
                    Delete Endpoint
                  </button>
                </div>
              </details>
            ) : null}
          </div>
        </div>
        {error && !deleteRequest ? <p className="rounded bg-red-50 p-2 text-sm text-red-700">{error}</p> : null}
        {serverRevision !== undefined || refreshingCanonical === 'endpoint' ? (
          <div className="flex items-center justify-between gap-3 rounded bg-amber-50 p-2 text-sm text-amber-800">
            <span>{refreshingCanonical === 'endpoint' ? 'Loading canonical Endpoint' : `Server revision ${serverRevision}`}</span>
            <button
              type="button"
              onClick={() => attemptStructuralAction(() => void refreshAfterConflict())}
              className="font-medium underline disabled:opacity-50"
            >
              {refreshingCanonical === 'endpoint' ? 'Refreshing Endpoint...' : 'Refresh Endpoint'}
            </button>
          </div>
        ) : null}
        <label className="block text-sm font-medium text-gray-700">
          Endpoint name
          <input aria-label="Endpoint name" required value={name} onChange={event => setName(event.target.value)} className="mt-1 w-full rounded border border-gray-300 px-3 py-2" />
        </label>
        <label className="block text-sm font-medium text-gray-700">
          Description
          <input aria-label="Endpoint description" value={description} onChange={event => setDescription(event.target.value)} className="mt-1 w-full rounded border border-gray-300 px-3 py-2" />
        </label>
        <div className="grid gap-3 md:grid-cols-[8rem_1fr]">
          <label className="text-sm font-medium text-gray-700">
            Method
            <select value={method} onChange={event => setMethod(event.target.value as HttpMethod)} className="mt-1 w-full rounded border border-gray-300 px-3 py-2">
              {(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const).map(value => <option key={value}>{value}</option>)}
            </select>
          </label>
          <label className="text-sm font-medium text-gray-700">
            Path
            <input aria-label="Endpoint path" required value={requestPath} onChange={event => setRequestPath(event.target.value)} className="mt-1 w-full rounded border border-gray-300 px-3 py-2 font-mono" />
          </label>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700">
            Endpoint base URL
            <input aria-label="Endpoint base URL" type="url" required value={baseUrl} onChange={event => setBaseUrl(event.target.value)} className="mt-1 w-full rounded border border-gray-300 px-3 py-2 font-mono" />
          </label>
          <p className="mt-1 text-xs text-gray-500">
            Enter an origin only, such as https://api.example.test. Paths, queries, and fragments are not accepted.
          </p>
        </div>
        <section className="space-y-2" aria-label="Query matchers">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-medium text-gray-700">Query matchers</h4>
            <button
              type="button"
              onClick={() => setQueryMatchers(rows => [...rows, {
                id: `query-new-${matcherRowId.current++}`, name: '', operator: 'equals', value: '',
              }])}
              className="rounded border border-gray-300 px-2 py-1 text-xs"
            >
              Add query matcher
            </button>
          </div>
          {queryMatchers.map((row, index) => (
            <div key={row.id} className="grid gap-2 md:grid-cols-[1fr_8rem_1fr_auto]">
              <input aria-label="Query name" placeholder="name" required value={row.name} onChange={event => setQueryMatchers(rows => rows.map((value, rowIndex) => rowIndex === index ? { ...value, name: event.target.value } : value))} className="rounded border border-gray-300 px-2 py-1.5 font-mono text-sm" />
              <select aria-label="Query operator" value={row.operator} onChange={event => setQueryMatchers(rows => rows.map((value, rowIndex) => rowIndex === index ? { ...value, operator: event.target.value as MatchExpression['operator'] } : value))} className="rounded border border-gray-300 px-2 py-1.5 text-sm">
                <option value="equals">Equals</option>
                <option value="glob">Glob</option>
              </select>
              <input aria-label="Query value" placeholder="value" value={row.value} onChange={event => setQueryMatchers(rows => rows.map((value, rowIndex) => rowIndex === index ? { ...value, value: event.target.value } : value))} className="rounded border border-gray-300 px-2 py-1.5 font-mono text-sm" />
              <button type="button" aria-label="Remove query matcher" onClick={() => setQueryMatchers(rows => rows.filter((_, rowIndex) => rowIndex !== index))} className="rounded px-2 text-xs text-red-700">Remove</button>
            </div>
          ))}
        </section>
        <section className="space-y-2" aria-label="Header matchers">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-medium text-gray-700">Header matchers</h4>
            <button
              type="button"
              onClick={() => setHeaderMatchers(rows => [...rows, {
                id: `header-new-${matcherRowId.current++}`, name: '', operator: 'equals', value: '',
              }])}
              className="rounded border border-gray-300 px-2 py-1 text-xs"
            >
              Add header matcher
            </button>
          </div>
          {headerMatchers.map((row, index) => (
            <div key={row.id} className="grid gap-2 md:grid-cols-[1fr_8rem_1fr_auto]">
              <input aria-label="Header name" placeholder="x-plan" required value={row.name} onChange={event => setHeaderMatchers(rows => rows.map((value, rowIndex) => rowIndex === index ? { ...value, name: event.target.value } : value))} className="rounded border border-gray-300 px-2 py-1.5 font-mono text-sm" />
              <select aria-label="Header operator" value={row.operator} onChange={event => setHeaderMatchers(rows => rows.map((value, rowIndex) => rowIndex === index ? { ...value, operator: event.target.value as MatchExpression['operator'] } : value))} className="rounded border border-gray-300 px-2 py-1.5 text-sm">
                <option value="equals">Equals</option>
                <option value="glob">Glob</option>
              </select>
              <input aria-label="Header value" placeholder="paid" value={row.value} onChange={event => setHeaderMatchers(rows => rows.map((value, rowIndex) => rowIndex === index ? { ...value, value: event.target.value } : value))} className="rounded border border-gray-300 px-2 py-1.5 font-mono text-sm" />
              <button type="button" aria-label="Remove header matcher" onClick={() => setHeaderMatchers(rows => rows.filter((_, rowIndex) => rowIndex !== index))} className="rounded px-2 text-xs text-red-700">Remove</button>
            </div>
          ))}
          <p className="text-xs text-gray-500">Header names are normalized to lowercase and each name owns one expression.</p>
        </section>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-gray-700">Endpoint mode</span>
          {currentEndpoint ? (
            <button
              type="button"
              disabled={currentEndpoint.mode === 'passthrough'
                && (currentEndpoint.variants.length === 0 || !currentEndpoint.defaultVariantId)}
              onClick={() => void changeMode(currentEndpoint.mode === 'mock' ? 'passthrough' : 'mock')}
              className="rounded border border-gray-300 px-3 py-1.5 text-xs font-medium disabled:opacity-50"
            >
              {currentEndpoint.mode === 'mock' ? 'Use passthrough mode' : 'Use mock mode'}
            </button>
          ) : (
            <select aria-label="Endpoint mode" value={mode} onChange={event => setMode(event.target.value as EndpointMode)} className="rounded border border-gray-300 px-3 py-1.5 text-sm">
              <option value="mock">Mock</option>
              <option value="passthrough">Passthrough</option>
            </select>
          )}
        </div>
        <button type="submit" disabled={!name.trim() || !baseUrl.trim()} className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
          {saveOwner === 'endpoint' ? 'Saving...' : currentEndpoint ? 'Save Endpoint' : 'Create Endpoint'}
        </button>
        </fieldset>
      </form>

      {currentEndpoint?.mode === 'passthrough'
        && (currentEndpoint.variants.length === 0 || !currentEndpoint.defaultVariantId) ? (
          <p className="mt-4 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
            Mock not ready. Add a Variant and choose what it serves now before switching this Endpoint to mock mode.
          </p>
        ) : null}

      {currentEndpoint && !selectedVariant ? (
        <fieldset disabled={mutationLocked} className="mt-5 flex items-center justify-between gap-3">
          <p className="text-xs text-gray-500">Endpoint revision {currentEndpoint.revision}</p>
          <button
            type="button"
            disabled={structuralLoading}
            onClick={() => attemptStructuralAction(openNewVariant)}
            className="rounded border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 disabled:opacity-50"
          >
            New Variant
          </button>
        </fieldset>
      ) : null}

      {currentEndpoint && selectedVariant ? (
        <fieldset disabled={mutationLocked} className="mt-5 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div role="tablist" aria-label="Response Variants" className="flex flex-wrap gap-2">
              {currentEndpoint.variants.map((variant, variantIndex) => (
                <button
                  key={variant.id}
                  id={variantTabId(variant.id)}
                  role="tab"
                  aria-controls={variantPanelId(variant.id)}
                  aria-selected={variant.id === selectedVariant.id}
                  tabIndex={variant.id === selectedVariant.id ? 0 : -1}
                  type="button"
                  disabled={mutationLocked}
                  onClick={() => selectVariant(variant.id)}
                  onKeyDown={event => handleVariantTabKeyDown(event, variantIndex)}
                  className={`rounded px-3 py-1.5 text-xs ${variant.id === selectedVariant.id ? 'bg-gray-900 text-white' : 'border border-gray-300 bg-white text-gray-700'}`}
                >
                  {variant.name}
                  {variant.id === currentEndpoint.defaultVariantId ? (
                    <span className="ml-1.5 rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-medium text-blue-800">
                      Serving now
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
            <button
              type="button"
              disabled={structuralLoading}
              onClick={() => attemptStructuralAction(openNewVariant)}
              className="rounded border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 disabled:opacity-50"
            >
              New Variant
            </button>
          </div>
          <div className="flex items-start justify-between gap-3">
            <p className="text-xs text-gray-500">Endpoint revision {currentEndpoint.revision}</p>
            <details className="relative text-sm">
              <summary className="cursor-pointer select-none text-gray-600">Variant actions</summary>
              <div className="mt-2 flex min-w-40 flex-col gap-1 rounded border border-gray-200 bg-white p-2 shadow-sm">
                <button
                  type="button"
                  disabled={structuralLoading}
                  onClick={() => attemptStructuralAction(openNewVariant)}
                  className="rounded px-2 py-1 text-left text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                >
                  Clone Variant
                </button>
                {selectedVariant.id !== currentEndpoint.defaultVariantId ? (
                  <button
                    type="button"
                    disabled={structuralLoading || appStatesDriving}
                    {...(appStatesDriving
                      ? { title: 'Disable App States to change Serving now' }
                      : {})}
                    onClick={() => attemptStructuralAction(() => void setServingNow())}
                    className="rounded px-2 py-1 text-left text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                  >
                    Set as Serving now
                  </button>
                ) : null}
                <button
                  type="button"
                  disabled={structuralLoading
                    || (currentEndpoint.mode === 'mock' && currentEndpoint.variants.length === 1)}
                  onClick={() => attemptStructuralAction(() => void openDeleteVariant())}
                  className="rounded px-2 py-1 text-left text-xs text-red-700 hover:bg-red-50 disabled:opacity-50"
                >
                  Delete Variant
                </button>
                {currentEndpoint.mode === 'mock' && currentEndpoint.variants.length === 1 ? (
                  <p className="px-2 py-1 text-xs text-gray-500">Mock Endpoints require a Serving now response</p>
                ) : null}
              </div>
            </details>
          </div>
          <div
            id={variantPanelId(selectedVariant.id)}
            role="tabpanel"
            aria-labelledby={variantTabId(selectedVariant.id)}
          >
            <VariantEditor
              projectId={projectId}
              endpoint={currentEndpoint}
              variant={selectedVariant}
              onDirtyChange={(draftKey, variantDirty, discard) => {
                if (variantDirty) dirtyVariantKey.current = draftKey;
                else if (dirtyVariantKey.current === draftKey) dirtyVariantKey.current = undefined;
                onDirtyChange?.(draftKey, variantDirty, discard);
              }}
              onSaved={async (
                _endpointId: string,
                savedVariant: ResponseVariant,
                completePublication,
              ) => {
                if (!completePublication) return;
                await reloadCommittedChange(
                  completePublication,
                  savedVariant.id,
                  !dirty,
                );
              }}
              onSaveOwnershipStarted={() => {
                const release = acquireSaveOwnership('variant');
                if (!release) return undefined;
                return {
                  release,
                  completePublication: onEndpointSaveStarted(),
                };
              }}
              onRefresh={() => attemptStructuralAction(
                () => void refreshAfterConflict(selectedVariant.id, 'variant'),
              )}
              refreshing={refreshingCanonical === 'variant'}
            />
          </div>
        </fieldset>
      ) : null}
      <NewVariantDialog
        isOpen={newVariantOpen}
        selectedVariant={newVariantSource}
        loading={structuralLoading}
        onConfirm={result => void createVariant(result)}
        onCancel={() => setNewVariantOpen(false)}
      />
      {deleteRequest ? (
        <VariantDeleteDialog
          isOpen
          variant={deleteRequest.variant}
          impact={deleteRequest.impact}
          error={error}
          recoveryMessage={serverRevision !== undefined ? `Server revision ${serverRevision}` : undefined}
          recoveryLabel={serverRevision !== undefined ? 'Refresh Variant' : undefined}
          confirmDisabled={serverRevision !== undefined}
          loading={structuralLoading}
          onRecovery={serverRevision !== undefined ? recoverVariantDeletionConflict : undefined}
          onConfirm={result => void deleteVariant(result)}
          onCancel={() => {
            setDeleteRequest(undefined);
            setError(undefined);
          }}
        />
      ) : null}
      <ConfirmDialog
        isOpen={endpointDeleteImpact !== undefined}
        title="Delete Endpoint"
        message={endpointDeleteImpact
          ? `Delete "${currentEndpoint?.name}"? This cannot be undone.\n\nAffected App States (${endpointDeleteImpact.affectedStates.length}):\n${endpointDeleteImpact.affectedStates.length > 0
            ? endpointDeleteImpact.affectedStates.map(state => state.name).join('\n')
            : 'None'}`
          : ''}
        confirmLabel="Delete Endpoint"
        variant="danger"
        loading={structuralLoading}
        confirmDisabled={serverRevision !== undefined}
        recoveryMessage={serverRevision !== undefined ? `Server revision ${serverRevision}` : undefined}
        recoveryLabel={serverRevision !== undefined ? 'Refresh Endpoint' : undefined}
        onRecovery={serverRevision !== undefined ? recoverEndpointDeletionConflict : undefined}
        onConfirm={() => void deleteEndpoint()}
        onCancel={() => setEndpointDeleteImpact(undefined)}
      />
    </div>
  );
}
