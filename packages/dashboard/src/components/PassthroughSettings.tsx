/**
 * PassthroughSettings component
 * Displays and controls passthrough/proxy mode for a project
 */

import { useState } from 'react';
import { projectsApi } from '../api/client';
import type { Project } from '../api/types';

interface PassthroughSettingsProps {
  project: Project;
  onUpdate: () => void;
}

export function PassthroughSettings({ project, onUpdate }: PassthroughSettingsProps) {
  const [baseUrl, setBaseUrl] = useState(project.baseUrl || '');
  const [saving, setSaving] = useState(false);
  const [editingUrl, setEditingUrl] = useState(false);

  const isEnabled = !!project.passthroughEnabled;
  const hasBaseUrl = !!project.baseUrl;
  const isActive = isEnabled && hasBaseUrl;

  const handleToggle = async () => {
    try {
      setSaving(true);
      await projectsApi.update(project.id, {
        passthroughEnabled: !isEnabled,
      });
      onUpdate();
    } catch (err) {
      console.error('Failed to toggle passthrough:', err);
    } finally {
      setSaving(false);
    }
  };

  const handleSaveUrl = async () => {
    try {
      setSaving(true);
      await projectsApi.update(project.id, {
        baseUrl: baseUrl.trim() || undefined,
      });
      setEditingUrl(false);
      onUpdate();
    } catch (err) {
      console.error('Failed to update base URL:', err);
    } finally {
      setSaving(false);
    }
  };

  // Sync local state when project changes externally
  if (!editingUrl && baseUrl !== (project.baseUrl || '')) {
    setBaseUrl(project.baseUrl || '');
  }

  return (
    <div className={`rounded-lg border p-4 space-y-3 ${isActive ? 'bg-amber-50 border-amber-200' : 'bg-gray-50 border-gray-200'}`}>
      {/* Row 1: Passthrough toggle + Base URL */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {/* Toggle */}
          <button
            type="button"
            role="switch"
            aria-checked={isEnabled}
            onClick={handleToggle}
            disabled={saving}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 ${
              isEnabled ? 'bg-amber-500' : 'bg-gray-300'
            } ${saving ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                isEnabled ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>

          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-gray-900">Passthrough Mode</span>
              {isActive && (
                <span className="text-xs bg-amber-200 text-amber-800 px-2 py-0.5 rounded font-medium">
                  Active
                </span>
              )}
              {isEnabled && !hasBaseUrl && (
                <span className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded font-medium">
                  No Base URL
                </span>
              )}
            </div>
            <p className="text-xs text-gray-500 mt-0.5">
              {isActive
                ? 'Unmatched requests are forwarded to the real server'
                : 'Unmatched requests return 404'}
            </p>
          </div>
        </div>

        {/* Base URL display/edit */}
        <div className="flex items-center gap-2">
          {editingUrl ? (
            <div className="flex items-center gap-2">
              <input
                type="url"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://api.example.com"
                className="px-3 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500 w-64"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSaveUrl();
                  if (e.key === 'Escape') {
                    setBaseUrl(project.baseUrl || '');
                    setEditingUrl(false);
                  }
                }}
                autoFocus
              />
              <button
                type="button"
                onClick={handleSaveUrl}
                disabled={saving}
                className="px-3 py-1.5 text-xs font-medium text-white bg-indigo-600 rounded hover:bg-indigo-700 disabled:opacity-50 transition-colors"
              >
                Save
              </button>
              <button
                type="button"
                onClick={() => {
                  setBaseUrl(project.baseUrl || '');
                  setEditingUrl(false);
                }}
                className="px-3 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setEditingUrl(true)}
              className="flex items-center gap-2 px-3 py-1.5 text-sm text-gray-600 bg-white border border-gray-200 rounded-md hover:bg-gray-50 transition-colors"
            >
              {hasBaseUrl ? (
                <span className="font-mono text-xs truncate max-w-48">{project.baseUrl}</span>
              ) : (
                <span className="text-gray-400 italic">Set base URL...</span>
              )}
              <svg className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Row 2: Proxy mode info */}
      {hasBaseUrl && (
        <div className="bg-white border border-gray-200 rounded-md px-3 py-2">
          <div className="flex items-start gap-2">
            <svg className="w-4 h-4 text-indigo-500 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <div className="text-xs text-gray-600 space-y-1">
              <p>
                <strong className="text-gray-700">Proxy mode:</strong>{' '}
                Set your device WiFi proxy to <code className="bg-gray-100 px-1 rounded">port 8888</code> to
                intercept requests to <code className="bg-gray-100 px-1 rounded">{project.baseUrl}</code>.
                Unmatched requests are always forwarded to the real server. Only resources you add here will return mocks.
              </p>
              <p>
                <strong className="text-gray-700">Direct-connection mode:</strong>{' '}
                {isActive
                  ? 'Unmatched requests are forwarded to the real server (passthrough enabled).'
                  : 'Unmatched requests return 404. Enable Passthrough Mode above to forward them instead.'}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
