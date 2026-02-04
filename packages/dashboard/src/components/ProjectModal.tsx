/**
 * ProjectModal component - modal for creating new projects
 */

import { useState, useEffect, useRef } from 'react';
import { importApi } from '../api/client';
import type { CreateProjectRequest } from '../api/types';

interface ProjectModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (data: CreateProjectRequest) => Promise<void>;
}

type ImportMode = 'manual' | 'postman';

export function ProjectModal({ isOpen, onClose, onSubmit }: ProjectModalProps) {
  const [mode, setMode] = useState<ImportMode>('manual');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [postmanJson, setPostmanJson] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameInputRef = useRef<HTMLInputElement>(null);
  const postmanInputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (isOpen) {
      // Reset form when modal opens
      setMode('manual');
      setName('');
      setDescription('');
      setBaseUrl('');
      setPostmanJson('');
      setError(null);
      setIsSubmitting(false);

      // Focus name input when modal opens
      setTimeout(() => {
        nameInputRef.current?.focus();
      }, 100);
    }
  }, [isOpen]);

  // Handle focus when mode changes
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => {
        if (mode === 'postman') {
          postmanInputRef.current?.focus();
        } else {
          nameInputRef.current?.focus();
        }
      }, 100);
    }
  }, [mode, isOpen]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (mode === 'postman') {
      // Import from Postman collection
      if (!postmanJson.trim()) {
        setError('Postman collection JSON is required');
        return;
      }

      try {
        setIsSubmitting(true);
        const collection = JSON.parse(postmanJson);
        const result = await importApi.importPostmanAsProject({ collection });

        // Notify parent and close
        console.log(`Created project "${result.project.name}" with ${result.resources.length} resources`);
        onClose();

        // Refresh projects list (parent will handle this via re-render)
        window.location.reload(); // Simple approach for now
      } catch (err) {
        if (err instanceof SyntaxError) {
          setError('Invalid JSON: Please paste a valid Postman collection');
        } else {
          setError(err instanceof Error ? err.message : 'Failed to import Postman collection');
        }
      } finally {
        setIsSubmitting(false);
      }
    } else {
      // Manual project creation
      if (!name.trim()) {
        setError('Project name is required');
        return;
      }

      try {
        setIsSubmitting(true);
        await onSubmit({
          name: name.trim(),
          description: description.trim() || undefined,
          baseUrl: baseUrl.trim() || undefined,
        });
        onClose();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to create project');
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
          <h2 className="text-xl font-semibold text-gray-900">Create New Project</h2>

          {/* Mode Toggle */}
          <div className="flex gap-2 mt-4">
            <button
              type="button"
              onClick={() => setMode('manual')}
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
              onClick={() => setMode('postman')}
              className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
                mode === 'postman'
                  ? 'bg-blue-100 text-blue-700 border border-blue-300'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              Import from Postman
            </button>
          </div>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="px-6 py-4 space-y-4">
            {error && (
              <div className="p-3 bg-red-50 border border-red-200 rounded text-sm text-red-800">
                {error}
              </div>
            )}

            {mode === 'manual' ? (
              <>
                <div>
                  <label htmlFor="project-name" className="block text-sm font-medium text-gray-700 mb-1">
                    Project Name <span className="text-red-500">*</span>
                  </label>
                  <input
                    ref={nameInputRef}
                    id="project-name"
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    disabled={isSubmitting}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:bg-gray-100 disabled:cursor-not-allowed"
                    placeholder="My API Project"
                    maxLength={100}
                  />
                </div>

                <div>
                  <label htmlFor="project-description" className="block text-sm font-medium text-gray-700 mb-1">
                    Description
                  </label>
                  <textarea
                    id="project-description"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    disabled={isSubmitting}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:bg-gray-100 disabled:cursor-not-allowed resize-none"
                    placeholder="Optional description of your project"
                    rows={3}
                    maxLength={500}
                  />
                </div>

                <div>
                  <label htmlFor="project-baseUrl" className="block text-sm font-medium text-gray-700 mb-1">
                    Base URL
                  </label>
                  <input
                    id="project-baseUrl"
                    type="text"
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    disabled={isSubmitting}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:bg-gray-100 disabled:cursor-not-allowed"
                    placeholder="https://api.example.com"
                    maxLength={200}
                  />
                  <p className="mt-1 text-xs text-gray-500">
                    Real API server URL for passthrough mode (e.g., https://api.example.com)
                  </p>
                </div>
              </>
            ) : (
              <>
                <div>
                  <label htmlFor="postman-json" className="block text-sm font-medium text-gray-700 mb-1">
                    Postman Collection JSON <span className="text-red-500">*</span>
                  </label>
                  <textarea
                    ref={postmanInputRef}
                    id="postman-json"
                    value={postmanJson}
                    onChange={(e) => setPostmanJson(e.target.value)}
                    disabled={isSubmitting}
                    className="w-full px-3 py-2 font-mono text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:bg-gray-100 disabled:cursor-not-allowed resize-vertical"
                    placeholder='Paste your Postman collection JSON here...'
                    rows={12}
                  />
                  <p className="mt-1 text-xs text-gray-500">
                    Export your Postman collection as JSON (Collection v2.1) and paste it here
                  </p>
                </div>

                <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                  <h4 className="text-sm font-medium text-blue-900 mb-2">What will be imported?</h4>
                  <ul className="text-xs text-blue-800 space-y-1">
                    <li>• Project name and description from collection</li>
                    <li>• All requests as resources with default scenarios</li>
                    <li>• Headers and request bodies preserved</li>
                    <li>• Folders are flattened into individual resources</li>
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
              disabled={isSubmitting || (mode === 'manual' ? !name.trim() : !postmanJson.trim())}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {isSubmitting
                ? (mode === 'postman' ? 'Importing...' : 'Creating...')
                : (mode === 'postman' ? 'Import Collection' : 'Create Project')
              }
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
