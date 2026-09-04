import type { ResponseHeaders } from '../api/types';

export interface HeaderRow {
  id: string;
  name: string;
  value: string;
}

// eslint-disable-next-line react-refresh/only-export-components
export function responseHeadersToRows(headers: ResponseHeaders): HeaderRow[] {
  let index = 0;
  return Object.entries(headers).flatMap(([name, value]) =>
    (Array.isArray(value) ? value : [value]).map(item => ({
      id: `persisted-header-${index++}`,
      name,
      value: item,
    })),
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function responseHeaderRowsToRecord(rows: HeaderRow[]): ResponseHeaders {
  const canonicalNames = new Map<string, string>();
  const grouped = new Map<string, string[]>();
  for (const row of rows) {
    const name = row.name.trim();
    if (!name) throw new Error('Header name is required');
    const normalized = name.toLowerCase();
    const canonical = canonicalNames.get(normalized) ?? name;
    canonicalNames.set(normalized, canonical);
    grouped.set(canonical, [...(grouped.get(canonical) ?? []), row.value]);
  }
  return Object.fromEntries([...grouped].map(([name, values]) => [
    name,
    values.length === 1 ? values[0] : values,
  ]));
}

interface HeadersTableProps {
  label: string;
  rows: HeaderRow[];
  onChange: (rows: HeaderRow[]) => void;
  error?: string;
  readonly?: boolean;
}

export function HeadersTable({
  label,
  rows,
  onChange,
  error,
  readonly = false,
}: HeadersTableProps) {
  const handleAdd = () => {
    onChange([...rows, { id: crypto.randomUUID(), name: '', value: '' }]);
  };

  const handleUpdate = (id: string, patch: Partial<Pick<HeaderRow, 'name' | 'value'>>) => {
    onChange(rows.map(row => row.id === id ? { ...row, ...patch } : row));
  };

  const handleDelete = (id: string) => {
    onChange(rows.filter(row => row.id !== id));
  };

  return (
    <section className="space-y-2">
      <h4 className="text-sm font-semibold text-gray-800">{label}</h4>
      {rows.length === 0 && readonly ? (
        <div className="text-sm text-gray-500 italic py-2">No headers defined</div>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 border border-gray-200 rounded-md">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-700 uppercase tracking-wider w-1/3">
                    Header Name
                  </th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-700 uppercase tracking-wider w-2/3">
                    Value
                  </th>
                  {!readonly && (
                    <th className="px-3 py-2 text-right text-xs font-medium text-gray-700 uppercase tracking-wider w-16">
                      Actions
                    </th>
                  )}
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {rows.map(row => (
                  <tr key={row.id} className="hover:bg-gray-50">
                    <td className="px-3 py-2">
                      <input
                        type="text"
                        value={row.name}
                        onChange={event => handleUpdate(row.id, { name: event.target.value })}
                        disabled={readonly}
                        className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-gray-50 disabled:text-gray-600"
                        placeholder="Content-Type"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <input
                        type="text"
                        value={row.value}
                        onChange={event => handleUpdate(row.id, { value: event.target.value })}
                        disabled={readonly}
                        className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-gray-50 disabled:text-gray-600"
                        placeholder="application/json"
                      />
                    </td>
                    {!readonly && (
                      <td className="px-3 py-2 text-right">
                        <button
                          type="button"
                          onClick={() => handleDelete(row.id)}
                          className="p-1 text-red-600 hover:text-red-800 hover:bg-red-50 rounded transition-colors"
                          title="Delete header"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!readonly && (
            <button
              type="button"
              onClick={handleAdd}
              className="px-3 py-1.5 text-sm text-blue-600 hover:text-blue-700 hover:bg-blue-50 rounded transition-colors flex items-center gap-1"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              Add Header
            </button>
          )}
        </>
      )}
      {error && <p className="text-sm text-red-700">{error}</p>}
    </section>
  );
}
