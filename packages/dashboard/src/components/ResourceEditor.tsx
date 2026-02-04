/**
 * ResourceEditor component - modal for creating/editing resources
 */

import { useState, useEffect, useRef } from 'react';
import { importApi } from '../api/client';
import type { Resource, CreateResourceRequest, HttpMethod } from '../api/types';

interface ResourceEditorProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (data: CreateResourceRequest) => Promise<void>;
  projectId?: string; // Required for imports
  resource?: Resource; // If provided, we're editing; otherwise creating
}

const HTTP_METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

type CreateMode = 'manual' | 'curl';

export function ResourceEditor({ isOpen, onClose, onSubmit, projectId, resource }: ResourceEditorProps) {
  const [mode, setMode] = useState<CreateMode>('manual');
  const [method, setMethod] = useState<HttpMethod>('GET');
  const [path, setPath] = useState('');
  const [curlCommand, setCurlCommand] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Debug: Log mode changes
  useEffect(() => {
    console.log('[ResourceEditor] Mode changed to:', mode);
  }, [mode]);

  const pathInputRef = useRef<HTMLInputElement>(null);
  const curlInputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (isOpen) {
      console.log('[ResourceEditor] Modal opened, resource:', resource);
      if (resource) {
        // Editing existing resource
        setMethod(resource.method);
        setPath(resource.path);
      } else {
        // Creating new resource
        console.log('[ResourceEditor] Initializing new resource, setting mode to manual');
        setMode('manual');
        setMethod('GET');
        setPath('');
        setCurlCommand('');
      }
      setError(null);
      setIsSubmitting(false);

      // Focus appropriate input
      setTimeout(() => {
        if (mode === 'curl') {
          curlInputRef.current?.focus();
        } else {
          pathInputRef.current?.focus();
        }
      }, 100);
    }
  }, [isOpen, resource]); // Removed 'mode' from dependencies to prevent reset loop

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    console.log('[ResourceEditor] handleSubmit called');
    console.log('[ResourceEditor] mode:', mode);
    console.log('[ResourceEditor] projectId:', projectId);
    console.log('[ResourceEditor] curlCommand length:', curlCommand.length);

    if (mode === 'curl') {
      // Import from cURL command
      if (!curlCommand.trim()) {
        console.error('[ResourceEditor] cURL command is empty');
        setError('cURL command is required');
        return;
      }

      if (!projectId) {
        console.error('[ResourceEditor] projectId is missing');
        setError('Project ID is required for imports');
        return;
      }

      try {
        setIsSubmitting(true);
        console.log('[cURL Import] Starting import with projectId:', projectId);
        console.log('[cURL Import] cURL command:', curlCommand);
        const result = await importApi.importCurl(projectId, { curl: curlCommand });
        console.log('[cURL Import] Success! Imported resources:', result.resources);
        console.log(`Imported ${result.resources.length} resource(s) from cURL command`);
        onClose();

        // Refresh resources list (parent will handle this via re-render)
        window.location.reload(); // Simple approach for now
      } catch (err) {
        console.error('[cURL Import] Error:', err);
        setError(err instanceof Error ? err.message : 'Failed to import cURL command');
      } finally {
        setIsSubmitting(false);
      }
    } else {
      // Manual resource creation
      // Validation
      if (!path.trim()) {
        setError('Path is required');
        return;
      }

      if (!path.startsWith('/')) {
        setError('Path must start with /');
        return;
      }

      try {
        setIsSubmitting(true);
        await onSubmit({
          method,
          path: path.trim(),
        });
        onClose();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to save resource');
      } finally {
        setIsSubmitting(false);
      }
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape' && !isSubmitting) {
      onClose();
    }
  };

  if (!isOpen) return null;

  const isEditing = !!resource;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50"
      onClick={(e) => {
        if (e.target === e.currentTarget && !isSubmitting) {
          onClose();
        }
      }}
      onKeyDown={handleKeyDown}
    >
      <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl mx-4">
        <div className="px-6 py-4 border-b border-gray-200">
          <h2 className="text-xl font-semibold text-gray-900">
            {isEditing ? 'Edit Resource' : 'Create New Resource'}
          </h2>

          {/* Mode Toggle - only show when creating new resources */}
          {!isEditing && (
            <div className="flex gap-2 mt-4">
              <button
                type="button"
                onClick={() => {
                  console.log('[ResourceEditor] Switching to manual mode');
                  setMode('manual');
                }}
                className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
                  mode === 'manual'
                    ? 'bg-blue-100 text-blue-700 border border-blue-300'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
              >
                Manual Setup
              </button>
              <button
                type="button"
                onClick={() => {
                  console.log('[ResourceEditor] Switching to cURL mode');
                  setMode('curl');
                }}
                className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
                  mode === 'curl'
                    ? 'bg-blue-100 text-blue-700 border border-blue-300'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
              >
                Import from cURL
              </button>
            </div>
          )}
        </div>

        <form onSubmit={handleSubmit}>
          <div className="px-6 py-4 space-y-4">
            {error && (
              <div className="p-3 bg-red-50 border border-red-200 rounded text-sm text-red-800">
                {error}
              </div>
            )}

            {mode === 'manual' || isEditing ? (
              <>
                <div>
                  <label htmlFor="resource-method" className="block text-sm font-medium text-gray-700 mb-1">
                    HTTP Method <span className="text-red-500">*</span>
                  </label>
                  <select
                    id="resource-method"
                    value={method}
                    onChange={(e) => setMethod(e.target.value as HttpMethod)}
                    disabled={isSubmitting || isEditing}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:bg-gray-100 disabled:cursor-not-allowed"
                  >
                    {HTTP_METHODS.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                  {isEditing && (
                    <p className="mt-1 text-xs text-gray-500">
                      Method cannot be changed after creation
                    </p>
                  )}
                </div>

                <div>
                  <label htmlFor="resource-path" className="block text-sm font-medium text-gray-700 mb-1">
                    Path <span className="text-red-500">*</span>
                  </label>
                  <input
                    ref={pathInputRef}
                    id="resource-path"
                    type="text"
                    value={path}
                    onChange={(e) => setPath(e.target.value)}
                    disabled={isSubmitting || isEditing}
                    className="w-full px-3 py-2 font-mono text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:bg-gray-100 disabled:cursor-not-allowed"
                    placeholder="/api/users/:id"
                    maxLength={200}
                  />
                  {isEditing ? (
                    <p className="mt-1 text-xs text-gray-500">
                      Path cannot be changed after creation
                    </p>
                  ) : (
                    <p className="mt-1 text-xs text-gray-500">
                      Use :paramName for path parameters (e.g., /users/:id)
                    </p>
                  )}
                </div>

                {!isEditing && (
                  <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                    <h4 className="text-sm font-medium text-blue-900 mb-2">What happens next?</h4>
                    <ul className="text-xs text-blue-800 space-y-1">
                      <li>• A default scenario will be created automatically</li>
                      <li>• You can add more scenarios after creation</li>
                      <li>• Path parameters will be available in scenario responses</li>
                    </ul>
                  </div>
                )}
              </>
            ) : (
              <>
                <div>
                  <label htmlFor="curl-command" className="block text-sm font-medium text-gray-700 mb-1">
                    cURL Command(s) <span className="text-red-500">*</span>
                  </label>
                  <textarea
                    ref={curlInputRef}
                    id="curl-command"
                    value={curlCommand}
                    onChange={(e) => setCurlCommand(e.target.value)}
                    disabled={isSubmitting}
                    className="w-full px-3 py-2 font-mono text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:bg-gray-100 disabled:cursor-not-allowed resize-vertical"
                    placeholder='Paste your cURL command(s) here, e.g.:&#10;curl -X GET "https://api.example.com/users/123"&#10;&#10;You can paste multiple cURL commands at once!'
                    rows={8}
                  />
                  <p className="mt-1 text-xs text-gray-500">
                    Paste one or more cURL commands. The method, path, headers, and body will be extracted automatically.
                  </p>
                </div>

                <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                  <h4 className="text-sm font-medium text-blue-900 mb-2">What will be imported?</h4>
                  <ul className="text-xs text-blue-800 space-y-1">
                    <li>• HTTP method and path from the URL</li>
                    <li>• Headers from -H flags</li>
                    <li>• Request body from -d, --data, or --data-raw</li>
                    <li>• Each command creates a separate resource</li>
                  </ul>
                </div>
              </>
            )}
          </div>

          <div className="px-6 py-4 border-t border-gray-200 flex justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting || (mode === 'manual' || isEditing ? !path.trim() : !curlCommand.trim())}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {isSubmitting
                ? (mode === 'curl' ? 'Importing...' : isEditing ? 'Saving...' : 'Creating...')
                : (mode === 'curl' ? 'Import from cURL' : isEditing ? 'Save Changes' : 'Create Resource')
              }
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
