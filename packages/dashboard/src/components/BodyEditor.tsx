import { useEffect, useEffectEvent, useRef, useState, useSyncExternalStore } from 'react';
import type { BodyAsset } from '../api/types';
import {
  bodyDocumentIdentityKey,
  type BodyDocumentHandle,
  type BodyDocumentSnapshot,
} from '../state/bodyDocumentCache';
import type { BodyDraft } from '../state/bodyDrafts';
import type { JsonWorkerClient, JsonWorkerResponse } from '../workers/json-worker-client';
import { BodyDocumentEditor } from './BodyDocumentEditor';

export interface BodyEditorProps {
  handle: BodyDocumentHandle;
  initialMediaType: string;
  initialValidity?: BodyDraft['validity'];
  initialValidationMessage?: string;
  workerClient: JsonWorkerClient;
  pendingAsset?: BodyAsset;
  uploadError?: string;
  onChange(
    mediaType: string,
    validity: BodyDraft['validity'],
    validationMessage: string | undefined,
    documentChanged: boolean,
  ): void;
  onSaveBody(text: string, mediaType: string): Promise<void>;
}

function isJsonMediaType(mediaType: string): boolean {
  const normalized = mediaType.split(';', 1)[0]!.trim().toLowerCase();
  return normalized === 'application/json' || normalized.endsWith('+json');
}

function ownsResponse(
  response: JsonWorkerResponse,
  documentIdentity: string,
  documentGeneration: number,
  operationGeneration: number,
): boolean {
  return response.documentIdentity === documentIdentity
    && response.documentGeneration === documentGeneration
    && response.operationGeneration === operationGeneration;
}

function readySnapshot(snapshot: BodyDocumentSnapshot): snapshot is BodyDocumentSnapshot & {
  state: 'ready';
  editorState: NonNullable<BodyDocumentSnapshot['editorState']>;
} {
  return snapshot.state === 'ready' && snapshot.editorState !== undefined;
}

