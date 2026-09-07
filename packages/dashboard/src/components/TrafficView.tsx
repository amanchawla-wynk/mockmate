import {
  useCallback,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import type {
  AppStateSummary,
  TrafficBodyDescriptor,
  TrafficDetail,
  TrafficPreview,
  TrafficPromotionResult,
  TrafficSummary,
} from '../api/types';
import type { BodyDocumentCache } from '../state/bodyDocumentCache';
import { useBodyDocumentCache } from '../state/bodyDocumentCacheContext';
import { TrafficBodyPane } from './TrafficBodyPane';
import { blockedCopy, promoteFromTrafficDetail } from './promoteFromTrafficDetail';

interface TrafficViewProps {
  traffic: TrafficSummary[];
  selectedTraffic: TrafficDetail | null;
  detailLoading?: boolean;
  onSelectTraffic: (trafficId: string) => void;
  loading?: boolean;
  listError?: string | null;
  detailError?: string | null;
  paused: boolean;
  onTogglePaused: (paused: boolean) => void;
  onClear: () => void;
  onRefresh: () => void;
  projectId?: string;
  onMockCreated?: () => void;
  bodyDocumentCache?: BodyDocumentCache;
  states?: AppStateSummary[];
  defaultStateId?: string;
  refreshPromotionCanonical?(result?: TrafficPromotionResult): Promise<TrafficDetail | null | undefined>;
}

const LIST_MIN_PX = 8 * 16;
const DETAIL_MIN_PX = 12 * 16;
const HANDLE_PX = 4;

function methodColor(method: string): string {
  switch (method) {
    case 'GET': return 'text-blue-600';
    case 'POST': return 'text-green-600';
    case 'PUT': return 'text-orange-600';
    case 'PATCH': return 'text-yellow-600';
    case 'DELETE': return 'text-red-600';
    default: return 'text-gray-600';
  }
}

function statusColor(status: number): string {
  if (status < 300) return 'text-green-600';
  if (status < 400) return 'text-blue-600';
  if (status < 500) return 'text-orange-600';
  return 'text-red-600';
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatQuery(query: TrafficDetail['request']['query']): string {
  if (query.length === 0) return '';
  return `?${query.map(entry => `${encodeURIComponent(entry.name)}=${encodeURIComponent(entry.value)}`).join('&')}`;
}

function fullUrl(detail: TrafficDetail): string {
  return `${detail.origin}${detail.path}${formatQuery(detail.request.query)}`;
}

function hasBodyTab(descriptor: TrafficBodyDescriptor, preview?: TrafficPreview): boolean {
  if (descriptor.state === 'available' || descriptor.state === 'truncated' || descriptor.state === 'evicted') {
    return true;
  }
  if (descriptor.observedSize > 0) return true;
  return preview !== undefined && preview.value.length > 0;
}

function KeyValueTable({
  rows,
  empty,
}: {
  rows: Array<readonly [string, string]>;
  empty: string;
}) {
  if (rows.length === 0) return <p className="text-xs text-gray-400">{empty}</p>;
  return (
    <table className="w-full text-left text-xs">
      <thead>
        <tr className="border-b border-gray-200 text-[10px] font-semibold uppercase tracking-wide text-gray-500">
          <th className="py-1 pr-3 font-semibold">Key</th>
          <th className="py-1 font-semibold">Value</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([name, value], index) => (
          <tr key={`${name}:${index}`} className="border-b border-gray-100 last:border-0">
            <td className="py-1 pr-3 align-top font-medium text-gray-600 whitespace-nowrap">{name}</td>
            <td className="py-1 font-mono text-gray-800 break-all">{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TabButton({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`border-b-2 px-1 pb-1 text-xs capitalize ${
        active
          ? 'border-blue-600 font-semibold text-blue-600'
          : 'border-transparent text-gray-500 hover:text-gray-700'
      }`}
    >
      {label}
    </button>
  );
}

function TrafficOverview({
  detail,
  promoting,
  promoteError,
  promoteSuccess,
  onMockThis,
}: {
  detail: TrafficDetail;
  promoting: boolean;
  promoteError?: string;
  promoteSuccess?: string;
  onMockThis: () => void;
}) {
  const eligible = detail.promotion.state === 'eligible';
  const blockedTitle = detail.promotion.state === 'blocked'
    ? blockedCopy[detail.promotion.reason]
    : detail.promotion.state === 'promoted'
      ? 'Traffic already promoted.'
      : undefined;
  const shortDecision = detail.decision.replace(/_/g, ' ');

  return (
    <div className="shrink-0 border-b border-gray-200 bg-white px-3 py-2">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <span className={`font-semibold ${methodColor(detail.method)}`}>{detail.method}</span>
            <span className={`font-semibold ${statusColor(detail.status)}`}>{detail.status}</span>
            <span className="text-gray-600">{shortDecision}</span>
            <span className="text-gray-500">{detail.durationMs} ms</span>
            <span className="text-gray-500">{formatSize(detail.responseBytes)}</span>
          </div>
          <p className="truncate font-mono text-xs text-gray-800" title={fullUrl(detail)}>
            {fullUrl(detail)}
          </p>
          {promoteError ? (
            <p className="text-xs text-red-600" role="alert">{promoteError}</p>
          ) : null}
          {promoteSuccess && !promoteError ? (
            <p className="text-xs text-green-700">{promoteSuccess}</p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onMockThis}
          disabled={!eligible || promoting}
          title={blockedTitle}
          className="shrink-0 rounded bg-gray-900 px-3 py-1.5 text-xs font-medium text-white disabled:cursor-not-allowed disabled:bg-gray-400"
        >
          {promoting ? 'Mocking...' : 'Mock This'}
        </button>
      </div>
    </div>
  );
}

export function TrafficView({
  traffic,
  selectedTraffic,
  detailLoading,
  onSelectTraffic,
  loading,
  listError,
  detailError,
  paused,
  onTogglePaused,
  onClear,
  onRefresh,
  projectId,
  onMockCreated,
  bodyDocumentCache,
  refreshPromotionCanonical,
}: TrafficViewProps) {
  const providedBodyDocumentCache = useBodyDocumentCache();
  const exactBodyCache = bodyDocumentCache ?? providedBodyDocumentCache;
  const [filter, setFilter] = useState('');
  const [selectedId, setSelectedId] = useState<string>();
  const [requestTab, setRequestTab] = useState<'headers' | 'query' | 'body'>('headers');
  const [responseTab, setResponseTab] = useState<'headers' | 'body'>('headers');
  const [detailHeight, setDetailHeight] = useState(DETAIL_MIN_PX);
  const [promoting, setPromoting] = useState(false);
  const [promoteError, setPromoteError] = useState<string>();
  const [promoteSuccess, setPromoteSuccess] = useState<string>();
  const splitRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const owner = useRef(projectId);
  const promoteOp = useRef<{
    key: string;
    controller: AbortController;
  } | undefined>(undefined);
  const promoteGeneration = useRef(0);
  const resetProjectState = useEffectEvent(() => {
    setSelectedId(undefined);
    setPromoting(false);
    setPromoteError(undefined);
    setPromoteSuccess(undefined);
  });
  const clearSelection = useEffectEvent(() => {
    setSelectedId(undefined);
  });
  const resetSelectionState = useEffectEvent(() => {
    setRequestTab('headers');
    setResponseTab('headers');
    setPromoteError(undefined);
    setPromoteSuccess(undefined);
    setPromoting(false);
  });

  useLayoutEffect(() => {
    if (owner.current !== projectId) {
      owner.current = projectId;
      promoteGeneration.current += 1;
      promoteOp.current?.controller.abort();
      promoteOp.current = undefined;
      resetProjectState();
      return;
    }
    if (selectedId !== undefined && !traffic.some(entry => entry.id === selectedId)) {
      // Removed traffic must permanently clear selection rather than reselect if the ID reappears.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      clearSelection();
    }
  }, [projectId, selectedId, traffic]);

  useLayoutEffect(() => {
    const root = splitRef.current;
    if (root === null) return;
    const total = root.clientHeight;
    if (total <= 0) return;
    const preferred = Math.round(total * 0.55);
    const maxDetail = Math.max(DETAIL_MIN_PX, total - LIST_MIN_PX - HANDLE_PX);
    setDetailHeight(Math.min(maxDetail, Math.max(DETAIL_MIN_PX, preferred)));
  }, []);

  useLayoutEffect(() => {
    promoteGeneration.current += 1;
    promoteOp.current?.controller.abort();
    promoteOp.current = undefined;
    // Selection owns transient tabs and promotion feedback, which reset together on identity changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    resetSelectionState();
  }, [selectedId]);

  useLayoutEffect(() => () => {
    promoteGeneration.current += 1;
    promoteOp.current?.controller.abort();
    promoteOp.current = undefined;
  }, []);

  const filtered = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!query) return traffic;
    return traffic.filter(entry => (
      `${entry.method} ${entry.path} ${entry.status} ${entry.decision} ${entry.endpoint?.name ?? ''}`
        .toLowerCase().includes(query)
    ));
  }, [filter, traffic]);
  const selected = filtered.find(entry => entry.id === selectedId);
  const detail = selectedTraffic?.id === selected?.id ? selectedTraffic : null;
  const passthroughCount = filtered.filter(entry => entry.decision.includes('passthrough')).length;

  const showRequestQuery = detail !== null && detail.request.query.length > 0;
  const showRequestBody = detail !== null && hasBodyTab(detail.request.body, detail.request.preview);
  const showResponseBody = detail !== null && hasBodyTab(detail.response.body, detail.response.preview);
  const normalizeTabs = useEffectEvent(() => {
    if (requestTab === 'query' && !showRequestQuery) setRequestTab('headers');
    if (requestTab === 'body' && !showRequestBody) setRequestTab('headers');
    if (responseTab === 'body' && !showResponseBody) setResponseTab('headers');
  });

  useLayoutEffect(() => {
    // A disappearing payload must move the visible tab back to an available panel immediately.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    normalizeTabs();
  }, [requestTab, responseTab, showRequestBody, showRequestQuery, showResponseBody]);

  const onResizePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragRef.current = { startY: event.clientY, startHeight: detailHeight };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [detailHeight]);

  const onResizePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current === null) return;
    const root = splitRef.current;
    if (root === null) return;
    const delta = dragRef.current.startY - event.clientY;
    const next = dragRef.current.startHeight + delta;
    const maxDetail = Math.max(DETAIL_MIN_PX, root.clientHeight - LIST_MIN_PX - HANDLE_PX);
    setDetailHeight(Math.min(maxDetail, Math.max(DETAIL_MIN_PX, next)));
  }, []);

  const onResizePointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current === null) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const onMockThis = useCallback(async () => {
    if (!projectId || !detail || detail.promotion.state !== 'eligible') return;
    if (promoteOp.current !== undefined) return;
    const key = `${projectId}:${detail.id}:${detail.generation}`;
    const generation = promoteGeneration.current + 1;
    promoteGeneration.current = generation;
    const controller = new AbortController();
    const current = { key, controller };
    promoteOp.current = current;
    const owns = () => (
      promoteOp.current === current
      && promoteGeneration.current === generation
      && owner.current === projectId
    );
    setPromoting(true);
    setPromoteError(undefined);
    setPromoteSuccess(undefined);
    try {
      const outcome = await promoteFromTrafficDetail({
        projectId,
        detail,
        signal: controller.signal,
        refreshCanonical: refreshPromotionCanonical ?? (async () => detail),
      });
      if (!owns()) return;
      if (outcome.ok) {
        setPromoteSuccess('Mock created');
        onMockCreated?.();
      } else {
        setPromoteError(outcome.error);
      }
    } finally {
      if (owns()) {
        promoteOp.current = undefined;
        setPromoting(false);
      }
    }
  }, [detail, onMockCreated, projectId, refreshPromotionCanonical]);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-white">
      <div className="flex min-h-11 flex-shrink-0 flex-wrap items-center justify-between gap-2 border-b border-gray-200 bg-[#F3F3F3] px-3 py-2">
        <input
          value={filter}
          onChange={event => setFilter(event.target.value)}
          placeholder="Filter traffic..."
          className="w-full rounded border border-gray-300 px-2 py-1 text-xs shadow-sm focus:outline-none focus:ring-1 focus:ring-blue-500 sm:w-64"
        />
        <div className="flex flex-wrap items-center gap-2">
          {loading ? <span className="text-xs text-gray-500">Loading...</span> : null}
          {listError ? <span className="text-xs text-red-600">{listError}</span> : null}
          {passthroughCount > 0 ? (
            <span className="rounded border border-orange-200 bg-orange-50 px-2 py-1 text-xs text-orange-700">
              Passthrough: {passthroughCount}
            </span>
          ) : null}
          <button type="button" onClick={() => onTogglePaused(!paused)} className="rounded border border-gray-300 bg-white px-2 py-1 text-xs">
            {paused ? 'Updates paused' : 'Live updates'}
          </button>
          <button type="button" onClick={onRefresh} className="rounded border border-gray-300 bg-white px-2 py-1 text-xs">Refresh</button>
          <button type="button" onClick={onClear} className="rounded border border-gray-300 bg-white px-2 py-1 text-xs">Clear</button>
        </div>
      </div>

      <div ref={splitRef} className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-auto" style={{ minHeight: LIST_MIN_PX }}>
          <div className="sticky top-0 hidden grid-cols-[5rem_minmax(0,1fr)_5rem_7rem_5rem_6rem] gap-2 border-b border-gray-200 bg-gray-50 px-3 py-2 text-xs font-semibold text-gray-600 md:grid">
            <span>Method</span><span>Origin / path</span><span>Status</span><span>Decision</span><span>Time</span><span>Size</span>
          </div>
          {filtered.length === 0 ? <p className="p-8 text-center text-sm text-gray-400">No traffic captured yet</p> : null}
          {filtered.map(entry => (
            <button
              type="button"
              key={entry.id}
              onClick={() => {
                setSelectedId(entry.id);
                onSelectTraffic(entry.id);
              }}
              className={`grid w-full grid-cols-[4rem_minmax(0,1fr)_4rem] gap-x-2 gap-y-1 border-b border-gray-100 px-3 py-2 text-left text-xs md:grid-cols-[5rem_minmax(0,1fr)_5rem_7rem_5rem_6rem] md:py-1.5 ${selected?.id === entry.id ? 'bg-blue-500 text-white' : 'hover:bg-gray-50'}`}
            >
              <span className={selected?.id === entry.id ? '' : methodColor(entry.method)}>{entry.method}</span>
              <span className="truncate font-mono" title={`${entry.origin}${entry.path}`}>
                <span className="text-[10px] opacity-70">{entry.origin}</span><br />{entry.path}
              </span>
              <span className={selected?.id === entry.id ? '' : statusColor(entry.status)}>{entry.status}</span>
              <span className="truncate"><span className="text-[10px] opacity-60 md:hidden">Outcome </span>{entry.decision}</span>
              <span><span className="text-[10px] opacity-60 md:hidden">Time </span>{entry.durationMs} ms</span>
              <span><span className="text-[10px] opacity-60 md:hidden">Size </span>{formatSize(entry.responseBytes)}</span>
            </button>
          ))}
        </div>

        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize traffic detail"
          onPointerDown={onResizePointerDown}
          onPointerMove={onResizePointerMove}
          onPointerUp={onResizePointerUp}
          onPointerCancel={onResizePointerUp}
          className="h-1 flex-shrink-0 cursor-row-resize bg-gray-200 hover:bg-blue-400"
        />

        <div
          className="flex min-h-0 flex-shrink-0 flex-col overflow-hidden bg-white"
          style={{ height: detailHeight, minHeight: DETAIL_MIN_PX }}
        >
          {!selected ? (
            <p className="p-8 text-center text-sm text-gray-400">Select a request to inspect</p>
          ) : null}
          {selected && !detail ? (
            <p className={`p-8 text-center text-sm ${detailError ? 'text-red-600' : 'text-gray-400'}`}>
              {detailLoading ? 'Loading request detail...' : detailError ?? 'Request detail unavailable'}
            </p>
          ) : null}
          {detail ? (
            <>
              <TrafficOverview
                detail={detail}
                promoting={promoting}
                promoteError={promoteError}
                promoteSuccess={promoteSuccess}
                onMockThis={() => { void onMockThis(); }}
              />
              <div className="grid min-h-0 flex-1 grid-cols-1 divide-y divide-gray-200 lg:grid-cols-2 lg:divide-x lg:divide-y-0">
                <section className="min-h-0 min-w-0 overflow-auto p-3">
                  <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-gray-500">
                    Request
                  </h3>
                  <div className="mb-3 flex gap-3">
                    <TabButton
                      active={requestTab === 'headers'}
                      label="headers"
                      onClick={() => setRequestTab('headers')}
                    />
                    {showRequestQuery ? (
                      <TabButton
                        active={requestTab === 'query'}
                        label="query"
                        onClick={() => setRequestTab('query')}
                      />
                    ) : null}
                    {showRequestBody ? (
                      <TabButton
                        active={requestTab === 'body'}
                        label="body"
                        onClick={() => setRequestTab('body')}
                      />
                    ) : null}
                  </div>
                  {requestTab === 'headers' ? (
                    <KeyValueTable rows={detail.request.headers} empty="No headers" />
                  ) : null}
                  {requestTab === 'query' ? (
                    <KeyValueTable
                      rows={detail.request.query.map(entry => [entry.name, entry.value])}
                      empty="No query"
                    />
                  ) : null}
                  {requestTab === 'body' && projectId ? (
                    <TrafficBodyPane
                      projectId={projectId}
                      trafficId={detail.id}
                      side="request"
                      descriptor={detail.request.body}
                      preview={detail.request.preview}
                      cache={exactBodyCache}
                      mode="inspector"
                    />
                  ) : null}
                </section>
                <section className="min-h-0 min-w-0 overflow-auto p-3">
                  <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-gray-500">
                    Response
                  </h3>
                  <div className="mb-3 flex gap-3">
                    <TabButton
                      active={responseTab === 'headers'}
                      label="headers"
                      onClick={() => setResponseTab('headers')}
                    />
                    {showResponseBody ? (
                      <TabButton
                        active={responseTab === 'body'}
                        label="body"
                        onClick={() => setResponseTab('body')}
                      />
                    ) : null}
                  </div>
                  {responseTab === 'headers' ? (
                    <KeyValueTable rows={detail.response.headers} empty="No headers" />
                  ) : null}
                  {responseTab === 'body' && projectId ? (
                    <TrafficBodyPane
                      projectId={projectId}
                      trafficId={detail.id}
                      side="response"
                      descriptor={detail.response.body}
                      preview={detail.response.preview}
                      cache={exactBodyCache}
                      mode="inspector"
                    />
                  ) : null}
                </section>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
