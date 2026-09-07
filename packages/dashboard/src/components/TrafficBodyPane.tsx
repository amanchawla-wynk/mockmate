import { useCallback, useRef, useState, useSyncExternalStore } from 'react';
import { trafficApi } from '../api/client';
import type { TrafficBodyDescriptor, TrafficPreview } from '../api/types';
import type { BodyDocumentCache, BodyDocumentHandle } from '../state/bodyDocumentCache';
import {
  classifyTrafficBody,
  formatTrafficPreviewText,
  loadTrafficTextBody,
} from '../state/trafficBodyLoader';
import { BodyDocumentEditor } from './BodyDocumentEditor';

export interface TrafficBodyPaneProps {
  projectId: string;
  trafficId: string;
  side: 'request' | 'response';
  descriptor: TrafficBodyDescriptor;
  preview?: TrafficPreview;
  cache: BodyDocumentCache;
  /** inspector: exact/decoded with spinner; falls back to preview when blocked. legacy: always shows preview */
  mode?: 'inspector' | 'legacy';
}

const bodyStateCopy = {
  unavailable: 'Exact body was not retained.',
  truncated: 'Exact body exceeded the capture limit and cannot be promoted.',
  evicted: 'Exact body was evicted from the ephemeral cache and cannot be reloaded.',
} as const;

function sideLabel(side: 'request' | 'response'): string {
  return side === 'request' ? 'Request' : 'Response';
}

function Spinner({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 py-6 text-xs text-gray-500" role="status" aria-label={label}>
      <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-blue-600" />
      <span>Loading exact body...</span>
    </div>
  );
}

function Preview({
  preview,
  mediaType,
}: {
  preview?: TrafficPreview;
  mediaType: string | undefined;
}) {
  if (preview === undefined) return <p className="text-xs text-gray-400">No preview retained</p>;
  return (
    <div className="space-y-1">
      {preview.truncated ? <p className="text-xs text-orange-700">Preview truncated.</p> : null}
      <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-gray-800">
        {formatTrafficPreviewText(preview, mediaType)}
      </pre>
    </div>
  );
}

function Download({ projectId, trafficId, side }: Pick<
  TrafficBodyPaneProps,
  'projectId' | 'trafficId' | 'side'
>) {
  return (
    <a
      href={trafficApi.bodyDownloadUrl(projectId, trafficId, side)}
      className="text-xs font-medium text-blue-700 underline"
      aria-label={`Download ${side} body`}
    >
      Download
    </a>
  );
}

interface TrafficTextDocumentProps extends Omit<TrafficBodyPaneProps, 'preview' | 'descriptor' | 'mode'> {
  descriptor: Extract<TrafficBodyDescriptor, { state: 'available' }>;
  mediaType: string;
  decoded: boolean;
  inspector: boolean;
}

function TrafficTextSnapshot({
  handle,
  projectId,
  trafficId,
  side,
  descriptor,
  mediaType,
  decoded,
  inspector,
}: TrafficTextDocumentProps & { handle: BodyDocumentHandle }) {
  const snapshot = useSyncExternalStore(handle.subscribe, handle.getSnapshot, handle.getSnapshot);

  if (snapshot.state === 'queued' || snapshot.state === 'loading') {
    if (inspector) {
      return <Spinner label={`${sideLabel(side)} exact body progress`} />;
    }
    return (
      <progress
        aria-label={`${sideLabel(side)} exact body progress`}
        value={snapshot.progress.loadedBytes}
        max={snapshot.progress.totalBytes ?? descriptor.retainedSize}
        className="h-1.5 w-full"
      />
    );
  }
  if (snapshot.state === 'error') {
    return (
      <div className="flex flex-wrap items-center gap-3 text-xs text-red-700">
        <span>{snapshot.error}</span>
        <button type="button" onClick={handle.retry} className="font-medium underline">
          Retry exact body
        </button>
        <Download projectId={projectId} trafficId={trafficId} side={side} />
      </div>
    );
  }
  if (snapshot.editorState === undefined) return null;
  return (
    <div className="space-y-2">
      {decoded ? (
        <p className="text-xs text-gray-600">
          Showing decoded view. Download is the original encoded bytes.
        </p>
      ) : null}
      <BodyDocumentEditor
        ariaLabel={`${sideLabel(side)} exact body`}
        handle={handle}
        snapshot={{ ...snapshot, state: 'ready', editorState: snapshot.editorState }}
        mode="readonly"
        mediaType={mediaType}
      />
      {decoded ? <Download projectId={projectId} trafficId={trafficId} side={side} /> : null}
    </div>
  );
}

