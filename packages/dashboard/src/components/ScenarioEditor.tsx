/**
 * ScenarioEditor component - edit scenarios for a resource with Request/Response tabs
 */

import { useState } from 'react';
import { JsonEditor } from './JsonEditor';
import { ConfirmDialog } from './ConfirmDialog';
import { InputDialog } from './InputDialog';
import { QueryParamsTable } from './QueryParamsTable';
import { ResponseHeadersTable } from './ResponseHeadersTable';
import { scenariosApi, resourcesApi } from '../api/client';
import type { Resource, Scenario, UpdateScenarioRequest, QueryParam } from '../api/types';

interface ScenarioEditorProps {
  projectId: string;
  resource: Resource;
  onUpdate: () => void;
}

type TabType = 'request' | 'response';

export function ScenarioEditor({ projectId, resource, onUpdate }: ScenarioEditorProps) {
  const [expandedScenario, setExpandedScenario] = useState<string | null>(
    resource.scenarios[0]?.name || null
  );
  const [activeTab, setActiveTab] = useState<Record<string, TabType>>({});
  const [editingScenario, setEditingScenario] = useState<Record<string, Partial<Scenario>>>({});
  const [bodyText, setBodyText] = useState<Record<string, string>>({});
  const [requestBodyText, setRequestBodyText] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Dialog states
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [duplicateDialogOpen, setDuplicateDialogOpen] = useState(false);
  const [duplicateScenario, setDuplicateScenario] = useState<Scenario | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteScenarioName, setDeleteScenarioName] = useState<string | null>(null);
  const [togglingPassthrough, setTogglingPassthrough] = useState(false);

  const getActiveTab = (scenarioName: string): TabType => {
    return activeTab[scenarioName] || 'response';
  };

  const setScenarioTab = (scenarioName: string, tab: TabType) => {
    setActiveTab(prev => ({ ...prev, [scenarioName]: tab }));
  };

  const getEditedScenario = (scenario: Scenario): Scenario => {
    return { ...scenario, ...editingScenario[scenario.name] };
  };

  const updateScenarioField = (scenarioName: string, field: string, value: any) => {
    setEditingScenario(prev => ({
      ...prev,
      [scenarioName]: {
        ...prev[scenarioName],
        [field]: value,
      },
    }));
  };

  const handleSave = async (scenario: Scenario) => {
    const edited = getEditedScenario(scenario);

    try {
      setSaving(scenario.name);
      setError(null);

      const updateData: UpdateScenarioRequest = {
        statusCode: edited.statusCode,
        delay: edited.delay,
        headers: edited.headers,
        responseHeaders: edited.responseHeaders,
        requestBody: edited.requestBody,
        queryParams: edited.queryParams,
        body: edited.body,
      };

      await scenariosApi.update(projectId, resource.id, scenario.name, updateData);

      // Clear edited state for this scenario
      setEditingScenario(prev => {
        const next = { ...prev };
        delete next[scenario.name];
        return next;
      });

      // Clear text state
      setBodyText(prev => {
        const next = { ...prev };
        delete next[scenario.name];
        return next;
      });
      setRequestBodyText(prev => {
        const next = { ...prev };
        delete next[scenario.name];
        return next;
      });

      onUpdate();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save scenario');
    } finally {
      setSaving(null);
    }
  };

  const handleDuplicate = (scenario: Scenario) => {
    setDuplicateScenario(scenario);
    setDuplicateDialogOpen(true);
  };

  const confirmDuplicate = async (newName: string) => {
    if (!duplicateScenario) return;

    try {
      setError(null);
      await scenariosApi.duplicate(projectId, resource.id, duplicateScenario.name, newName);
      setDuplicateDialogOpen(false);
      setDuplicateScenario(null);
      onUpdate();
      setExpandedScenario(newName);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to duplicate scenario');
      setDuplicateDialogOpen(false);
      setDuplicateScenario(null);
    }
  };

  const handleDelete = (scenarioName: string) => {
    if (scenarioName === 'default') {
      setError('Cannot delete the default scenario');
      return;
    }

    setDeleteScenarioName(scenarioName);
    setDeleteDialogOpen(true);
  };

  const confirmDelete = async () => {
    if (!deleteScenarioName) return;

    try {
      setError(null);
      await scenariosApi.delete(projectId, resource.id, deleteScenarioName);
      setDeleteDialogOpen(false);
      if (expandedScenario === deleteScenarioName) {
        setExpandedScenario('default');
      }
      setDeleteScenarioName(null);
      onUpdate();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete scenario');
      setDeleteDialogOpen(false);
      setDeleteScenarioName(null);
    }
  };

  const handleAddScenario = () => {
    setAddDialogOpen(true);
  };

  const confirmAddScenario = async (newName: string) => {
    try {
      setError(null);
      await scenariosApi.add(projectId, resource.id, {
        name: newName,
        statusCode: 200,
        delay: 0,
        headers: {},
        responseHeaders: {},
        requestBody: undefined,
        queryParams: [],
        body: {},
      });
      setAddDialogOpen(false);
      onUpdate();
      setExpandedScenario(newName);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add scenario');
      setAddDialogOpen(false);
    }
  };

  const hasUnsavedChanges = (scenarioName: string) => {
    return !!editingScenario[scenarioName];
  };

  const handleTogglePassthrough = async () => {
    try {
      setTogglingPassthrough(true);
      await resourcesApi.update(projectId, resource.id, {
        passthrough: !resource.passthrough,
      });
      onUpdate();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to toggle passthrough');
    } finally {
      setTogglingPassthrough(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-gray-900">
            {resource.method} {resource.path}
          </h3>
          <p className="text-sm text-gray-500 mt-1">
            {resource.scenarios.length} scenario{resource.scenarios.length !== 1 ? 's' : ''}
          </p>
        </div>
        <div className="flex items-center gap-4">
          {/* Per-resource passthrough toggle */}
          <label className="flex items-center gap-2 cursor-pointer">
            <button
              type="button"
              role="switch"
              aria-checked={!!resource.passthrough}
              onClick={handleTogglePassthrough}
              disabled={togglingPassthrough}
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-amber-500 ${
                resource.passthrough ? 'bg-amber-500' : 'bg-gray-300'
              } ${togglingPassthrough ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
            >
              <span
                className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                  resource.passthrough ? 'translate-x-5' : 'translate-x-0.5'
                }`}
              />
            </button>
            <span className="text-xs text-gray-600">Passthrough</span>
          </label>

          <button
            type="button"
            onClick={handleAddScenario}
            className="px-4 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors"
          >
            + Add Scenario
          </button>
        </div>
      </div>

      {/* Passthrough notice */}
      {resource.passthrough && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 flex items-center gap-2">
          <svg className="w-4 h-4 text-amber-600 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <p className="text-sm text-amber-800">
            Passthrough enabled — requests to this endpoint will be forwarded to the real server. Mock scenarios below are bypassed.
          </p>
        </div>
      )}

      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded text-sm text-red-800">
          {error}
        </div>
      )}

      <div className={`space-y-2 ${resource.passthrough ? 'opacity-50 pointer-events-none' : ''}`}>
        {resource.scenarios.map((scenario) => {
          const isExpanded = expandedScenario === scenario.name;
          const edited = getEditedScenario(scenario);
          const isDefault = scenario.name === 'default';
          const isSaving = saving === scenario.name;
          const hasChanges = hasUnsavedChanges(scenario.name);
          const tab = getActiveTab(scenario.name);

          return (
            <div
              key={scenario.name}
              className="border border-gray-200 rounded-lg bg-white overflow-hidden"
            >
              {/* Accordion Header */}
              <button
                type="button"
                onClick={() => setExpandedScenario(isExpanded ? null : scenario.name)}
                className="w-full px-4 py-3 flex items-center justify-between hover:bg-gray-50 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <svg
                    className={`w-5 h-5 text-gray-500 transition-transform ${
                      isExpanded ? 'rotate-90' : ''
                    }`}
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M9 5l7 7-7 7"
                    />
                  </svg>
                  <div className="text-left">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-gray-900">{scenario.name}</span>
                      {isDefault && (
                        <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded">
                          Default
                        </span>
                      )}
                      {hasChanges && (
                        <span className="text-xs bg-yellow-100 text-yellow-700 px-2 py-0.5 rounded">
                          Unsaved
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-gray-500 mt-0.5">
                      Status: {edited.statusCode} • Delay: {edited.delay}ms
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {!isDefault && (
                    <>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDuplicate(scenario);
                        }}
                        className="p-1.5 text-gray-600 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors"
                        title="Duplicate scenario"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                          />
                        </svg>
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDelete(scenario.name);
                        }}
                        className="p-1.5 text-gray-600 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
                        title="Delete scenario"
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
                    </>
                  )}
                </div>
              </button>

              {/* Accordion Content */}
              {isExpanded && (
                <div className="border-t border-gray-200">
                  {/* Tabs */}
                  <div className="flex border-b border-gray-200 bg-gray-50">
                    <button
                      type="button"
                      onClick={() => setScenarioTab(scenario.name, 'request')}
                      className={`px-6 py-3 text-sm font-medium transition-colors ${
                        tab === 'request'
                          ? 'text-blue-600 border-b-2 border-blue-600 bg-white'
                          : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100'
                      }`}
                    >
                      Request
                    </button>
                    <button
                      type="button"
                      onClick={() => setScenarioTab(scenario.name, 'response')}
                      className={`px-6 py-3 text-sm font-medium transition-colors ${
                        tab === 'response'
                          ? 'text-blue-600 border-b-2 border-blue-600 bg-white'
                          : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100'
                      }`}
                    >
                      Response
                    </button>
                  </div>

                  <div className="px-4 py-4 space-y-4">
                    {/* REQUEST TAB */}
                    {tab === 'request' && (
                      <>
                        {/* How Request Matching Works */}
                        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
                          <h4 className="text-sm font-medium text-amber-900 mb-2 flex items-center gap-2">
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                            </svg>
                            How Request Matching Works
                          </h4>
                          <p className="text-xs text-amber-800 mb-2">
                            MockMate matches requests based on <strong>HTTP method + URL path only</strong>. Request headers, query parameters, and body are <strong>NOT used for matching</strong> - they are for documentation purposes only.
                          </p>
                          <p className="text-xs text-amber-800 mb-2">
                            <strong>To select a specific scenario:</strong> Send the <code className="bg-amber-100 px-1 rounded font-mono">X-MockMate-Scenario</code> header with your request.
                          </p>
                          <p className="text-xs text-amber-700">
                            Example: <code className="bg-amber-100 px-1 rounded font-mono text-xs">curl -H "X-MockMate-Scenario: {scenario.name}" {resource.method} http://localhost:3456{resource.path}</code>
                          </p>
                        </div>

                        {/* Path Parameters Info */}
                        {resource.path.includes(':') && (
                          <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
                            <h4 className="text-sm font-medium text-blue-900 mb-1">Path Parameters</h4>
                            <p className="text-xs text-blue-800 mb-2">
                              This endpoint uses path parameters: <code className="bg-blue-100 px-1 rounded font-mono">{resource.path}</code>
                            </p>
                            <p className="text-xs text-blue-700">
                              Example URL: <code className="bg-blue-100 px-1 rounded font-mono">
                                {resource.path.replace(/:(\w+)/g, (_, param) => `{${param}}`)}
                              </code>
                            </p>
                            <p className="text-xs text-gray-600 mt-2 italic">
                              Path parameter values are extracted from the actual request URL at runtime.
                            </p>
                          </div>
                        )}

                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-2">
                            Request Headers
                          </label>
                          <ResponseHeadersTable
                            headers={edited.headers || {}}
                            onChange={(headers) => updateScenarioField(scenario.name, 'headers', headers)}
                          />
                          <p className="mt-2 text-xs text-gray-500">
                            HTTP headers expected in the request. These are for documentation purposes.
                          </p>
                        </div>

                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-2">
                            Query Parameters
                          </label>
                          <QueryParamsTable
                            params={edited.queryParams || []}
                            onChange={(params) => updateScenarioField(scenario.name, 'queryParams', params)}
                          />
                          <p className="mt-2 text-xs text-gray-500">
                            Query string parameters (e.g., ?page=1&limit=10). These are for documentation purposes.
                          </p>
                        </div>

                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-2">
                            Request Body
                          </label>
                          <JsonEditor
                            value={requestBodyText[scenario.name] ?? JSON.stringify(edited.requestBody || {}, null, 2)}
                            onChange={(value) => {
                              // Store raw text immediately
                              setRequestBodyText(prev => ({ ...prev, [scenario.name]: value }));

                              // Try to parse and update scenario if valid
                              try {
                                const parsed = value.trim() ? JSON.parse(value) : undefined;
                                updateScenarioField(scenario.name, 'requestBody', parsed);
                              } catch {
                                // Keep the text but don't update the parsed body yet
                              }
                            }}
                            minHeight="250px"
                          />
                          <p className="mt-2 text-xs text-gray-500">
                            Example request body for this scenario. This is for documentation and testing purposes.
                          </p>
                        </div>
                      </>
                    )}

                    {/* RESPONSE TAB */}
                    {tab === 'response' && (
                      <>
                        <div className="grid grid-cols-2 gap-4">
                          {/* Status Code */}
                          <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">
                              Status Code
                            </label>
                            <input
                              type="number"
                              value={edited.statusCode}
                              onChange={(e) =>
                                updateScenarioField(scenario.name, 'statusCode', parseInt(e.target.value) || 200)
                              }
                              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                              min="100"
                              max="599"
                            />
                          </div>

                          {/* Delay */}
                          <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">
                              Delay (ms)
                            </label>
                            <input
                              type="number"
                              value={edited.delay}
                              onChange={(e) =>
                                updateScenarioField(scenario.name, 'delay', parseInt(e.target.value) || 0)
                              }
                              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                              min="0"
                              max="10000"
                            />
                          </div>
                        </div>

                        {/* Response Headers */}
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-2">
                            Response Headers
                          </label>
                          <ResponseHeadersTable
                            headers={edited.responseHeaders || {}}
                            onChange={(headers) => updateScenarioField(scenario.name, 'responseHeaders', headers)}
                          />
                          <p className="mt-2 text-xs text-gray-500">
                            HTTP headers to include in the mock response.
                          </p>
                        </div>

                        {/* Response Body */}
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-2">
                            Response Body
                          </label>
                          <JsonEditor
                            value={bodyText[scenario.name] ?? JSON.stringify(edited.body || {}, null, 2)}
                            onChange={(value) => {
                              // Store raw text immediately
                              setBodyText(prev => ({ ...prev, [scenario.name]: value }));

                              // Try to parse and update scenario if valid
                              try {
                                const parsed = value.trim() ? JSON.parse(value) : {};
                                updateScenarioField(scenario.name, 'body', parsed);
                              } catch {
                                // Keep the text but don't update the parsed body yet
                              }
                            }}
                            minHeight="300px"
                          />
                        </div>
                      </>
                    )}

                    {/* Action Buttons */}
                    <div className="flex items-center justify-end gap-3 pt-2 border-t border-gray-200">
                      {hasChanges && (
                        <button
                          type="button"
                          onClick={() => {
                            setEditingScenario(prev => {
                              const next = { ...prev };
                              delete next[scenario.name];
                              return next;
                            });
                            // Clear text state
                            setBodyText(prev => {
                              const next = { ...prev };
                              delete next[scenario.name];
                              return next;
                            });
                            setRequestBodyText(prev => {
                              const next = { ...prev };
                              delete next[scenario.name];
                              return next;
                            });
                          }}
                          disabled={isSaving}
                          className="px-4 py-2 text-sm text-gray-700 bg-white border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                        >
                          Cancel
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => handleSave(scenario)}
                        disabled={isSaving || !hasChanges}
                        className="px-4 py-2 text-sm text-white bg-blue-600 rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      >
                        {isSaving ? 'Saving...' : 'Save Changes'}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Add Scenario Dialog */}
      <InputDialog
        isOpen={addDialogOpen}
        title="Add New Scenario"
        message="Enter a name for the new scenario:"
        placeholder="e.g., error, empty, loading"
        onConfirm={confirmAddScenario}
        onCancel={() => setAddDialogOpen(false)}
        validate={(value) => {
          if (resource.scenarios.some(s => s.name === value)) {
            return 'A scenario with this name already exists';
          }
          if (value.length < 1 || value.length > 50) {
            return 'Scenario name must be between 1 and 50 characters';
          }
          return null;
        }}
      />

      {/* Duplicate Scenario Dialog */}
      <InputDialog
        isOpen={duplicateDialogOpen}
        title="Duplicate Scenario"
        message={duplicateScenario ? `Duplicate "${duplicateScenario.name}" as:` : ''}
        placeholder="e.g., error-copy"
        defaultValue={duplicateScenario ? `${duplicateScenario.name}-copy` : ''}
        onConfirm={confirmDuplicate}
        onCancel={() => {
          setDuplicateDialogOpen(false);
          setDuplicateScenario(null);
        }}
        validate={(value) => {
          if (resource.scenarios.some(s => s.name === value)) {
            return 'A scenario with this name already exists';
          }
          if (value.length < 1 || value.length > 50) {
            return 'Scenario name must be between 1 and 50 characters';
          }
          return null;
        }}
      />

      {/* Delete Scenario Dialog */}
      <ConfirmDialog
        isOpen={deleteDialogOpen}
        title="Delete Scenario"
        message={`Delete scenario "${deleteScenarioName}"?\n\nThis action cannot be undone.`}
        confirmLabel="Delete"
        variant="danger"
        onConfirm={confirmDelete}
        onCancel={() => {
          setDeleteDialogOpen(false);
          setDeleteScenarioName(null);
        }}
      />
    </div>
  );
}
