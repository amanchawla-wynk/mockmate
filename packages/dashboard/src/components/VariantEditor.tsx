import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react';
import { EditorState } from '@codemirror/state';
import { ApiClientError, bodiesApi, variantsApi } from '../api/client';
import type {
  BodyAsset,
  EndpointDetail,
  ResponseVariant,
  VariantPatch,
} from '../api/types';
import {
  bodyDraftKey,
  createBodyDraft,
  discardBodyDraft,
  updateBodyDraft,
  type BodyDraftKey,
  type BodyDrafts,
} from '../state/bodyDrafts';
import type { BodyDocumentHandle, BodyDocumentIdentity } from '../state/bodyDocumentCache';
import {
  createBrowserJsonWorkerClient,
  type JsonWorkerClient,
} from '../workers/json-worker-client';
import { BodyEditor } from './BodyEditor';
import { useBodyDocumentCache } from '../state/bodyDocumentCacheContext';
import {
  HeadersTable,
  responseHeaderRowsToRecord,
  responseHeadersToRows,
} from './HeadersTable';

export interface VariantEditorProps {
  projectId: string;
  endpoint: EndpointDetail;
  variant: ResponseVariant;
  onDirtyChange?(key: string, dirty: boolean, discard?: () => void): void;
  onSaved(
    endpointId: string,
    variant: ResponseVariant,
    completePublication?: (endpoint: EndpointDetail) => boolean,
  ): void | Promise<void>;
  onSaveOwnershipStarted?(): {
    release(): void;
    completePublication(endpoint: EndpointDetail): boolean;
  } | undefined;
  onRefresh?(): void;
  refreshing?: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Request failed';
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function mockDocumentIdentity(key: BodyDraftKey): BodyDocumentIdentity {
  return {
    kind: 'mock',
    projectId: key.projectId,
    endpointId: key.endpointId,
    variantId: key.variantId,
    variantRevision: key.baseVariantRevision,
    ...(key.assetId === undefined ? {} : { bodyAssetId: key.assetId }),
  };
}

export function VariantEditor({
  projectId,
  endpoint,
  variant,
  onDirtyChange,
  onSaved,
  onSaveOwnershipStarted,
  onRefresh,
  refreshing = false,
}: VariantEditorProps) {
  const bodyDocumentCache = useBodyDocumentCache();
  const key: BodyDraftKey = {
    projectId,
    endpointId: endpoint.id,
    variantId: variant.id,
    baseVariantRevision: variant.revision,
    assetId: variant.bodyAssetId,
  };
  const serializedKey = bodyDraftKey(key);
  const canonicalIdentity = JSON.stringify([projectId, endpoint.id, variant.id, variant.revision]);
  const identityRef = useRef(serializedKey);

  const [drafts, setDrafts] = useState<BodyDrafts>(() => new Map());
  const [bodyOpenIdentity, setBodyOpenIdentity] = useState<string>();
  const [bodyDocument, setBodyDocument] = useState<{
    identity: string;
    handle: BodyDocumentHandle;
  }>();
  const [uploadError, setUploadError] = useState<string>();
  const [detachBodyRequested, setDetachBodyRequested] = useState(false);
  const [name, setName] = useState(variant.name);
  const [description, setDescription] = useState(variant.description ?? '');
  const [status, setStatus] = useState(String(variant.status));
  const [delayMs, setDelayMs] = useState(variant.delayMs === undefined ? '' : String(variant.delayMs));
  const [headerRows, setHeaderRows] = useState(() => responseHeadersToRows(variant.responseHeaders));
  const [headerError, setHeaderError] = useState<string>();
  const [saveError, setSaveError] = useState<string>();
  const [serverRevision, setServerRevision] = useState<number>();
  const [savingVariantOwner, setSavingVariantOwner] = useState<{
    identity: string;
    generation: number;
  }>();
  const [cleanAfterSave, setCleanAfterSave] = useState(false);
  const [workerClient, setWorkerClient] = useState<JsonWorkerClient>();
  const bodyDocumentRef = useRef<typeof bodyDocument>(undefined);
  const uploadController = useRef<AbortController | undefined>(undefined);
  const uploadGeneration = useRef(0);
  const variantSaveGeneration = useRef(0);
  const mounted = useRef(true);

  const draft = drafts.get(serializedKey);
  const bodyOpen = bodyOpenIdentity === serializedKey;
  const initialHeaderRows = responseHeadersToRows(variant.responseHeaders);
  const headersDirty = JSON.stringify(headerRows.map(({ name: headerName, value }) => ({
    name: headerName,
    value,
  }))) !== JSON.stringify(initialHeaderRows.map(({ name: headerName, value }) => ({
    name: headerName,
    value,
  })));
  const metadataDirty = name !== variant.name
    || description !== (variant.description ?? '')
    || status !== String(variant.status)
    || delayMs !== (variant.delayMs === undefined ? '' : String(variant.delayMs))
    || headersDirty;
  const dirty = !cleanAfterSave && (metadataDirty || detachBodyRequested || draft?.dirty === true);
  const savingVariant = savingVariantOwner?.identity === serializedKey;

  const releaseBodyDocument = useCallback(() => {
    const owned = bodyDocumentRef.current;
    if (owned === undefined) return;
    bodyDocumentCache.setActive(undefined);
    owned.handle.release();
    bodyDocumentRef.current = undefined;
    setBodyDocument(undefined);
  }, [bodyDocumentCache, setBodyDocument]);

  const resetCanonicalState = useEffectEvent(() => {
    setName(variant.name);
    setDescription(variant.description ?? '');
    setStatus(String(variant.status));
    setDelayMs(variant.delayMs === undefined ? '' : String(variant.delayMs));
    setHeaderRows(responseHeadersToRows(variant.responseHeaders));
    setDetachBodyRequested(false);
    releaseBodyDocument();
    setUploadError(undefined);
    setHeaderError(undefined);
    setSaveError(undefined);
    setServerRevision(undefined);
    setCleanAfterSave(false);
    setBodyOpenIdentity(undefined);
    setSavingVariantOwner(undefined);
  });
  const clearDirtyRegistration = useEffectEvent((draftKey: string) => {
    onDirtyChange?.(draftKey, false);
  });

  useLayoutEffect(() => {
    if (identityRef.current !== serializedKey) variantSaveGeneration.current += 1;
    identityRef.current = serializedKey;
  }, [serializedKey]);

  useEffect(() => {
    // This editor instance deliberately retains body drafts while resetting metadata per identity.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    resetCanonicalState();
  }, [canonicalIdentity]);

  const discardDraft = useCallback(() => {
    const operationKey: BodyDraftKey = {
      projectId,
      endpointId: endpoint.id,
      variantId: variant.id,
      baseVariantRevision: variant.revision,
      assetId: variant.bodyAssetId,
    };
    uploadGeneration.current += 1;
    uploadController.current?.abort();
    bodyDocumentCache.setDirty(mockDocumentIdentity(operationKey), false);
    bodyDocumentCache.invalidate(mockDocumentIdentity(operationKey));
    releaseBodyDocument();
    setDrafts(current => discardBodyDraft(current, operationKey));
    setName(variant.name);
    setDescription(variant.description ?? '');
    setStatus(String(variant.status));
    setDelayMs(variant.delayMs === undefined ? '' : String(variant.delayMs));
    setHeaderRows(responseHeadersToRows(variant.responseHeaders));
    setDetachBodyRequested(false);
    setBodyOpenIdentity(undefined);
    setHeaderError(undefined);
    setSaveError(undefined);
    setServerRevision(undefined);
    setCleanAfterSave(true);
  }, [
    bodyDocumentCache,
    endpoint.id,
    projectId,
    releaseBodyDocument,
    setBodyOpenIdentity,
    setCleanAfterSave,
    setDelayMs,
    setDescription,
    setDetachBodyRequested,
    setDrafts,
    setHeaderError,
    setHeaderRows,
    setName,
    setSaveError,
    setServerRevision,
    setStatus,
    variant.bodyAssetId,
    variant.delayMs,
    variant.description,
    variant.id,
    variant.name,
    variant.responseHeaders,
    variant.revision,
    variant.status,
  ]);

  useEffect(() => () => clearDirtyRegistration(serializedKey), [serializedKey]);

  useEffect(() => {
    if (dirty) onDirtyChange?.(serializedKey, true, discardDraft);
    else onDirtyChange?.(serializedKey, false);
  }, [dirty, discardDraft, onDirtyChange, serializedKey]);

  useEffect(() => () => {
    releaseBodyDocument();
    uploadGeneration.current += 1;
    uploadController.current?.abort();
  }, [releaseBodyDocument, serializedKey]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      variantSaveGeneration.current += 1;
    };
  }, []);

  useEffect(() => () => {
    workerClient?.dispose();
  }, [workerClient]);

  const updateCurrentDraft = (patch: Parameters<typeof updateBodyDraft>[2]) => {
    if (patch.dirty === true) bodyDocumentCache.setDirty(mockDocumentIdentity(key), true);
    setDrafts(current => updateBodyDraft(current, key, patch));
  };

  const openBody = () => {
    if (!workerClient) setWorkerClient(createBrowserJsonWorkerClient());
    const operationKey = { ...key };
    const operationIdentity = serializedKey;
    const existingDraft = drafts.get(operationIdentity);
    if (!existingDraft) {
      setDrafts(current => createBodyDraft(current, operationKey, 'application/octet-stream'));
    }
    releaseBodyDocument();
    const identity = mockDocumentIdentity(operationKey);
    const handle = bodyDocumentCache.acquire({
      identity,
      active: true,
      dirty: existingDraft?.dirty ?? false,
      async load(signal, progress) {
        let text = '';
        let mediaType = existingDraft?.mediaType ?? 'application/octet-stream';
        if (operationKey.assetId !== undefined) {
          const response = await bodiesApi.download(projectId, operationKey.assetId, signal);
          text = await response.text();
          if (signal.aborted) throw new DOMException('Body download aborted', 'AbortError');
          mediaType = response.headers.get('Content-Type') ?? mediaType;
        }
        const editorState = EditorState.create({ doc: text });
        const byteCount = new TextEncoder().encode(text).byteLength;
        progress(byteCount, byteCount);
        if (!signal.aborted && identityRef.current === operationIdentity) {
          setDrafts(current => {
            const currentDraft = current.get(operationIdentity);
            return currentDraft
              ? updateBodyDraft(current, operationKey, { mediaType })
              : createBodyDraft(current, operationKey, mediaType);
          });
        }
        return { text: editorState.doc, byteCount, editorState };
      },
    });
    const owned = { identity: operationIdentity, handle };
    bodyDocumentRef.current = owned;
    setBodyDocument(owned);
    setBodyOpenIdentity(serializedKey);
  };

  const saveBody = async (text: string, mediaType: string) => {
    uploadController.current?.abort();
    const controller = new AbortController();
    const generation = uploadGeneration.current + 1;
    uploadGeneration.current = generation;
    uploadController.current = controller;
    const operationIdentity = serializedKey;
    setUploadError(undefined);

    try {
      const asset = await bodiesApi.upload(
        projectId,
        new Blob([text], { type: mediaType }),
        controller.signal,
      );
      if (
        controller.signal.aborted
        || uploadController.current !== controller
        || uploadGeneration.current !== generation
        || identityRef.current !== operationIdentity
      ) return;
      const immutableAsset = Object.freeze({ ...asset }) as BodyAsset;
      updateCurrentDraft({ pendingAsset: immutableAsset, dirty: true });
      setCleanAfterSave(false);
      setDetachBodyRequested(false);
    } catch (error) {
      if (
        controller.signal.aborted
        || uploadController.current !== controller
        || uploadGeneration.current !== generation
        || identityRef.current !== operationIdentity
        || isAbortError(error)
      ) return;
      setUploadError(errorMessage(error));
    } finally {
      if (uploadController.current === controller && uploadGeneration.current === generation) {
        uploadController.current = undefined;
      }
    }
  };

  const removeBody = () => {
    uploadGeneration.current += 1;
    uploadController.current?.abort();
    uploadController.current = undefined;
    updateCurrentDraft({ pendingAsset: undefined, dirty: true });
    setCleanAfterSave(false);
    setDetachBodyRequested(true);
    setUploadError(undefined);
  };

  const saveVariant = async () => {
    const operationIdentity = serializedKey;
    const operationKey = { ...key };
    const operationEndpointId = endpoint.id;
    const operationOnDirtyChange = onDirtyChange;
    const operationOnSaved = onSaved;
    const metadataPatch: VariantPatch = {};
    if (name !== variant.name) metadataPatch.name = name;
    if (description !== (variant.description ?? '')) {
      metadataPatch.description = description === '' ? null : description;
    }
    const parsedStatus = Number(status);
    if (parsedStatus !== variant.status) metadataPatch.status = parsedStatus;
    const parsedDelay = delayMs === '' ? null : Number(delayMs);
    if (delayMs !== (variant.delayMs === undefined ? '' : String(variant.delayMs))) {
      metadataPatch.delayMs = parsedDelay;
    }
    setHeaderError(undefined);
    setSaveError(undefined);
    setServerRevision(undefined);
    try {
      const currentResponseHeaders = responseHeaderRowsToRecord(headerRows);
      if (headersDirty) metadataPatch.responseHeaders = currentResponseHeaders;
    } catch (error) {
      setHeaderError(errorMessage(error));
      return;
    }
    const pendingAsset = draft?.pendingAsset;
    const bodyPatch: Pick<VariantPatch, 'bodyAssetId'> = detachBodyRequested
      ? { bodyAssetId: null }
      : pendingAsset !== undefined
        ? { bodyAssetId: pendingAsset.id }
        : {};
    const patch: VariantPatch = { ...metadataPatch, ...bodyPatch };
    const saveOwnership = onSaveOwnershipStarted?.();
    if (onSaveOwnershipStarted && !saveOwnership) return;
    const generation = variantSaveGeneration.current + 1;
    variantSaveGeneration.current = generation;
    const ownsCompletion = () => mounted.current
      && identityRef.current === operationIdentity
      && variantSaveGeneration.current === generation;

    setSavingVariantOwner({ identity: operationIdentity, generation });
    setSaveError(undefined);
    setServerRevision(undefined);
    try {
      let saved: ResponseVariant;
      try {
        saved = await variantsApi.update(
          projectId,
          operationEndpointId,
          variant.id,
          variant.revision,
          patch,
        );
      } catch (error) {
        if (!ownsCompletion()) return;
        if (error instanceof ApiClientError && error.status === 409) {
          setServerRevision(error.currentRevision);
        } else {
          setSaveError(errorMessage(error));
        }
        return;
      }
      if (!ownsCompletion()) return;
      setDrafts(current => discardBodyDraft(current, operationKey));
      bodyDocumentCache.setDirty(mockDocumentIdentity(operationKey), false);
      setDetachBodyRequested(false);
      setCleanAfterSave(true);
      operationOnDirtyChange?.(operationIdentity, false);
      try {
        await operationOnSaved(operationEndpointId, saved, saveOwnership?.completePublication);
      } catch {
        // Parent canonical reload failures do not undo or reclassify the committed update.
      }
    } finally {
      if (ownsCompletion()) {
        setSavingVariantOwner(current => current?.generation === generation
          && current.identity === operationIdentity
          ? undefined
          : current);
      }
      saveOwnership?.release();
    }
  };

  return (
    <fieldset disabled={savingVariant || refreshing} className="space-y-5 rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
      {variant.trafficProvenance?.length ? (
        <section role="region" aria-label="Traffic provenance" className="rounded-md border border-blue-200 bg-blue-50 p-3">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-blue-900">Traffic provenance</h4>
          <div className="mt-2 space-y-2 text-xs text-blue-950">
            {variant.trafficProvenance.map(entry => (
              <div key={`${entry.trafficGeneration}:${entry.trafficId}:${entry.responseIdentity}`}>
                <p><span className="font-medium">Traffic:</span> {entry.trafficId} ({entry.trafficGeneration})</p>
                <p><span className="font-medium">Captured:</span> {entry.capturedAt} from {entry.requestOrigin}</p>
                <p><span className="font-medium">Response identity:</span> {entry.responseIdentity}</p>
                <p>
                  <span className="font-medium">Result:</span>{' '}
                  Endpoint {entry.endpointTarget}, Variant {entry.variantCreated ? 'created' : 'reused'}, State {entry.stateTarget}
                  {entry.stateId ? ` (${entry.stateId})` : ''}
                </p>
              </div>
            ))}
          </div>
        </section>
      ) : null}
      <div className="grid gap-4 md:grid-cols-2">
        <label className="text-sm font-medium text-gray-700">
          Variant name
          <input
            aria-label="Variant name"
            value={name}
            onChange={event => {
              setCleanAfterSave(false);
              setName(event.target.value);
            }}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </label>
        <label className="text-sm font-medium text-gray-700">
          Status
          <input
            aria-label="Response status"
            type="number"
            value={status}
            onChange={event => {
              setCleanAfterSave(false);
              setStatus(event.target.value);
            }}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </label>
        <label className="text-sm font-medium text-gray-700 md:col-span-2">
          Description
          <input
            aria-label="Variant description"
            value={description}
            onChange={event => {
              setCleanAfterSave(false);
              setDescription(event.target.value);
            }}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </label>
        <label className="text-sm font-medium text-gray-700">
          Delay (ms)
          <input
            aria-label="Response delay"
            type="number"
            min="0"
            value={delayMs}
            onChange={event => {
              setCleanAfterSave(false);
              setDelayMs(event.target.value);
            }}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </label>
      </div>

      <HeadersTable
        label="Response headers"
        rows={headerRows}
        error={headerError}
        onChange={rows => {
          setCleanAfterSave(false);
          setHeaderError(undefined);
          setHeaderRows(rows);
        }}
      />

      <div className="flex flex-wrap gap-2 border-t border-gray-200 pt-4">
        <button
          type="button"
          onClick={openBody}
          className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
        >
          Edit response body
        </button>
        {(variant.bodyAssetId || draft?.pendingAsset) && (
          <button
            type="button"
            onClick={removeBody}
            className="rounded-md px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50"
          >
            Remove response body
          </button>
        )}
      </div>

      {bodyOpen && draft && workerClient && bodyDocument?.identity === serializedKey && (
        <BodyEditor
          key={serializedKey}
          handle={bodyDocument.handle}
          initialMediaType={draft.mediaType}
          initialValidity={draft.validity}
          initialValidationMessage={draft.validationMessage}
          workerClient={workerClient}
          pendingAsset={draft.pendingAsset}
          uploadError={uploadError}
          onChange={(mediaType, validity, validationMessage, documentChanged) => {
            setCleanAfterSave(false);
            if (documentChanged || mediaType !== draft.mediaType) {
              bodyDocumentCache.setDirty(mockDocumentIdentity(key), true);
            }
            setDrafts(current => {
              const currentDraft = current.get(serializedKey);
              if (!currentDraft) return current;
              return updateBodyDraft(current, key, {
                mediaType,
                validity,
                validationMessage,
                dirty: currentDraft.dirty
                  || documentChanged
                  || mediaType !== currentDraft.mediaType,
              });
            });
          }}
          onSaveBody={saveBody}
        />
      )}

      {(serverRevision !== undefined || refreshing) && (
        <div className="flex items-center justify-between gap-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          <span>{refreshing ? 'Loading canonical Variant' : `Server revision ${serverRevision}`}</span>
          <button type="button" disabled={refreshing} onClick={onRefresh} className="font-medium underline disabled:opacity-50">
            {refreshing ? 'Refreshing Variant...' : 'Refresh Variant'}
          </button>
        </div>
      )}
      {saveError && <p className="text-sm text-red-700">{saveError}</p>}

      <div className="flex justify-end border-t border-gray-200 pt-4">
        <button
          type="button"
          onClick={() => void saveVariant()}
          disabled={savingVariant}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-300"
        >
          Save Variant
        </button>
      </div>
    </fieldset>
  );
}
