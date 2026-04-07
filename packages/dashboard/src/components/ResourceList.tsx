import { useMemo, useState } from 'react';
import { ConfirmDialog } from './ConfirmDialog';
import type { Resource } from '../api/types';

interface ResourceListProps {
  resources: Resource[];
  onSelectResource: (resource: Resource) => void;
  onNewResource: () => void;
  onEditResource: (resource: Resource) => void;
  onDeleteResource: (id: string) => void;
  loading?: boolean;
  selectedResourceId?: string;
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

export function ResourceList({
  resources,
  onSelectResource,
  onNewResource,
  onEditResource,
  onDeleteResource,
  loading = false,
  selectedResourceId,
}: ResourceListProps) {
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [resourceToDelete, setResourceToDelete] = useState<Resource | null>(null);
  const [filter, setFilter] = useState('');

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return resources;
    return resources.filter(r => {
      const match = JSON.stringify(r.match ?? {});
      const s = `${r.method} ${r.host ?? ''} ${r.path} ${match}`.toLowerCase();
      return s.includes(q);
    });
  }, [filter, resources]);

  const handleDeleteClick = (resource: Resource) => {
    setResourceToDelete(resource);
    setDeleteDialogOpen(true);
  };

  const confirmDelete = () => {
    if (resourceToDelete) {
      onDeleteResource(resourceToDelete.id);
      setDeleteDialogOpen(false);
      setResourceToDelete(null);
    }
  };

  if (loading) {
    return (
      <div className="p-4">
        <div className="animate-pulse space-y-3">
          <div className="h-4 bg-gray-200 rounded w-1/2 mb-4"></div>
          <div className="h-10 bg-gray-100 rounded"></div>
          <div className="h-10 bg-gray-100 rounded"></div>
          <div className="h-10 bg-gray-100 rounded"></div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-white">
      {/* Header & Search */}
      <div className="flex-shrink-0 h-11 border-b border-gray-200 bg-[#F3F3F3] px-3 flex items-center justify-between">
        <div className="relative flex-1 mr-2 max-w-xs">
          <svg className="absolute left-2.5 top-1.5 w-3.5 h-3.5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search rules..."
            className="w-full pl-8 pr-3 py-1 text-xs border border-gray-300 rounded shadow-sm focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
          />
        </div>

        <button
          onClick={onNewResource}
          className="px-2 py-1 text-xs font-medium bg-white border border-gray-300 rounded shadow-sm text-gray-700 hover:bg-gray-50 flex items-center gap-1"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Add Rule
        </button>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {resources.length === 0 ? (
          <div className="p-8 text-center text-gray-500 text-sm">
            No rules defined.
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-8 text-center text-gray-500 text-sm">
            No rules match search.
          </div>
        ) : (
          <ul className="divide-y divide-gray-100">
            {filtered.map((resource) => {
              const isSelected = resource.id === selectedResourceId;
              const hasMatch = (resource.match?.query && Object.keys(resource.match.query).length > 0) || 
                               (resource.match?.headers && Object.keys(resource.match.headers).length > 0);
              
              return (
                <li
                  key={resource.id}
                  onClick={() => onSelectResource(resource)}
                  className={`group relative px-3 py-2 cursor-pointer transition-colors border-b border-gray-100 last:border-0 ${
                    isSelected ? 'bg-blue-500 text-white' : 'hover:bg-gray-50 text-gray-800'
                  }`}
                >
                  <div className="flex items-center justify-between mb-0.5">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={`text-[11px] font-bold ${isSelected ? 'text-white' : methodColor(resource.method)}`}>
                        {resource.method}
                      </span>
                      <span className={`text-xs font-mono truncate ${isSelected ? 'text-white' : 'text-gray-900'}`}>
                        {resource.path}
                      </span>
                    </div>
                  </div>
                  
                  <div className="flex items-center justify-between">
                    <div className={`text-[11px] font-mono truncate ${isSelected ? 'text-blue-100' : 'text-gray-500'}`}>
                      {resource.host ? resource.host : '*'}
                      {hasMatch ? ' (with match conditions)' : ''}
                    </div>
                    <div className={`text-[11px] flex-shrink-0 ${isSelected ? 'text-blue-100' : 'text-gray-400'}`}>
                      {resource.scenarios.length} scenarios
                    </div>
                  </div>

                  {/* Actions (visible on hover) */}
                  <div className={`absolute right-2 top-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity ${isSelected ? 'text-white' : 'text-gray-500'}`}>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onEditResource(resource);
                      }}
                      className={`p-1 rounded ${isSelected ? 'hover:bg-blue-600' : 'hover:bg-gray-200'}`}
                      title="Edit Rule Settings"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                      </svg>
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteClick(resource);
                      }}
                      className={`p-1 rounded ${isSelected ? 'hover:bg-blue-600' : 'hover:bg-gray-200 hover:text-red-600'}`}
                      title="Delete Rule"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <ConfirmDialog
        isOpen={deleteDialogOpen}
        title="Delete Rule"
        message={resourceToDelete ? `Delete resource "${resourceToDelete.method} ${resourceToDelete.path}"?\n\nThis will also delete all ${resourceToDelete.scenarios.length} scenario(s). This action cannot be undone.` : ''}
        confirmLabel="Delete Rule"
        variant="danger"
        onConfirm={confirmDelete}
        onCancel={() => {
          setDeleteDialogOpen(false);
          setResourceToDelete(null);
        }}
      />
    </div>
  );
}
