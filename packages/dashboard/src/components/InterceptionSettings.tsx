import { useEffect, useRef, useState } from 'react';

import { ApiClientError, projectsApi } from '../api/client';
import type { Project, ProjectRuntimeSettings, RuntimeSettingsUpdateInput } from '../api/types';
import { useInterceptionGuidance } from '../hooks/useInterceptionGuidance';

export interface InterceptionSettingsProps {
  project: Project;
  discoveredOrigins?: readonly string[];
  onUpdate(): void;
  onDirtyChange?(key: string, dirty: boolean, discard?: () => void): void;
}

function patterns(value: string): string[] {
  return [...new Set(value.split(/\r?\n|,/).map(pattern => pattern.trim()).filter(Boolean))].sort();
}

function samePatterns(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

export function InterceptionSettings({
  project,
  discoveredOrigins = [],
  onUpdate,
  onDirtyChange,
}: InterceptionSettingsProps) {
  const guidance = useInterceptionGuidance(project.id, discoveredOrigins);
  const [settings, setSettings] = useState<ProjectRuntimeSettings>();
  const [hosts, setHosts] = useState('');
  const [captureRawTraffic, setCaptureRawTraffic] = useState(false);
  const [debugProvenanceHeaders, setDebugProvenanceHeaders] = useState(false);
  const [confirmInterceptAll, setConfirmInterceptAll] = useState(false);
  const [error, setError] = useState<string>();
  const [staleRevision, setStaleRevision] = useState<number>();
  const [savingOwner, setSavingOwner] = useState<string>();
  const operationRef = useRef<object | undefined>(undefined);
  const owner = `${project.id}:${settings?.revision ?? 'loading'}`;
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  const draftPatterns = patterns(hosts);
  const dirty = settings !== undefined && (
    !samePatterns(draftPatterns, settings.interceptHosts)
    || captureRawTraffic !== settings.captureRawTraffic
    || debugProvenanceHeaders !== settings.debugProvenanceHeaders
  );
  const guidanceStale = settings !== undefined && guidance.guidance !== undefined
    && !samePatterns(guidance.guidance.configuredPatterns, settings.interceptHosts);
  const guidanceUnavailable = guidance.loading || guidance.guidance === undefined || guidance.error !== undefined;
  const dirtyKey = `interception-settings:${project.id}:${settings?.revision ?? 0}`;

  const adopt = (value: ProjectRuntimeSettings) => {
    setSettings(value);
    setHosts(value.interceptHosts.join('\n'));
    setCaptureRawTraffic(value.captureRawTraffic);
    setDebugProvenanceHeaders(value.debugProvenanceHeaders);
    setConfirmInterceptAll(false);
  };

  useEffect(() => {
    const controller = new AbortController();
    void projectsApi.getRuntimeSettings(project.id, controller.signal)
      .then(value => {
        adopt(value);
        setError(undefined);
      })
      .catch(caught => {
        if (!(caught instanceof Error && caught.name === 'AbortError')) {
          setError(caught instanceof Error ? caught.message : 'Failed to load runtime settings');
        }
      });
    return () => controller.abort();
  }, [project.id]);

  useEffect(() => {
    onDirtyChange?.(dirtyKey, dirty, () => {
      if (settings) adopt(settings);
    });
    return () => onDirtyChange?.(dirtyKey, false);
  }, [dirty, dirtyKey, onDirtyChange, settings]);

  const refresh = async () => {
    setError(undefined);
    const [canonical] = await Promise.all([
      projectsApi.getRuntimeSettings(project.id),
      guidance.refresh(),
    ]);
    adopt(canonical);
    setStaleRevision(undefined);
  };

  const save = async () => {
    if (!settings || !dirty || guidanceStale || guidanceUnavailable || operationRef.current) return;
    const input: RuntimeSettingsUpdateInput = {
      interceptHosts: draftPatterns,
      captureRawTraffic,
      debugProvenanceHeaders,
      expectedRevision: settings.revision,
      ...(draftPatterns.includes('*') ? { confirmInterceptAll: true } : {}),
    };
    if (draftPatterns.includes('*') && !confirmInterceptAll) return;
    const operation = {};
    operationRef.current = operation;
    const operationOwner = owner;
    setSavingOwner(operationOwner);
    setError(undefined);
    setStaleRevision(undefined);
    const ownsOperation = () => operationRef.current === operation && ownerRef.current === operationOwner;
    try {
      const saved = await projectsApi.updateRuntimeSettings(project.id, input);
      if (!ownsOperation()) return;
      adopt(saved);
      onUpdate();
      void guidance.refresh();
    } catch (caught) {
      if (!ownsOperation()) return;
      if (caught instanceof ApiClientError && caught.status === 409) {
        setStaleRevision(caught.currentRevision);
      } else if (!(caught instanceof ApiClientError) || caught.status === 0 || caught.status >= 500) {
        try {
          const canonical = await projectsApi.getRuntimeSettings(project.id);
          if (!ownsOperation()) return;
          const observed = samePatterns(canonical.interceptHosts, input.interceptHosts)
            && canonical.captureRawTraffic === input.captureRawTraffic
            && canonical.debugProvenanceHeaders === input.debugProvenanceHeaders;
          adopt(canonical);
          if (observed) onUpdate();
          else setError('Settings save outcome is unknown. Canonical settings were refreshed; review before saving again.');
          void guidance.refresh();
        } catch {
          if (ownsOperation()) {
            setError('Settings save outcome is unknown and canonical refresh failed. Refresh before trying again.');
          }
        }
      } else {
        setError(caught.message);
      }
    } finally {
      if (operationRef.current === operation) {
        operationRef.current = undefined;
        setSavingOwner(undefined);
      }
    }
  };

  if (!settings) return <p className="text-sm text-gray-500">Loading runtime settings...</p>;
  const suggestions = [...new Set(guidance.guidance?.origins.map(value => value.hostname) ?? [])].sort();
  const catchAll = draftPatterns.includes('*');

  return (
    <section className="space-y-5 rounded-lg border border-gray-200 bg-white p-5">
      <div>
        <h3 className="text-base font-semibold text-gray-900">Interception settings</h3>
        <p className="mt-1 text-xs text-gray-500">Endpoint, Import, and Mock This flows never change this allowlist automatically.</p>
      </div>
      {error ? <p role="alert" className="rounded bg-red-50 p-2 text-sm text-red-700">{error}</p> : null}
      {staleRevision !== undefined || guidanceStale ? (
        <div className="flex items-center justify-between rounded bg-amber-50 p-2 text-sm text-amber-900">
          <span>{staleRevision === undefined ? 'Interception guidance is stale' : `Server revision ${staleRevision}`}</span>
          <button type="button" onClick={() => void refresh()} className="font-medium underline">Refresh settings</button>
        </div>
      ) : null}
      {suggestions.length > 0 ? (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-gray-700">Exact host suggestions</legend>
          {suggestions.map(hostname => (
            <label key={hostname} className="flex items-center gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                aria-label={`Intercept ${hostname}`}
                checked={draftPatterns.includes(hostname)}
                onChange={event => setHosts((event.target.checked
                  ? [...draftPatterns, hostname]
                  : draftPatterns.filter(value => value !== hostname)).sort().join('\n'))}
              />
              <span className="font-mono">{hostname}</span>
            </label>
          ))}
        </fieldset>
      ) : null}
      <label className="block text-sm font-medium text-gray-700">
        Intercept host patterns
        <textarea aria-label="Intercept host patterns" value={hosts} onChange={event => setHosts(event.target.value)} className="mt-1 w-full rounded border border-gray-300 px-3 py-2 font-mono" rows={5} />
      </label>
      <label className="flex items-center justify-between text-sm font-medium text-gray-700">
        Capture exact Traffic bodies
        <input aria-label="Capture raw traffic" type="checkbox" checked={captureRawTraffic} onChange={event => setCaptureRawTraffic(event.target.checked)} />
      </label>
      <label className="flex items-center justify-between text-sm font-medium text-gray-700">
        Debug provenance headers
        <input aria-label="Debug provenance headers" type="checkbox" checked={debugProvenanceHeaders} onChange={event => setDebugProvenanceHeaders(event.target.checked)} />
      </label>
      {catchAll ? (
        <label className="flex gap-2 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <input aria-label="Confirm intercept all hosts" type="checkbox" checked={confirmInterceptAll} onChange={event => setConfirmInterceptAll(event.target.checked)} />
          I understand that * intercepts every eligible hostname.
        </label>
      ) : null}
      <button
        type="button"
        disabled={!dirty || guidanceStale || guidanceUnavailable || savingOwner === owner || (catchAll && !confirmInterceptAll)}
        onClick={() => void save()}
        className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        {savingOwner === owner ? 'Saving settings...' : 'Save interception settings'}
      </button>
    </section>
  );
}
