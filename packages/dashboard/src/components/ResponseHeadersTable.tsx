/**
 * ResponseHeadersTable component - table for editing response headers
 */

interface ResponseHeadersTableProps {
  headers: Record<string, string>;
  onChange: (headers: Record<string, string>) => void;
  readonly?: boolean;
}

export function ResponseHeadersTable({ headers, onChange, readonly = false }: ResponseHeadersTableProps) {
  const entries = Object.entries(headers);

  const handleAdd = () => {
    onChange({ ...headers, '': '' });
  };

  const handleUpdateKey = (oldKey: string, newKey: string) => {
    const updated = { ...headers };
    if (oldKey !== newKey) {
      delete updated[oldKey];
      updated[newKey] = headers[oldKey];
    }
    onChange(updated);
  };

  const handleUpdateValue = (key: string, value: string) => {
    onChange({ ...headers, [key]: value });
  };

  const handleDelete = (key: string) => {
    const updated = { ...headers };
    delete updated[key];
    onChange(updated);
  };

  if (entries.length === 0 && readonly) {
    return (
      <div className="text-sm text-gray-500 italic py-2">
        No headers defined
      </div>
    );
  }

  return (
    <div className="space-y-2">
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
            {entries.map(([key, value], index) => (
              <tr key={index} className="hover:bg-gray-50">
                <td className="px-3 py-2">
                  <input
                    type="text"
                    value={key}
                    onChange={(e) => handleUpdateKey(key, e.target.value)}
                    disabled={readonly}
                    className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-gray-50 disabled:text-gray-600"
                    placeholder="Content-Type"
                  />
                </td>
                <td className="px-3 py-2">
                  <input
                    type="text"
                    value={value}
                    onChange={(e) => handleUpdateValue(key, e.target.value)}
                    disabled={readonly}
                    className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-gray-50 disabled:text-gray-600"
                    placeholder="application/json"
                  />
                </td>
                {!readonly && (
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => handleDelete(key)}
                      className="p-1 text-red-600 hover:text-red-800 hover:bg-red-50 rounded transition-colors"
                      title="Delete header"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                        />
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
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 4v16m8-8H4"
            />
          </svg>
          Add Header
        </button>
      )}
    </div>
  );
}
