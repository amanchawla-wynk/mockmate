import { useMemo, useState } from 'react';
import type { RequestLogEntry } from '../api/types';

interface LogsViewProps {
  logs: RequestLogEntry[];
  loading?: boolean;
  error?: string | null;
  paused: boolean;
  onTogglePaused: (paused: boolean) => void;
  onClear: () => void;
  onRefresh: () => void;
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

export function LogsView({ logs, loading, error, paused, onTogglePaused, onClear, onRefresh }: LogsViewProps) {
  const [filter, setFilter] = useState('');

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return logs;
    return logs.filter((l) => {
      const s = `${l.method} ${l.host ?? ''} ${l.path} ${l.statusCode} ${l.scenario ?? ''} ${l.proxied ? 'proxied' : 'mock'}`.toLowerCase();
      return s.includes(q);
    });
  }, [filter, logs]);

  return (
    <div className="h-full flex flex-col bg-white overflow-hidden">
      {/* Toolbar */}
      <div className="flex-shrink-0 h-11 border-b border-gray-200 bg-[#F3F3F3] px-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter logs..."
            className="w-64 px-2 py-1 text-xs border border-gray-300 rounded shadow-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>
        
        <div className="flex items-center gap-2">
          {loading && <span className="text-xs text-gray-500">Loading...</span>}
          {error && <span className="text-xs text-red-500">{error}</span>}
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

      <div className="flex-1 overflow-auto bg-white">
        <table className="min-w-full text-xs text-left">
          <thead className="bg-[#F9F9F9] text-gray-600 sticky top-0 z-10 border-b border-gray-200">
            <tr>
              <th className="font-semibold px-3 py-1.5 whitespace-nowrap">Time</th>
              <th className="font-semibold px-3 py-1.5 whitespace-nowrap">Method</th>
              <th className="font-semibold px-3 py-1.5">Host</th>
              <th className="font-semibold px-3 py-1.5">Path</th>
              <th className="font-semibold px-3 py-1.5 whitespace-nowrap">Status</th>
              <th className="font-semibold px-3 py-1.5 whitespace-nowrap">Mode</th>
              <th className="font-semibold px-3 py-1.5 whitespace-nowrap">Scenario</th>
              <th className="font-semibold px-3 py-1.5 text-right whitespace-nowrap">Duration</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {filtered.map((l) => (
              <tr key={l.id} className="hover:bg-gray-50 text-gray-800">
                <td className="px-3 py-1 text-gray-500 whitespace-nowrap tabular-nums">
                  {new Date(l.timestamp).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 })}
                </td>
                <td className="px-3 py-1 whitespace-nowrap">
                  <span className={`font-semibold ${methodColor(l.method)}`}>{l.method}</span>
                </td>
                <td className="px-3 py-1 font-mono text-gray-600 break-all">{l.host ?? '-'}</td>
                <td className="px-3 py-1 font-mono break-all">{l.path}</td>
                <td className={`px-3 py-1 font-semibold ${statusColor(l.statusCode)} whitespace-nowrap`}>{l.statusCode}</td>
                <td className="px-3 py-1 text-gray-500 whitespace-nowrap">{l.proxied ? 'Proxy' : 'Mock'}</td>
                <td className="px-3 py-1 text-gray-500 whitespace-nowrap">{l.scenario ?? '-'}</td>
                <td className="px-3 py-1 text-right text-gray-500 tabular-nums whitespace-nowrap">{l.duration}ms</td>
              </tr>
            ))}
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-gray-400">No logs found</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}