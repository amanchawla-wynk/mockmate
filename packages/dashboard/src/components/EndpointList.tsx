import type { EndpointSummary } from '../api/types';

export interface EndpointListProps {
  endpoints: EndpointSummary[];
  selectedEndpointId?: string;
  loading?: boolean;
  onSelect(endpointId: string): void;
  onImport(): void;
  onCreate(): void;
}

export function EndpointList({
  endpoints,
  selectedEndpointId,
  loading = false,
  onSelect,
  onImport,
  onCreate,
}: EndpointListProps) {
  return (
    <div className="flex h-full flex-col bg-white">
      <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
        <h3 className="text-sm font-semibold text-gray-800">Endpoints</h3>
        <div className="flex items-center gap-2">
          <button type="button" onClick={onImport} className="rounded border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50">
            Import
          </button>
          <button type="button" onClick={onCreate} className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700">
            New Endpoint
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {loading ? <p className="p-3 text-xs text-gray-500">Loading Endpoints...</p> : null}
        {!loading && endpoints.length === 0 ? <p className="p-3 text-xs text-gray-500">No Endpoints yet.</p> : null}
        {endpoints.map(endpoint => (
          <button
            key={endpoint.id}
            type="button"
            onClick={() => onSelect(endpoint.id)}
            className={`mb-1 w-full rounded-md border px-3 py-2 text-left ${selectedEndpointId === endpoint.id ? 'border-blue-300 bg-blue-50' : 'border-transparent hover:bg-gray-50'}`}
          >
            <span className="block truncate text-sm font-medium text-gray-900">{endpoint.name}</span>
            <span className="mt-1 block truncate font-mono text-xs text-gray-500">
              {endpoint.method} {endpoint.baseUrl}{endpoint.path}
            </span>
            <span className="mt-1 flex flex-wrap gap-x-2 text-[11px] text-gray-500">
              <span>{endpoint.mode === 'mock' ? 'Mock' : 'Passthrough'}</span>
              <span>{endpoint.mockReady ? 'Mock ready' : 'Mock not ready'}</span>
              <span>{`${endpoint.variantCount} ${endpoint.variantCount === 1 ? 'variant' : 'variants'}`}</span>
              <span>{`${endpoint.queryConstraintCount} query expressions`}</span>
              <span>{`${endpoint.headerConstraintCount} header constraints`}</span>
              {' · '}
              <span>{`revision ${endpoint.revision}`}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
