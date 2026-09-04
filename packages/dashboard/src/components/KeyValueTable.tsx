import { useState } from 'react';

export interface KeyValueItem {
  key: string;
  value: string;
}

interface KeyValueTableProps {
  title?: string;
  items: KeyValueItem[];
  onChange: (items: KeyValueItem[]) => void;
  readonly?: boolean;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
}

export function KeyValueTable({
  title,
  items,
  onChange,
  readonly = false,
  keyPlaceholder = 'key',
  valuePlaceholder = 'value',
}: KeyValueTableProps) {
  const [editingIndex, setEditingIndex] = useState<number | null>(null);

  const handleAdd = () => {
    onChange([...items, { key: '', value: '' }]);
    setEditingIndex(items.length);
  };

  const handleUpdate = (index: number, field: 'key' | 'value', value: string) => {
    const next = [...items];
    next[index] = { ...next[index], [field]: value };
    onChange(next);
  };

  const handleDelete = (index: number) => {
    onChange(items.filter((_, i) => i !== index));
    if (editingIndex === index) setEditingIndex(null);
  };

  return (
    <div className="space-y-2">
      {title ? <div className="text-xs font-semibold text-gray-700">{title}</div> : null}

      {items.length === 0 && readonly ? (
        <div className="text-sm text-gray-500 italic py-2">None</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 border border-gray-200 rounded-md">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-700 uppercase tracking-wider w-1/2">Key</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-700 uppercase tracking-wider w-1/2">Value</th>
                {!readonly ? (
                  <th className="px-3 py-2 text-right text-xs font-medium text-gray-700 uppercase tracking-wider w-16">Actions</th>
                ) : null}
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {items.map((item, index) => (
                <tr key={index} className="hover:bg-gray-50">
                  <td className="px-3 py-2">
                    <input
                      type="text"
                      value={item.key}
                      onChange={(e) => handleUpdate(index, 'key', e.target.value)}
                      disabled={readonly}
                      className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-sky-500 disabled:bg-gray-50 disabled:text-gray-600"
                      placeholder={keyPlaceholder}
                      autoFocus={editingIndex === index}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="text"
                      value={item.value}
                      onChange={(e) => handleUpdate(index, 'value', e.target.value)}
                      disabled={readonly}
                      className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-sky-500 disabled:bg-gray-50 disabled:text-gray-600"
                      placeholder={valuePlaceholder}
                    />
                  </td>
                  {!readonly ? (
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        onClick={() => handleDelete(index)}
                        className="p-1 text-rose-600 hover:text-rose-800 hover:bg-rose-50 rounded transition-colors"
                        title="Delete"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!readonly ? (
        <button
          type="button"
          onClick={handleAdd}
          className="px-3 py-1.5 text-sm text-sky-700 hover:text-sky-800 hover:bg-sky-50 rounded transition-colors flex items-center gap-1"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Add
        </button>
      ) : null}
    </div>
  );
}