function TrafficTextDocument(props: TrafficTextDocumentProps) {
  const { cache, descriptor, mediaType, decoded, projectId, side, trafficId, inspector } = props;
  const ownedHandle = useRef<BodyDocumentHandle | undefined>(undefined);
  const [handle, setHandle] = useState<BodyDocumentHandle>();
  const ownDocument = useCallback((node: HTMLDivElement | null) => {
    if (node === null) {
      const owned = ownedHandle.current;
      ownedHandle.current = undefined;
      if (owned !== undefined) {
        cache.deactivate(owned.identity);
        owned.release();
      }
      return;
    }
    if (ownedHandle.current !== undefined) return;
    const acquired = cache.acquire({
      identity: {
        kind: 'traffic',
        projectId,
        trafficId,
        side,
        sha256: decoded ? `decoded:${descriptor.sha256}` : descriptor.sha256,
      },
      active: true,
      dirty: false,
      async load(signal, progress) {
        const response = decoded
          ? await trafficApi.body(projectId, trafficId, side, signal, { view: 'decoded' })
          : await trafficApi.body(projectId, trafficId, side, signal);
        return loadTrafficTextBody({
          response,
          expected: decoded
            ? { view: 'decoded', mediaType }
            : {
              sha256: descriptor.sha256,
              byteCount: descriptor.retainedSize,
              mediaType,
            },
          signal,
          onProgress: progress,
        });
      },
    });
    ownedHandle.current = acquired;
    setHandle(acquired);
  }, [
    cache,
    decoded,
    descriptor.retainedSize,
    descriptor.sha256,
    mediaType,
    projectId,
    side,
    trafficId,
  ]);

  return (
    <div ref={ownDocument}>
      {handle === undefined ? (
        inspector ? (
          <Spinner label={`${sideLabel(side)} exact body progress`} />
        ) : (
          <progress
            aria-label={`${sideLabel(side)} exact body progress`}
            value={0}
            max={descriptor.retainedSize}
            className="h-1.5 w-full"
          />
        )
      ) : <TrafficTextSnapshot {...props} handle={handle} />}
    </div>
  );
}

export function TrafficBodyPane({
  projectId,
  trafficId,
  side,
  descriptor,
  preview,
  cache,
  mode = 'inspector',
}: TrafficBodyPaneProps) {
  const presentation = classifyTrafficBody({ descriptor });
  const mediaType = descriptor.state === 'available' ? descriptor.mediaType : undefined;
  const inspector = mode === 'inspector';
  const showExactText = presentation.kind === 'text' && descriptor.state === 'available';
  const showPreview = !inspector || presentation.kind === 'blocked';
  return (
    <div className="space-y-3">
      {showPreview ? <Preview preview={preview} mediaType={mediaType} /> : null}
      {presentation.kind === 'blocked' ? (
        <p className="rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
          {bodyStateCopy[presentation.reason]}
          {preview !== undefined && preview.value.length > 0
            ? ' Showing bounded preview.'
            : ''}
        </p>
      ) : null}
      {presentation.kind === 'binary' ? (
        <div className="flex items-center justify-between gap-3 rounded border border-gray-200 bg-gray-50 p-2">
          <span className="text-xs text-gray-600">
            {presentation.reason === 'content_encoded'
              ? 'Content-encoded exact body is available as a download.'
              : 'Binary exact body is available as a download.'}
          </span>
          <Download projectId={projectId} trafficId={trafficId} side={side} />
        </div>
      ) : null}
      {showExactText ? (
        <TrafficTextDocument
          key={`${projectId}:${trafficId}:${side}:${descriptor.sha256}:${presentation.decoded ? 'decoded' : 'raw'}`}
          projectId={projectId}
          trafficId={trafficId}
          side={side}
          descriptor={descriptor}
          mediaType={presentation.mediaType}
          decoded={presentation.decoded}
          cache={cache}
          inspector={inspector}
        />
      ) : null}
    </div>
  );
}