export function BodyEditor({
  handle,
  initialMediaType,
  initialValidity = 'unknown',
  initialValidationMessage,
  workerClient,
  pendingAsset,
  uploadError,
  onChange,
  onSaveBody,
}: BodyEditorProps) {
  const snapshot = useSyncExternalStore(handle.subscribe, handle.getSnapshot, handle.getSnapshot);
  const [mediaTypeState, setMediaTypeState] = useState(() => ({
    owner: initialMediaType,
    value: initialMediaType,
  }));
  const [validity, setValidity] = useState<BodyDraft['validity']>(initialValidity);
  const [validationMessage, setValidationMessage] = useState(initialValidationMessage);
  const [formattingGeneration, setFormattingGeneration] = useState<number>();
  const [saving, setSaving] = useState(false);
  const operationGeneration = useRef(0);
  const mounted = useRef(true);
  const observedValidationGeneration = useRef<number | undefined>(undefined);
  const reportChange = useEffectEvent(onChange);
  const beginValidation = useEffectEvent((
    nextMediaType: string,
    nextValidity: BodyDraft['validity'],
    documentChanged: boolean,
  ) => {
    if (documentChanged) setFormattingGeneration(undefined);
    setValidity(nextValidity);
    setValidationMessage(undefined);
    onChange(nextMediaType, nextValidity, undefined, documentChanged);
  });
  const documentIdentity = bodyDocumentIdentityKey(handle.identity);
  const mediaType = mediaTypeState.owner === initialMediaType
    ? mediaTypeState.value
    : initialMediaType;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      operationGeneration.current += 1;
    };
  }, []);

  useEffect(() => {
    if (!readySnapshot(snapshot)) return;
    const documentGeneration = snapshot.documentGeneration;
    const validationGeneration = snapshot.validationGeneration;
    const previousValidationGeneration = observedValidationGeneration.current;
    const documentChanged = previousValidationGeneration !== undefined
      && validationGeneration !== previousValidationGeneration;
    observedValidationGeneration.current = validationGeneration;
    const generation = operationGeneration.current + 1;
    operationGeneration.current = generation;
    if (!isJsonMediaType(mediaType)) {
      beginValidation(mediaType, 'valid', documentChanged);
      return;
    }
    beginValidation(mediaType, 'unknown', documentChanged);

    const timer = window.setTimeout(() => {
      const current = handle.getSnapshot();
      if (!readySnapshot(current)
        || current.documentGeneration !== documentGeneration
        || operationGeneration.current !== generation) return;
      void workerClient.validate({
        documentIdentity,
        documentGeneration,
        operationGeneration: generation,
        text: current.editorState.doc.toString(),
      }).then(
        response => {
          if (!mounted.current
            || operationGeneration.current !== generation
            || !ownsResponse(response, documentIdentity, documentGeneration, generation)) return;
          const latest = handle.getSnapshot();
          if (!readySnapshot(latest) || latest.documentGeneration !== documentGeneration) return;
          const nextValidity = response.ok ? 'valid' : 'invalid';
          const nextMessage = response.ok ? undefined : response.message;
          setValidity(nextValidity);
          setValidationMessage(nextMessage);
          reportChange(mediaType, nextValidity, nextMessage, documentChanged);
        },
        error => {
          if (!mounted.current || operationGeneration.current !== generation) return;
          const latest = handle.getSnapshot();
          if (!readySnapshot(latest) || latest.documentGeneration !== documentGeneration) return;
          const message = error instanceof Error ? error.message : 'JSON validation failed';
          setValidity('invalid');
          setValidationMessage(message);
          reportChange(mediaType, 'invalid', message, documentChanged);
        },
      );
    }, 300);
    return () => window.clearTimeout(timer);
  }, [documentIdentity, handle, mediaType, snapshot, workerClient]);

  const handleMediaTypeChange = (nextMediaType: string) => {
    operationGeneration.current += 1;
    setFormattingGeneration(undefined);
    setMediaTypeState({ owner: initialMediaType, value: nextMediaType });
    const nextValidity = isJsonMediaType(nextMediaType) ? 'unknown' : 'valid';
    setValidity(nextValidity);
    setValidationMessage(undefined);
    onChange(nextMediaType, nextValidity, undefined, false);
  };

  const formatJson = async () => {
    const current = handle.getSnapshot();
    if (!readySnapshot(current)) return;
    const documentGeneration = current.documentGeneration;
    const generation = operationGeneration.current + 1;
    operationGeneration.current = generation;
    setFormattingGeneration(generation);
    try {
      const response = await workerClient.format({
        documentIdentity,
        documentGeneration,
        operationGeneration: generation,
        text: current.editorState.doc.toString(),
      });
      if (!mounted.current
        || operationGeneration.current !== generation
        || !ownsResponse(response, documentIdentity, documentGeneration, generation)) return;
      const latest = handle.getSnapshot();
      if (!readySnapshot(latest) || latest.documentGeneration !== documentGeneration) return;
      if (!response.ok) {
        setValidity('invalid');
        setValidationMessage(response.message);
        onChange(mediaType, 'invalid', response.message, false);
        return;
      }
      if (response.formatted !== undefined) {
        const transaction = latest.editorState.update({
          changes: { from: 0, to: latest.editorState.doc.length, insert: response.formatted },
        });
        if (!handle.dispatch(transaction, documentGeneration)) return;
        setValidity('valid');
        setValidationMessage(undefined);
        onChange(mediaType, 'valid', undefined, true);
      }
    } catch (error) {
      if (!mounted.current || operationGeneration.current !== generation) return;
      const latest = handle.getSnapshot();
      if (!readySnapshot(latest) || latest.documentGeneration !== documentGeneration) return;
      const message = error instanceof Error ? error.message : 'JSON formatting failed';
      setValidity('invalid');
      setValidationMessage(message);
      onChange(mediaType, 'invalid', message, false);
    } finally {
      if (mounted.current && operationGeneration.current === generation) {
        setFormattingGeneration(currentGeneration => currentGeneration === generation
          ? undefined
          : currentGeneration);
      }
    }
  };

  const saveBody = async () => {
    const current = handle.getSnapshot();
    if (!readySnapshot(current)) return;
    setSaving(true);
    try {
      await onSaveBody(current.editorState.doc.toString(), mediaType);
    } finally {
      if (mounted.current) setSaving(false);
    }
  };

  if (snapshot.state === 'queued' || snapshot.state === 'loading') {
    return <p className="text-sm text-gray-500">Loading response body...</p>;
  }
  if (snapshot.state === 'error') {
    return (
      <div className="space-y-2 text-sm text-red-700">
        <p>{snapshot.error}</p>
        <button type="button" onClick={handle.retry} className="font-medium underline">Retry</button>
      </div>
    );
  }
  if (!readySnapshot(snapshot)) return null;

  const json = isJsonMediaType(mediaType);
  const formatting = formattingGeneration !== undefined;

  return (
    <section className="space-y-3 rounded-lg border border-gray-200 bg-gray-50 p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <label className="min-w-64 flex-1 text-sm font-medium text-gray-700">
          Body media type
          <input
            aria-label="Body media type"
            value={mediaType}
            onChange={event => handleMediaTypeChange(event.target.value)}
            className="mt-1 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:border-transparent focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </label>
        {json && (
          <button
            type="button"
            onClick={() => void formatJson()}
            disabled={formatting || validity === 'invalid'}
            className="rounded-md px-3 py-2 text-sm font-medium text-blue-600 hover:bg-blue-50 disabled:cursor-not-allowed disabled:text-gray-400"
          >
            Format JSON
          </button>
        )}
      </div>

      <div className="space-y-1 text-sm font-medium text-gray-700">
        <span>Response body</span>
        <BodyDocumentEditor
          ariaLabel="Response body"
          handle={handle}
          snapshot={snapshot}
          mode="editable"
          mediaType={mediaType}
        />
      </div>

      {validationMessage && (
        <p className="rounded-md border border-red-200 bg-red-50 p-2 text-sm text-red-700">
          {validationMessage}
        </p>
      )}
      {uploadError && (
        <p className="rounded-md border border-red-200 bg-red-50 p-2 text-sm text-red-700">
          {uploadError}
        </p>
      )}
      {pendingAsset && <p className="text-sm font-medium text-emerald-700">Pending body uploaded</p>}

      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => void saveBody()}
          disabled={saving || validity === 'invalid'}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-300"
        >
          Save Body
        </button>
      </div>
    </section>
  );
}
