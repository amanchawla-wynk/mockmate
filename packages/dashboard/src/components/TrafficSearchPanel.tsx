import type {
  TrafficJsonSearchResult,
  TrafficJsonSearchSkipped,
} from '../api/types';

export interface TrafficSearchPanelProps {
  query: string;
  onQueryChange(value: string): void;
  results: TrafficJsonSearchResult[];
  skipped: TrafficJsonSearchSkipped;
  activeQuery: string;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  hasMore: boolean;
  onLoadMore(): void;
  onOpenResult(result: TrafficJsonSearchResult): void;
  onClose(): void;
}

const SKIPPED_LABELS: Record<keyof TrafficJsonSearchSkipped, string> = {
  unavailable: 'unavailable',
  truncated: 'truncated',
  evicted: 'evicted',
  unsupportedEncoding: 'could not decode',
  invalidUtf8: 'invalid UTF-8',
  notJson: 'not valid JSON',
  changedDuringSearch: 'changed during search',
  searchBudgetExceeded: 'too large to search',
};

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

function completedTime(completedAt: string): string {
  const parsed = new Date(completedAt);
  return Number.isNaN(parsed.getTime())
    ? completedAt
    : parsed.toLocaleTimeString([], { hour12: false });
}

function skippedSummary(skipped: TrafficJsonSearchSkipped): string | null {
  const keys = Object.keys(SKIPPED_LABELS) as Array<keyof TrafficJsonSearchSkipped>;
  const active = keys.filter(key => skipped[key] > 0);
  if (active.length === 0) return null;
  const total = active.reduce((sum, key) => sum + skipped[key], 0);
  const parts = active.map(key => `${SKIPPED_LABELS[key]} ${skipped[key]}`);
  return `${total} ${total === 1 ? 'body' : 'bodies'} skipped: ${parts.join(', ')}`;
}

export function TrafficSearchPanel({
  query,
  onQueryChange,
  results,
  skipped,
  activeQuery,
  loading,
  loadingMore,
  error,
  hasMore,
  onLoadMore,
  onOpenResult,
  onClose,
}: TrafficSearchPanelProps) {
  const skippedText = skippedSummary(skipped);
  const showEmpty = !loading && activeQuery.length > 0 && results.length === 0 && error === null;

  return (
    <div className="flex min-h-0 flex-col border-b border-gray-200 bg-white">
      <div className="flex items-center gap-2 border-b border-gray-100 px-3 py-2">
        <input
          type="search"
          value={query}
          onChange={event => onQueryChange(event.target.value)}
          placeholder="Search request/response JSON..."
          aria-label="Search JSON bodies"
          className="w-full rounded border border-gray-300 px-2 py-1 text-xs shadow-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
        {loading ? <span className="whitespace-nowrap text-xs text-gray-500">Searching...</span> : null}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close JSON search"
          className="rounded border border-gray-300 bg-white px-2 py-1 text-xs text-gray-600"
        >
          Close
        </button>
      </div>

      <div className="max-h-64 min-h-0 flex-1 overflow-auto">
        {error ? <p className="px-3 py-2 text-xs text-red-600" role="alert">{error}</p> : null}
        {skippedText ? <p className="px-3 py-1 text-[11px] text-amber-700">{skippedText}</p> : null}
        {showEmpty ? <p className="px-3 py-6 text-center text-xs text-gray-400">No JSON matches</p> : null}

        {results.map(result => (
          <button
            type="button"
            key={`${result.traffic.id}:${result.side}`}
            onClick={() => onOpenResult(result)}
            className="block w-full border-b border-gray-100 px-3 py-2 text-left hover:bg-gray-50"
          >
            <span className="flex flex-wrap items-center gap-x-2 text-xs">
              <span className={`font-semibold ${methodColor(result.traffic.method)}`}>{result.traffic.method}</span>
              <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] uppercase text-gray-600">{result.side}</span>
              <span className="text-gray-500">{result.traffic.status}</span>
              <span className="text-gray-500">
                {result.matchCount} {result.matchCount === 1 ? 'match' : 'matches'}
              </span>
              <span className="text-gray-400">{completedTime(result.traffic.completedAt)}</span>
            </span>
            <span className="mt-0.5 block truncate font-mono text-[11px] text-gray-700" title={`${result.traffic.origin}${result.traffic.path}`}>
              {result.traffic.origin}{result.traffic.path}
            </span>
            {result.matches.length > 0 ? (
              <span className="mt-0.5 block truncate font-mono text-[11px] text-gray-500">
                {result.matches.map(match => match.snippet).join('  ·  ')}
              </span>
            ) : null}
          </button>
        ))}

        {hasMore ? (
          <div className="p-2">
            <button
              type="button"
              onClick={onLoadMore}
              disabled={loadingMore}
              className="w-full rounded border border-gray-300 bg-white px-2 py-1 text-xs text-gray-700 disabled:opacity-60"
            >
              {loadingMore ? 'Loading...' : 'Load more'}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
