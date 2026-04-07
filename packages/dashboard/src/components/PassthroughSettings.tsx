/**
 * PassthroughSettings component
 * Displays and controls passthrough/proxy mode for a project
 */

import { useEffect, useState } from 'react';
import { projectsApi } from '../api/client';
import type { Project } from '../api/types';

interface PassthroughSettingsProps {
  project: Project;
  onUpdate: () => void;
}

export function PassthroughSettings({ project, onUpdate }: PassthroughSettingsProps) {
  const [baseUrl, setBaseUrl] = useState(project.baseUrl || '');
  const [interceptHosts, setInterceptHosts] = useState((project.interceptHosts || []).join('\n'));
  const [saving, setSaving] = useState(false);
  const [editingUrl, setEditingUrl] = useState(false);
  const [editingIntercept, setEditingIntercept] = useState(false);

  const isEnabled = !!project.passthroughEnabled;
  const hasBaseUrl = !!project.baseUrl;
  const isActive = isEnabled && hasBaseUrl;
  const captureRawTraffic = !!project.captureRawTraffic;

  const toggleCaptureRawTraffic = async () => {
    try {
      setSaving(true);
      await projectsApi.update(project.id, { captureRawTraffic: !captureRawTraffic });
      onUpdate();
    } catch (err) {
      console.error('Failed to toggle raw traffic capture:', err);
    } finally {
      setSaving(false);
    }
  };

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
  useEffect(() => {
    if (!editingUrl) {
      setBaseUrl(project.baseUrl || '');
    }
  }, [editingUrl, project.baseUrl]);

  useEffect(() => {
    if (!editingIntercept) {
      setInterceptHosts((project.interceptHosts || []).join('\n'));
    }
  }, [editingIntercept, (project.interceptHosts || []).join('\n')]);

  const saveInterceptHosts = async () => {
    try {
      setSaving(true);
      const hosts = interceptHosts
        .split(/\r?\n|,/g)
        .map(s => s.trim())
        .filter(Boolean);
      await projectsApi.update(project.id, { interceptHosts: hosts });
      setEditingIntercept(false);
      onUpdate();
    } catch (err) {
      console.error('Failed to update intercept hosts:', err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-lg border p-4 space-y-4 bg-white border-gray-200">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold text-gray-900">Proxy Interception</div>
          <div className="text-xs text-gray-500">Allowlist which hostnames MockMate should MITM and mock</div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setInterceptHosts('*');
              setEditingIntercept(true);
            }}
            className="px-3 py-1.5 text-sm bg-white border border-gray-300 rounded-md hover:bg-gray-50"
            disabled={saving}
          >
            Intercept All
          </button>

          {editingIntercept ? (
            <>
              <button
                type="button"
                onClick={saveInterceptHosts}
                className="px-3 py-1.5 text-sm bg-gray-900 text-white rounded-md hover:bg-black disabled:opacity-50"
                disabled={saving}
              >
                Save
              </button>
              <button
                type="button"
                onClick={() => {
                  setInterceptHosts((project.interceptHosts || []).join('\n'));
                  setEditingIntercept(false);
                }}
                className="px-3 py-1.5 text-sm bg-white border border-gray-300 rounded-md hover:bg-gray-50"
                disabled={saving}
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setEditingIntercept(true)}
              className="px-3 py-1.5 text-sm bg-white border border-gray-300 rounded-md hover:bg-gray-50"
            >
              Edit
            </button>
          )}
        </div>
      </div>

      <textarea
        value={interceptHosts}
        onChange={(e) => setInterceptHosts(e.target.value)}
        disabled={!editingIntercept || saving}
        className="w-full px-3 py-2 font-mono text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-sky-500 disabled:bg-gray-50 disabled:text-gray-500 resize-vertical"
        rows={3}
        placeholder={"package-preprod.wynk.in\napimaster-preprod.wynk.in\n*.wynk.in"}
      />
      <div className="text-xs text-gray-500">
        One per line (or comma-separated). Wildcards supported: <code className="bg-gray-50 border px-1 rounded">*.wynk.in</code>, <code className="bg-gray-50 border px-1 rounded">*</code>.
      </div>

      <div className="border-t border-gray-200 pt-4">
        <div className="flex items-center justify-between mb-4">
          <div>
            <div className="text-sm font-semibold text-gray-900">Traffic Capture</div>
            <div className="text-xs text-gray-500">Store raw proxied responses as fixture files (enables “Mock This” from Traffic)</div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={captureRawTraffic}
            onClick={toggleCaptureRawTraffic}
            disabled={saving}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-sky-500 ${
              captureRawTraffic ? 'bg-sky-600' : 'bg-gray-300'
            } ${saving ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                captureRawTraffic ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </div>

        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold text-gray-900">Direct Passthrough (optional)</div>
            <div className="text-xs text-gray-500">Only applies when you call MockMate HTTP server directly (not via proxy)</div>
          </div>
        </div>

        <div className="mt-3 rounded-lg border p-3 bg-gray-50 border-gray-200 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <button
                type="button"
                role="switch"
                aria-checked={isEnabled}
                onClick={handleToggle}
                disabled={saving}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-sky-500 ${
                  isEnabled ? 'bg-sky-600' : 'bg-gray-300'
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
                    <span className="text-xs bg-sky-100 text-sky-800 px-2 py-0.5 rounded font-medium">
                      Active
                    </span>
                  )}
                  {isEnabled && !hasBaseUrl && (
                    <span className="text-xs bg-rose-100 text-rose-700 px-2 py-0.5 rounded font-medium">
                      No Base URL
                    </span>
                  )}
                </div>
                <p className="text-xs text-gray-500 mt-0.5">
                  {isActive ? 'Unmatched direct requests are forwarded' : 'Unmatched direct requests return 404'}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              {editingUrl ? (
                <div className="flex items-center gap-2">
                  <input
                    type="url"
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    placeholder="https://api.example.com"
                    className="px-3 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-sky-500 w-72"
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
                    className="px-3 py-1.5 text-xs font-medium text-white bg-gray-900 rounded hover:bg-black disabled:opacity-50 transition-colors"
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
                    <span className="font-mono text-xs truncate max-w-64">{project.baseUrl}</span>
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
        </div>
      </div>
    </div>
  );
}
