import { useEffect, useEffectEvent, useState } from 'react';
import { statesApi } from '../api/client';
import type { AppState, AppStatePatch, EndpointDetail, Project } from '../api/types';
import { ConfirmDialog } from './ConfirmDialog';

export interface AppStateEditorProps {
  state: AppState;
  project: Project;
  endpoints: EndpointDetail[];
  onSaveStarted(): (state: AppState) => boolean;
  onRefresh(): void | Promise<void>;
  onDeleted(stateId: string): void;
  onDirtyChange?(key: string, dirty: boolean, discard?: () => void): void;
  onAttemptNavigation?(action: () => void, draftKeys: string[]): void;
}

export function AppStateEditor({
  state,
  project,
  endpoints,
  onSaveStarted,
  onRefresh,
  onDeleted,
  onDirtyChange,
  onAttemptNavigation,
}: AppStateEditorProps) {
  const [name, setName] = useState(state.name);
  const [description, setDescription] = useState(state.description ?? '');
  const [expectedUi, setExpectedUi] = useState(state.expectedUi ?? '');
  const [bindings, setBindings] = useState({ ...state.bindings });
  const [bindingPickerOpen, setBindingPickerOpen] = useState(false);
  const [pickerEndpointId, setPickerEndpointId] = useState('');
  const [pickerVariantId, setPickerVariantId] = useState('');
  const [error, setError] = useState<string>();
  const [serverRevision, setServerRevision] = useState<number>();
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const key = `state:${state.projectId}:${state.id}:${state.revision}`;
  const dirty = name !== state.name
    || description !== (state.description ?? '')
    || expectedUi !== (state.expectedUi ?? '')
    || JSON.stringify(bindings) !== JSON.stringify(state.bindings);
  const active = project.activeStateId === state.id;
  const boundEndpoints = Object.keys(bindings)
    .map(endpointId => endpoints.find(endpoint => endpoint.id === endpointId))
    .filter((endpoint): endpoint is EndpointDetail => endpoint !== undefined);
  const unboundMockEndpoints = endpoints.filter(endpoint => (
    endpoint.mode === 'mock' && bindings[endpoint.id] === undefined
  ));
  const pickerEndpoint = unboundMockEndpoints.find(endpoint => endpoint.id === pickerEndpointId);

  const discardDraft = () => {
    setName(state.name);
    setDescription(state.description ?? '');
    setExpectedUi(state.expectedUi ?? '');
    setBindings({ ...state.bindings });
    setBindingPickerOpen(false);
    setPickerEndpointId('');
    setPickerVariantId('');
    setError(undefined);
    setServerRevision(undefined);
  };
  const reportDirty = useEffectEvent(() => {
    onDirtyChange?.(key, dirty, discardDraft);
  });

  useEffect(() => reportDirty(), [dirty, key]);

  const save = async () => {
    const patch: AppStatePatch = {};
    if (name !== state.name) patch.name = name.trim();
    if (description !== (state.description ?? '')) patch.description = description.trim() || null;
    if (expectedUi !== (state.expectedUi ?? '')) patch.expectedUi = expectedUi.trim() || null;
    if (JSON.stringify(bindings) !== JSON.stringify(state.bindings)) patch.bindings = bindings;
    setSaving(true);
    const completeSave = onSaveStarted();
    try {
      setError(undefined);
      setServerRevision(undefined);
      const saved = await statesApi.update(state.projectId, state.id, state.revision, patch);
      if (!completeSave(saved)) return;
      onDirtyChange?.(key, false);
    } catch (caught) {
      if (typeof caught === 'object' && caught !== null && 'status' in caught && caught.status === 409) {
        setServerRevision('currentRevision' in caught && typeof caught.currentRevision === 'number'
          ? caught.currentRevision : undefined);
      } else {
        setError(caught instanceof Error ? caught.message : 'Failed to save App State');
      }
    } finally {
      setSaving(false);
    }
  };

  const openDeleteDialog = () => {
    const open = () => setDeleteDialogOpen(true);
    if (onAttemptNavigation) onAttemptNavigation(open, [key]);
    else open();
  };

  const refreshCanonical = () => {
    const refresh = async () => {
      setRefreshing(true);
      try {
        await onRefresh();
      } finally {
        setRefreshing(false);
      }
    };
    if (onAttemptNavigation) onAttemptNavigation(() => void refresh(), [key]);
    else void refresh();
  };

  const remove = async () => {
    setDeleting(true);
    setError(undefined);
    setServerRevision(undefined);
    try {
      await statesApi.delete(state.projectId, state.id, state.revision);
      onDeleted(state.id);
      setDeleteDialogOpen(false);
    } catch (caught) {
      if (typeof caught === 'object' && caught !== null && 'status' in caught && caught.status === 409) {
        setServerRevision('currentRevision' in caught && typeof caught.currentRevision === 'number'
          ? caught.currentRevision : undefined);
      } else {
        setError(caught instanceof Error ? caught.message : 'Failed to delete App State');
      }
    } finally {
      setDeleting(false);
    }
  };

  const recoverDeletionConflict = () => {
    setDeleteDialogOpen(false);
    refreshCanonical();
  };

  return (
    <div className="space-y-4 rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
      {error ? <p className="rounded bg-red-50 p-2 text-sm text-red-700">{error}</p> : null}
      {serverRevision !== undefined || refreshing ? (
        <div className="flex items-center justify-between gap-3 rounded bg-amber-50 p-2 text-sm text-amber-800">
          <span>{refreshing ? 'Loading canonical App State' : `Server revision ${serverRevision}`}</span>
          <button type="button" disabled={refreshing} onClick={refreshCanonical} className="font-medium underline disabled:opacity-50">
            {refreshing ? 'Refreshing App State...' : 'Refresh App State'}
          </button>
        </div>
      ) : null}
      <fieldset disabled={refreshing || saving} className="contents">
      <div className="rounded border border-gray-200 bg-gray-50 p-3">
        <p className="text-xs font-medium text-gray-600">Stable App State ID</p>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <code className="text-sm text-gray-900">{state.id}</code>
          <button
            type="button"
            onClick={() => void navigator.clipboard.writeText(state.id)}
            className="rounded border border-gray-300 bg-white px-2 py-1 text-xs text-gray-700"
          >
            Copy App State ID
          </button>
        </div>
        <p className="mt-2 text-xs text-gray-500">
          Use this unchanged ID with <code>/setMockServerflags</code> automation.
        </p>
      </div>
      <label className="block text-sm font-medium text-gray-700">
        App State name
        <input value={name} onChange={event => setName(event.target.value)} className="mt-1 w-full rounded border border-gray-300 px-3 py-2" />
      </label>
      <label className="block text-sm font-medium text-gray-700">
        Description
        <input value={description} onChange={event => setDescription(event.target.value)} className="mt-1 w-full rounded border border-gray-300 px-3 py-2" />
      </label>
      <label className="block text-sm font-medium text-gray-700">
        Expected UI
        <textarea aria-label="Expected UI" value={expectedUi} onChange={event => setExpectedUi(event.target.value)} className="mt-1 w-full rounded border border-gray-300 px-3 py-2" rows={3} />
      </label>
      <fieldset className="space-y-3 border-t border-gray-200 pt-4">
        <legend className="text-sm font-semibold text-gray-800">Endpoint bindings</legend>
        {boundEndpoints.length === 0 ? (
          <p className="text-sm text-gray-500">No Endpoints are bound. When active, mock Endpoints pass through upstream.</p>
        ) : null}
        {boundEndpoints.map(endpoint => (
          <div key={endpoint.id} className="grid items-center gap-2 text-sm text-gray-700 md:grid-cols-[1fr_14rem_auto]">
            <span>{endpoint.name}</span>
            <select
              aria-label={`${endpoint.name} variant`}
              value={bindings[endpoint.id]}
              onChange={event => setBindings(current => ({ ...current, [endpoint.id]: event.target.value }))}
              className="rounded border border-gray-300 px-3 py-2"
            >
              {endpoint.variants.map(variant => <option key={variant.id} value={variant.id}>{variant.name}</option>)}
            </select>
            <button
              type="button"
              aria-label={`Remove ${endpoint.name} binding`}
              onClick={() => setBindings(current => {
                const next = { ...current };
                delete next[endpoint.id];
                return next;
              })}
              className="rounded px-2 py-1 text-xs text-red-700"
            >
              Remove
            </button>
          </div>
        ))}
        {!bindingPickerOpen ? (
          <button
            type="button"
            disabled={unboundMockEndpoints.length === 0}
            onClick={() => setBindingPickerOpen(true)}
            className="rounded border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 disabled:opacity-50"
          >
            Add Endpoint binding
          </button>
        ) : (
          <div className="space-y-3 rounded border border-gray-200 bg-gray-50 p-3">
            <label className="block text-sm font-medium text-gray-700">
              Mock Endpoint
              <select
                aria-label="Mock Endpoint"
                value={pickerEndpointId}
                onChange={event => {
                  setPickerEndpointId(event.target.value);
                  setPickerVariantId('');
                }}
                className="mt-1 w-full rounded border border-gray-300 bg-white px-3 py-2"
              >
                <option value="">Choose an Endpoint</option>
                {unboundMockEndpoints.map(endpoint => (
                  <option key={endpoint.id} value={endpoint.id}>{endpoint.name}</option>
                ))}
              </select>
            </label>
            <label className="block text-sm font-medium text-gray-700">
              Variant
              <select
                aria-label="Binding Variant"
                value={pickerVariantId}
                disabled={!pickerEndpoint}
                onChange={event => setPickerVariantId(event.target.value)}
                className="mt-1 w-full rounded border border-gray-300 bg-white px-3 py-2 disabled:opacity-50"
              >
                <option value="">Choose a Variant</option>
                {pickerEndpoint?.variants.map(variant => (
                  <option key={variant.id} value={variant.id}>{variant.name}</option>
                ))}
              </select>
            </label>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={!pickerEndpoint || !pickerVariantId}
                onClick={() => {
                  if (!pickerEndpoint || !pickerVariantId) return;
                  setBindings(current => ({ ...current, [pickerEndpoint.id]: pickerVariantId }));
                  setBindingPickerOpen(false);
                  setPickerEndpointId('');
                  setPickerVariantId('');
                }}
                className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
              >
                Add binding
              </button>
              <button
                type="button"
                onClick={() => {
                  setBindingPickerOpen(false);
                  setPickerEndpointId('');
                  setPickerVariantId('');
                }}
                className="rounded border border-gray-300 px-3 py-1.5 text-xs"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </fieldset>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button type="button" onClick={() => void save()} disabled={!dirty} className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">Save App State</button>
        <button type="button" onClick={openDeleteDialog} className="rounded border border-red-300 bg-white px-4 py-2 text-sm font-medium text-red-700">Delete App State</button>
      </div>
      </fieldset>
      <ConfirmDialog
        isOpen={deleteDialogOpen}
        title="Delete App State"
        message={`${active ? 'This is the active App State.' : 'This App State is not active.'}\n\nExternal iOS/Android references cannot be discovered. Verify automation and app integrations before deleting.`}
        confirmLabel="Delete App State"
        variant="danger"
        loading={deleting}
        confirmDisabled={serverRevision !== undefined}
        recoveryMessage={serverRevision !== undefined ? `Server revision ${serverRevision}` : undefined}
        recoveryLabel={serverRevision !== undefined ? 'Refresh App State' : undefined}
        onRecovery={serverRevision !== undefined ? recoverDeletionConflict : undefined}
        onConfirm={() => void remove()}
        onCancel={() => setDeleteDialogOpen(false)}
      />
    </div>
  );
}
