/**
 * ResourceList component - displays resources for a project
 */

import { useState } from 'react';
import { ConfirmDialog } from './ConfirmDialog';
import type { Resource } from '../api/types';

interface ResourceListProps {
  resources: Resource[];
  onSelectResource: (resource: Resource) => void;
  onNewResource: () => void;
  onDeleteResource: (id: string) => void;
  loading?: boolean;
  selectedResourceId?: string;
}

const HTTP_METHOD_COLORS = {
  GET: 'bg-blue-100 text-blue-800',
  POST: 'bg-green-100 text-green-800',
  PUT: 'bg-yellow-100 text-yellow-800',
  PATCH: 'bg-orange-100 text-orange-800',
  DELETE: 'bg-red-100 text-red-800',
};

export function ResourceList({
  resources,
  onSelectResource,
  onNewResource,
  onDeleteResource,
  loading = false,
  selectedResourceId,
}: ResourceListProps) {
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [resourceToDelete, setResourceToDelete] = useState<Resource | null>(null);

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
          <div className="h-4 bg-gray-300 rounded w-1/2 mb-4"></div>
          <div className="h-16 bg-gray-200 rounded"></div>
          <div className="h-16 bg-gray-200 rounded"></div>
          <div className="h-16 bg-gray-200 rounded"></div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="p-4 border-b border-gray-200">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-900">Resources</h2>
          <button
            onClick={onNewResource}
            className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors"
            aria-label="Create new resource"
          >
            + Add Resource
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {resources.length === 0 ? (
          <div className="p-8 text-center">
            <div className="text-gray-400 mb-2">
              <svg
                className="w-16 h-16 mx-auto"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                />
              </svg>
            </div>
            <p className="text-gray-500 text-sm mb-4">
              No resources yet. Add a resource to start mocking API endpoints.
            </p>
            <button
              onClick={onNewResource}
              className="px-4 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors"
            >
              Create Your First Resource
            </button>
          </div>
        ) : (
          <div className="p-4 space-y-2">
            {resources.map((resource) => {
              const isSelected = resource.id === selectedResourceId;
              const scenarioCount = resource.scenarios.length;

              return (
                <div
                  key={resource.id}
                  className={`
                    group relative rounded-lg border transition-all cursor-pointer
                    ${isSelected
                      ? 'border-blue-300 bg-blue-50 shadow-sm'
                      : 'border-gray-200 bg-white hover:border-gray-300 hover:shadow-sm'
                    }
                  `}
                  onClick={() => onSelectResource(resource)}
                >
                  <div className="p-4">
                    <div className="flex items-start justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <span
                          className={`
                            px-2 py-0.5 text-xs font-semibold rounded
                            ${HTTP_METHOD_COLORS[resource.method]}
                          `}
                        >
                          {resource.method}
                        </span>
                        <code className={`
                          text-sm font-mono
                          ${isSelected ? 'text-blue-900' : 'text-gray-900'}
                        `}>
                          {resource.path}
                        </code>
                      </div>

                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteClick(resource);
                        }}
                        className={`
                          opacity-0 group-hover:opacity-100
                          p-1.5 text-red-600 hover:text-red-800 hover:bg-red-50 rounded
                          transition-opacity
                        `}
                        aria-label={`Delete ${resource.method} ${resource.path}`}
                      >
                        <svg
                          className="w-4 h-4"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                          />
                        </svg>
                      </button>
                    </div>

                    <div className="flex items-center gap-4 text-xs text-gray-500">
                      <span className="flex items-center gap-1">
                        <svg
                          className="w-3.5 h-3.5"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01"
                          />
                        </svg>
                        {scenarioCount} {scenarioCount === 1 ? 'scenario' : 'scenarios'}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {resources.length > 0 && (
        <div className="p-3 border-t border-gray-200 text-xs text-gray-500">
          {resources.length} {resources.length === 1 ? 'resource' : 'resources'}
        </div>
      )}

      {/* Delete Resource Dialog */}
      <ConfirmDialog
        isOpen={deleteDialogOpen}
        title="Delete Resource"
        message={resourceToDelete ? `Delete resource "${resourceToDelete.method} ${resourceToDelete.path}"?\n\nThis will also delete all ${resourceToDelete.scenarios.length} scenario(s). This action cannot be undone.` : ''}
        confirmLabel="Delete Resource"
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
