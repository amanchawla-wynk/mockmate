import { useEffect, useMemo, useRef, useState } from 'react';
import type { RequestLogEntry } from '../api/types';
import { JsonViewer } from './JsonViewer';
import { trafficApi } from '../api/client';

interface TrafficViewProps {
  logs: RequestLogEntry[];
  loading?: boolean;
  error?: string | null;
  paused: boolean;
  onTogglePaused: (paused: boolean) => void;
  onClear: () => void;
  onRefresh: () => void;
  projectId?: string;
  activeScenario?: string;
  onRuleCreated?: () => void;
}

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

function statusColor(code: number): string {
  if (code >= 200 && code < 300) return 'text-green-600';
  if (code >= 300 && code < 400) return 'text-blue-600';
  if (code >= 400 && code < 500) return 'text-orange-600';
  return 'text-red-600';
}

function isObject(value: any): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function formatQuery(q?: Record<string, string>): string {
  const entries = Object.entries(q ?? {});
  if (entries.length === 0) return '';
  const parts = entries
    .slice(0, 8)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  const suffix = entries.length > 8 ? `&…(+${entries.length - 8})` : '';
  return `?${parts.join('&')}${suffix}`;
}

function formatSize(bytes: number | undefined): string {
  if (bytes === undefined) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const MIN_TABLE_PX = 200;
const MIN_INSPECTOR_PX = 250;
const RESIZE_HANDLE_PX = 8;
const DEFAULT_TABLE_FRACTION = 0.5;

function TabButton({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-1 text-xs font-medium transition-colors border-b-2 ${active ? 'border-blue-500 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
    >
      {label}
    </button>
  );
}

export function TrafficView({
  logs,
  loading,
  error,
  paused,
  onTogglePaused,
  onClear,
  onRefresh,
  projectId,
  activeScenario,
  onRuleCreated,
}: TrafficViewProps) {
  const [filter, setFilter] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reqTab, setReqTab] = useState<'headers' | 'query' | 'body'>('headers');
  const [resTab, setResTab] = useState<'headers' | 'body'>('body');
  const [creatingRule, setCreatingRule] = useState(false);
  const [createRuleError, setCreateRuleError] = useState<string | null>(null);

  const splitRef = useRef<HTMLDivElement>(null);
  const didInitSplitRef = useRef(false);
  const dragRef = useRef<{ startY: number; startTop: number } | null>(null);
  const [tableHeightPx, setTableHeightPx] = useState(320);

  const clampTableHeight = (px: number, containerHeight: number) => {
    const min = MIN_TABLE_PX;
    const maxRaw = containerHeight - MIN_INSPECTOR_PX - RESIZE_HANDLE_PX;
    const max = Math.max(min, maxRaw);
    return Math.min(Math.max(px, min), max);
  };

  useEffect(() => {
    const el = splitRef.current;
    if (!el) return;

    const update = () => {
      const h = el.getBoundingClientRect().height;
      if (!Number.isFinite(h) || h <= 0) return;
      setTableHeightPx((prev) => {
        if (!didInitSplitRef.current) {
          didInitSplitRef.current = true;
          return clampTableHeight(Math.round(h * DEFAULT_TABLE_FRACTION), h);
        }
        return clampTableHeight(prev, h);
      });
    };

    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return logs;
    return logs.filter((l) => {
      const s = `${l.method} ${l.host ?? ''} ${l.path} ${l.statusCode} ${l.proxied ? 'proxied' : 'mock'} ${l.scenario ?? ''} ${l.resourceId ?? ''}`.toLowerCase();
      return s.includes(q);
    });
  }, [filter, logs]);

  const proxiedCount = useMemo(() => filtered.filter(l => l.proxied).length, [filtered]);

  const selected = useMemo(() => {
    if (!selectedId) return filtered[0] ?? null;
    return filtered.find((l) => l.id === selectedId) ?? filtered[0] ?? null;
  }, [filtered, selectedId]);

  const inspector = useMemo(() => {
    if (!selected) return null;

    const url = `${selected.host ?? ''}${selected.path}${formatQuery(selected.requestQuery)}`;
    const reqHeaders = selected.requestHeaders ?? {};
    const resHeaders = selected.responseHeaders ?? {};

    return {
      url,
      reqHeaders,
      resHeaders,
    };
  }, [selected]);

  const fixtureDownloadUrl = useMemo(() => {
    if (!projectId || !selected?.responseFixture?.path) return null;
    const p = selected.responseFixture.path;
    const rel = p.startsWith('fixtures/') ? p.slice('fixtures/'.length) : p;
    return `/api/admin/projects/${projectId}/fixtures/${rel}`;
  }, [projectId, selected?.responseFixture?.path]);

  return (
    <div className="h-full flex flex-col bg-white overflow-hidden">
      {/* Toolbar */}
      <div className="flex-shrink-0 h-11 border-b border-gray-200 bg-[#F3F3F3] px-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter URLs..."
            className="w-64 px-2 py-1 text-xs border border-gray-300 rounded shadow-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>
        
        <div className="flex items-center gap-2">
          {loading && <span className="text-xs text-gray-500">Loading...</span>}
          {error && <span className="text-xs text-red-500">{error}</span>}
          {proxiedCount > 0 && (
            <span className="text-xs bg-orange-50 border border-orange-200 text-orange-700 px-2 py-1 rounded">
              Passthrough: {proxiedCount}
            </span>
          )}
          <div className="h-5 w-px bg-gray-300 mx-1"></div>
          <button
            onClick={() => onTogglePaused(!paused)}
            className={`px-2 py-1 text-xs rounded border shadow-sm flex items-center gap-1 ${paused ? 'bg-orange-50 border-orange-200 text-orange-700' : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-50'}`}
          >
            <div className={`w-2 h-2 rounded-full ${paused ? 'bg-orange-500' : 'bg-green-500'}`}></div>
            {paused ? 'Paused' : 'Recording'}
          </button>
          <button onClick={onRefresh} className="px-2 py-1 text-xs bg-white border border-gray-300 rounded shadow-sm text-gray-700 hover:bg-gray-50">
            Refresh
          </button>
          <button onClick={onClear} className="px-2 py-1 text-xs bg-white border border-gray-300 rounded shadow-sm text-gray-700 hover:bg-gray-50">
            Clear
          </button>
        </div>
      </div>

      {/* Main Split View */}
      <div ref={splitRef} className="flex-1 flex flex-col min-h-0">

        {/* Top: Data Table */}
        <div
          className="flex-shrink-0 flex flex-col border-b border-gray-200 min-h-0"
          style={{ height: tableHeightPx }}
        >
          <div className="flex-shrink-0 grid grid-cols-[80px_1fr_60px_80px_80px_190px] gap-2 px-3 py-1.5 bg-[#F9F9F9] border-b border-gray-200 text-xs font-semibold text-gray-600">
            <div>Method</div>
            <div>URL</div>
            <div>Status</div>
            <div>Time</div>
            <div>Size</div>
            <div>Type</div>
          </div>
          <div className="flex-1 overflow-y-auto bg-white">
            {filtered.length === 0 ? (
              <div className="p-8 text-center text-gray-400 text-sm">No traffic captured yet</div>
            ) : (
              <div className="flex flex-col">
                {filtered.map((l) => {
                  const isSelected = selected?.id === l.id;
                  const time = new Date(l.timestamp).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 });
                  return (
                    <div
                      key={l.id}
                      onClick={() => setSelectedId(l.id)}
                      className={`grid grid-cols-[80px_1fr_60px_80px_80px_190px] gap-2 px-3 py-1 text-xs cursor-pointer border-b border-gray-100 ${
                        isSelected ? 'bg-blue-500 text-white' : 'hover:bg-gray-50 text-gray-800'
                      }`}
                    >
                      <div className={`font-semibold ${isSelected ? 'text-white' : methodColor(l.method)}`}>{l.method}</div>
                      <div className="truncate font-mono" title={`${l.host ?? ''}${l.path}`}>
                        {l.host ?? ''}{l.path}
                      </div>
                      <div className={isSelected ? 'text-white' : statusColor(l.statusCode)}>{l.statusCode}</div>
                      <div className={isSelected ? 'text-blue-100' : 'text-gray-500'}>{time}</div>
                      <div className={isSelected ? 'text-blue-100' : 'text-gray-500'}>{formatSize(l.responseSize)}</div>
                      <div className={isSelected ? 'text-blue-100' : 'text-gray-500 truncate'}>
                        {l.proxied ? (
                          <>Proxy{l.proxiedReason ? ` (${l.proxiedReason})` : ''}</>
                        ) : (
                          <>Mock{l.scenario ? ` (${l.scenario})` : ''}{l.scenarioSource ? ` [${l.scenarioSource}]` : ''}{l.resourceId ? ` ${l.resourceId}` : ''}</>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Drag handle */}
        <div
          role="separator"
          aria-orientation="horizontal"
          tabIndex={0}
          className="flex-shrink-0 h-2 bg-gray-100 hover:bg-gray-200 cursor-row-resize touch-none select-none border-b border-gray-300"
          onDoubleClick={() => {
            const el = splitRef.current;
            if (!el) return;
            const h = el.getBoundingClientRect().height;
            if (!Number.isFinite(h) || h <= 0) return;
            setTableHeightPx(clampTableHeight(Math.round(h * DEFAULT_TABLE_FRACTION), h));
          }}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            const el = splitRef.current;
            if (!el) return;
            const h = el.getBoundingClientRect().height;
            dragRef.current = {
              startY: e.clientY,
              startTop: clampTableHeight(tableHeightPx, h),
            };
            (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            const drag = dragRef.current;
            if (!drag) return;
            const el = splitRef.current;
            if (!el) return;
            const h = el.getBoundingClientRect().height;
            const next = drag.startTop + (e.clientY - drag.startY);
            setTableHeightPx(clampTableHeight(next, h));
          }}
          onPointerUp={() => {
            dragRef.current = null;
          }}
          onPointerCancel={() => {
            dragRef.current = null;
          }}
        >
          <div className="h-full w-full flex items-center justify-center">
            <div className="w-10 h-px bg-gray-400/70" />
          </div>
        </div>

        {/* Bottom: Inspector Split Pane */}
        <div className="flex-1 min-h-0 flex bg-[#F3F3F3]">
          {!selected || !inspector ? (
            <div className="flex-1 flex items-center justify-center text-gray-400 text-sm bg-white">Select a request to inspect</div>
          ) : (
            <>
              {/* Left Pane: Request */}
              <div className="flex-1 flex flex-col border-r border-gray-300 bg-white min-w-0">
                <div className="flex-shrink-0 border-b border-gray-200 bg-[#FAFAFA] px-2 flex items-center">
                  <span className="text-xs font-semibold text-gray-700 mr-4 py-1.5">Request</span>
                  <TabButton active={reqTab === 'headers'} label="Headers" onClick={() => setReqTab('headers')} />
                  <TabButton active={reqTab === 'query'} label="Query" onClick={() => setReqTab('query')} />
                  <TabButton active={reqTab === 'body'} label="Body" onClick={() => setReqTab('body')} />
                </div>
                <div className="flex-shrink-0 px-3 py-2 bg-gray-50 border-b border-gray-100 text-xs font-mono truncate text-gray-800" title={inspector.url}>
                  <span className={methodColor(selected.method)}>{selected.method}</span> {inspector.url}
                </div>
                <div className="flex-1 overflow-auto p-3">
                  {reqTab === 'headers' && (
                    <div className="space-y-4">
                      {Object.keys(inspector.reqHeaders).length === 0 ? (
                        <div className="text-xs text-gray-400">No headers</div>
                      ) : (
                        <table className="w-full text-left text-xs">
                          <tbody>
                            {Object.entries(inspector.reqHeaders).map(([k, v]) => (
                              <tr key={k} className="border-b border-gray-100 last:border-0">
                                <td className="py-1 pr-2 font-medium text-gray-600 align-top whitespace-nowrap">{k}:</td>
                                <td className="py-1 font-mono text-gray-800 break-all">{v as React.ReactNode}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                  )}
                  {reqTab === 'query' && (
                    <div className="space-y-4">
                      {Object.keys(selected.requestQuery ?? {}).length === 0 ? (
                        <div className="text-xs text-gray-400">No query params</div>
                      ) : (
                        <table className="w-full text-left text-xs">
                          <tbody>
                            {Object.entries(selected.requestQuery ?? {}).map(([k, v]) => (
                              <tr key={k} className="border-b border-gray-100 last:border-0">
                                <td className="py-1 pr-2 font-medium text-gray-600 align-top whitespace-nowrap">{k}:</td>
                                <td className="py-1 font-mono text-gray-800 break-all">{v as React.ReactNode}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                  )}
                  {reqTab === 'body' && (
                    <div className="h-full">
                      {selected.requestBody === undefined ? (
                        <div className="text-xs text-gray-400">No body</div>
                      ) : isObject(selected.requestBody) || Array.isArray(selected.requestBody) ? (
                        <JsonViewer value={selected.requestBody} maxHeightClassName="max-h-full" />
                      ) : (
                        <pre className="text-xs text-gray-800 whitespace-pre-wrap break-words font-mono">{String(selected.requestBody)}</pre>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* Right Pane: Response */}
              <div className="flex-1 flex flex-col bg-white min-w-0">
                <div className="flex-shrink-0 border-b border-gray-200 bg-[#FAFAFA] px-2 flex items-center">
                  <span className="text-xs font-semibold text-gray-700 mr-4 py-1.5">Response</span>
                  <TabButton active={resTab === 'headers'} label="Headers" onClick={() => setResTab('headers')} />
                  <TabButton active={resTab === 'body'} label="Body" onClick={() => setResTab('body')} />
                </div>
                <div className="flex-shrink-0 px-3 py-2 bg-gray-50 border-b border-gray-100 text-xs font-mono flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={statusColor(selected.statusCode)}>{selected.statusCode}</span>
                    <span className="text-gray-500">{selected.duration}ms</span>
                    <span className="text-gray-500">{formatSize(selected.responseSize)}</span>
                    <span className="text-gray-300">|</span>
                    <span className="text-gray-500 truncate">
                      {selected.proxied ? 'Proxy' : 'Mock'}
                      {!selected.proxied && selected.scenario ? ` (${selected.scenario})` : ''}
                      {!selected.proxied && selected.scenarioSource ? ` [${selected.scenarioSource}]` : ''}
                    </span>
                  </div>

                  <div className="flex items-center gap-2 flex-shrink-0">
                    {fixtureDownloadUrl && (
                      <a
                        href={fixtureDownloadUrl}
                        className="px-2 py-1 text-xs bg-white border border-gray-300 rounded shadow-sm text-gray-700 hover:bg-gray-50"
                        title="Download raw HTTP response fixture"
                      >
                        Download Raw
                      </a>
                    )}

                    {projectId && selected.proxied && selected.responseFixture?.path && (
                      <button
                        type="button"
                        disabled={creatingRule}
                        onClick={async () => {
                          try {
                            setCreatingRule(true);
                            setCreateRuleError(null);
                            await trafficApi.createRuleFromLog(projectId, selected.id, activeScenario);
                            onRuleCreated?.();
                          } catch (e) {
                            setCreateRuleError(e instanceof Error ? e.message : 'Failed to create rule');
                          } finally {
                            setCreatingRule(false);
                          }
                        }}
                        className="px-2 py-1 text-xs bg-gray-900 text-white rounded shadow-sm hover:bg-black disabled:opacity-50"
                        title="Create a rule + scenario from this response"
                      >
                        {creatingRule ? 'Mocking…' : 'Mock This'}
                      </button>
                    )}
                  </div>
                </div>
                {createRuleError && (
                  <div className="flex-shrink-0 px-3 py-2 bg-red-50 border-b border-red-200 text-xs text-red-700">
                    {createRuleError}
                  </div>
                )}
                <div className="flex-1 overflow-auto p-3">
                  {resTab === 'headers' && (
                    <div className="space-y-4">
                      {Object.keys(inspector.resHeaders).length === 0 ? (
                        <div className="text-xs text-gray-400">No headers</div>
                      ) : (
                        <table className="w-full text-left text-xs">
                          <tbody>
                            {Object.entries(inspector.resHeaders).map(([k, v]) => (
                              <tr key={k} className="border-b border-gray-100 last:border-0">
                                <td className="py-1 pr-2 font-medium text-gray-600 align-top whitespace-nowrap">{k}:</td>
                                <td className="py-1 font-mono text-gray-800 break-all">{v as React.ReactNode}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                  )}
                  {resTab === 'body' && (
                    <div className="h-full flex flex-col">
                      {selected.responseBodyTruncated && (
                        <div className="flex-shrink-0 mb-2 p-2 bg-orange-50 text-orange-700 text-xs border border-orange-200 rounded">
                          Body truncated for display (first 256KB).
                        </div>
                      )}
                      <div className="flex-1 min-h-0">
                        {selected.responseBody === undefined ? (
                          <div className="text-xs text-gray-400">No captured body</div>
                        ) : isObject(selected.responseBody) || Array.isArray(selected.responseBody) ? (
                          <JsonViewer value={selected.responseBody} maxHeightClassName="max-h-full" />
                        ) : (
                          <pre className="text-xs text-gray-800 whitespace-pre-wrap break-words font-mono">{String(selected.responseBody)}</pre>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
