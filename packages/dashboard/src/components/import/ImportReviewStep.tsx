import { useEffect, useRef, useState } from 'react';

import type { ImportPreview, ImportPreviewItem, ResponseHeaders } from '../../api/types';
import type { ImportItemChoice } from '../../hooks/useImportWizard';

type ReviewFilter = 'Selected' | 'Warnings' | 'Errors' | 'New' | 'Merge';

export interface ImportReviewStepProps {
  preview: ImportPreview;
  choices: Record<string, ImportItemChoice>;
  canCommit: boolean;
  stale: boolean;
  outcomeUnknown: boolean;
  error?: Error;
  committing: boolean;
  refreshing: boolean;
  onChoiceChange(itemId: string, patch: Partial<ImportItemChoice>): void;
  onRefresh(): Promise<void>;
  onCommit(): Promise<void>;
}

function sourceLabels(item: ImportPreviewItem): string[] {
  return item.locations.map((location, index) => {
    const breadcrumb = item.breadcrumbs[index] ?? [];
    if (breadcrumb.length > 0) return breadcrumb.join(' / ');
    return location.type === 'curl'
      ? `cURL command ${location.commandIndex + 1}`
      : `Postman item ${location.itemPath.map(part => part + 1).join('.')}`;
  });
}

function matchesFilter(
  filter: ReviewFilter | undefined,
  item: ImportPreviewItem,
  choice: ImportItemChoice | undefined,
): boolean {
  if (!filter) return true;
  if (filter === 'Selected') return choice?.selected === true;
  if (filter === 'Warnings') return item.warnings.length > 0;
  if (filter === 'Errors') return item.errors.length > 0;
  if (filter === 'New') return choice?.action === 'create';
  return choice?.action === 'merge';
}

function headerEntries(headers: ResponseHeaders) {
  return Object.entries(headers).map(([name, value]) => [name, Array.isArray(value) ? value.join(', ') : value]);
}

function Summary({
  preview,
  choices,
}: Pick<ImportReviewStepProps, 'preview' | 'choices'>) {
  const selected = preview.items.filter(item => choices[item.id]?.selected);
  const selectedRequests = selected.reduce((count, item) => count + item.requests.length, 0);
  const newEndpoints = selected.filter(item => {
    const choice = choices[item.id];
    return choice?.action === 'create' && item.createEffect.createsEndpoint;
  }).length;
  const mergedVariants = selected.reduce((count, item) => {
    const choice = choices[item.id];
    if (choice?.action !== 'merge') return count;
    return count + (item.exactTargets.find(target => target.endpointId === choice.endpointId)?.newVariantCount ?? 0);
  }, 0);
  const skippedDuplicates = preview.items.filter(item => (
    item.proposedAction === 'skip' && item.errors.length === 0
    && item.allowedActions.includes('merge')
    && item.exactTargets.some(target => target.newVariantCount === 0)
  )).length;
  const metrics = [
    { label: 'Selected requests', value: selectedRequests, testId: 'selected-requests-count' },
    { label: 'New Endpoints', value: newEndpoints, testId: 'new-endpoints-count' },
    { label: 'Merged Variants', value: mergedVariants, testId: 'merged-variants-count' },
    { label: 'Discovered origins', value: preview.discoveredOrigins.length, testId: 'discovered-origins-count' },
    { label: 'Skipped duplicates', value: skippedDuplicates, testId: 'skipped-duplicates-count' },
    { label: 'Affected App States', value: preview.affectedStates.length, testId: 'affected-states-count' },
  ];

  return (
    <aside aria-label="Import impact" className="border-t border-gray-200 bg-gray-50 px-4 py-4 sm:px-6">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-6">
        {metrics.map(metric => (
          <div key={metric.label}>
            <dt className="text-xs text-gray-600">{metric.label}</dt>
            <dd data-testid={metric.testId} className="mt-0.5 text-lg font-semibold tabular-nums text-gray-900">{metric.value}</dd>
          </div>
        ))}
      </dl>
      <ul className="mt-4 grid gap-1 text-xs text-gray-600 sm:grid-cols-2">
        <li>Imported origins and query values become Endpoint matchers only.</li>
        <li>Interception settings are unchanged.</li>
        <li>Imported Endpoints remain unbound in existing App States.</li>
        <li>Each Endpoint keeps its Serving now Variant.</li>
      </ul>
      {preview.affectedStates.length > 0 ? (
        <p className="mt-2 text-xs text-gray-600">
          Potentially affected App States: {preview.affectedStates.map(state => state.name).join(', ')}.
        </p>
      ) : null}
    </aside>
  );
}

function ExpandedDetails({ item }: { item: ImportPreviewItem }) {
  const hasHiddenQueryValues = item.requests.some(request => (
    request.query.some(field => field.value === '[REDACTED]')
  ));
  return (
    <div className="space-y-4 bg-gray-50 px-3 py-4 sm:px-4">
      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-700">Redacted requests</h4>
        <div className="mt-2 space-y-3">
          {hasHiddenQueryValues ? (
            <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              Hidden query values will become local canonical matcher configuration.
            </p>
          ) : null}
          {item.requests.map((request, index) => (
            <div key={index} className="rounded-md border border-gray-200 bg-white p-3 text-xs text-gray-700">
              <p className="font-medium text-gray-900">Request {index + 1}</p>
              {[...request.query, ...request.headers, ...(request.auth?.fields ?? [])].map((field, fieldIndex) => (
                <p key={`${field.name}:${fieldIndex}`} className="mt-1 break-all">
                  <span className="font-medium">{field.name}:</span> {field.value}
                </p>
              ))}
              {request.auth ? <p className="mt-1">Auth type: {request.auth.type}</p> : null}
              {request.body ? <p className="mt-1">Body omitted, {request.body.byteCount} bytes{request.body.mediaType ? `, ${request.body.mediaType}` : ''}</p> : null}
            </div>
          ))}
        </div>
      </div>
      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-700">Response summaries</h4>
        <ul className="mt-2 space-y-2">
          {item.responses.map((response, index) => (
            <li key={`${response.identity}:${index}`} className="rounded-md border border-gray-200 bg-white p-3 text-xs text-gray-700">
              <p className="font-medium text-gray-900">
                {response.name}, status {response.status}, {response.body.kind === 'none' ? 'no body' : `${response.body.byteCount} bytes`}
              </p>
              {headerEntries(response.responseHeaders).map(([name]) => (
                <p key={name} className="mt-1 break-all"><span className="font-medium">{name}:</span> [redacted]</p>
              ))}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function ImportReviewStep({
  preview,
  choices,
  canCommit,
  stale,
  outcomeUnknown,
  error,
  committing,
  refreshing,
  onChoiceChange,
  onRefresh,
  onCommit,
}: ImportReviewStepProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [filter, setFilter] = useState<ReviewFilter>();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const items = preview.items.filter(item => matchesFilter(filter, item, choices[item.id]));
  const controlsDisabled = committing || stale || outcomeUnknown;
  const staleApiError = error !== undefined
    && 'code' in error
    && error.code === 'IMPORT_PREVIEW_STALE';

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const toggleExpanded = (itemId: string) => {
    setExpanded(current => {
      const next = new Set(current);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-gray-200 px-4 py-3 sm:px-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 ref={headingRef} tabIndex={-1} className="text-base font-semibold text-gray-900">Review import</h2>
            <p className="mt-0.5 text-sm text-gray-600">Choose requests and resolve each import action.</p>
          </div>
          <div aria-label="Review filters" className="flex flex-wrap gap-1.5">
            {(['Selected', 'Warnings', 'Errors', 'New', 'Merge'] as const).map(value => (
              <button
                key={value}
                type="button"
                aria-label={`Filter ${value}`}
                aria-pressed={filter === value}
                disabled={committing}
                onClick={() => setFilter(current => current === value ? undefined : value)}
                className={`rounded border px-2.5 py-1 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1 ${
                  filter === value ? 'border-blue-300 bg-blue-50 text-blue-700' : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
                } disabled:cursor-not-allowed disabled:opacity-50`}
              >
                {value}
              </button>
            ))}
          </div>
        </div>
        {preview.warnings.length > 0 ? (
          <div className="mt-3 space-y-1 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            {preview.warnings.map((message, index) => <p key={`${message.code}:${message.memberId ?? ''}:${index}`}>{message.message}</p>)}
          </div>
        ) : null}
        {stale ? (
          <p role="alert" className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            This preview is stale. Refresh it before importing.
          </p>
        ) : null}
        {error && !staleApiError ? (
          <p role="alert" className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error.message}</p>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {preview.items.length === 0 ? (
          <div className="px-4 py-10 text-center sm:px-6">
            <p className="text-sm font-medium text-gray-900">No importable requests were found.</p>
            <p className="mt-1 text-sm text-gray-600">Return to the source and choose a collection with requests.</p>
          </div>
        ) : items.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-gray-600">No requests match this filter.</p>
        ) : (
          <div role="table" aria-label="Import requests" className="min-w-full divide-y divide-gray-200">
            <div role="row" className="hidden grid-cols-[2.25rem_minmax(14rem,1.5fr)_minmax(10rem,1fr)_8rem_minmax(9rem,0.8fr)_2.5rem] gap-3 bg-gray-50 px-3 py-2 text-xs font-semibold text-gray-600 md:grid">
              <span role="columnheader"><span className="sr-only">Selected</span></span>
              <span role="columnheader">Request</span>
              <span role="columnheader">Source</span>
              <span role="columnheader">Responses</span>
              <span role="columnheader">Action</span>
              <span role="columnheader"><span className="sr-only">Details</span></span>
            </div>
            {items.map(item => {
              const choice = choices[item.id];
              const isExpanded = expanded.has(item.id);
              const requiresConfirmation = choice?.action === 'create'
                && item.overlaps.some(overlap => overlap.confirmationRequired);
              return (
                <div key={item.id} role="rowgroup" className="bg-white">
                  <div role="row" className="grid grid-cols-[2rem_minmax(0,1fr)_2.5rem] gap-2 px-3 py-3 md:grid-cols-[2.25rem_minmax(14rem,1.5fr)_minmax(10rem,1fr)_8rem_minmax(9rem,0.8fr)_2.5rem] md:gap-3">
                    <div role="cell">
                      <input
                        type="checkbox"
                        aria-label={`Select ${item.name}`}
                        checked={choice?.selected ?? false}
                        disabled={controlsDisabled
                          || item.errors.length > 0
                          || item.allowedActions.every(action => action === 'skip')}
                        onChange={event => onChoiceChange(item.id, { selected: event.target.checked })}
                        className="mt-0.5 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
                      />
                    </div>
                    <div role="cell" className="min-w-0">
                      <p className="text-sm font-medium text-gray-900"><span className="mr-2 font-mono text-xs text-blue-700">{item.matcher.method}</span>{item.name}</p>
                       <p className="mt-0.5 break-all font-mono text-xs text-gray-700">{item.baseUrl}{item.matcher.path}</p>
                      <div className="mt-2 space-y-1">
                        {item.warnings.map((message, index) => <p key={`${message.code}:${message.memberId ?? ''}:${index}`} className="text-xs text-amber-700">{message.message}</p>)}
                        {item.errors.map((message, index) => <p key={`${message.code}:${message.memberId ?? ''}:${index}`} className="text-xs text-red-700">{message.message}</p>)}
                        {item.overlaps.map((overlap, index) => (
                          <p key={`${overlap.endpointId ?? overlap.itemId ?? 'overlap'}:${index}`} className="text-xs text-amber-700">
                             Overlaps {overlap.endpointId ? `Endpoint ${overlap.endpointId}` : `import item ${overlap.itemId}`}: {overlap.matcher.method} {overlap.baseUrl}{overlap.matcher.path} ({overlap.relativeSpecificity} specificity)
                          </p>
                        ))}
                      </div>
                    </div>
                    <div role="cell" className="col-start-2 min-w-0 md:col-auto">
                      {sourceLabels(item).map((label, index) => <p key={`${label}:${index}`} className="break-words text-xs text-gray-600">{label}</p>)}
                    </div>
                    <div role="cell" className="col-start-2 text-xs text-gray-700 md:col-auto">
                      {item.responses.length} {item.responses.length === 1 ? 'response' : 'responses'}
                    </div>
                    <div role="cell" className="col-span-2 ml-8 space-y-2 md:col-span-1 md:ml-0">
                      <label htmlFor={`import-action-${item.id}`} className="block text-xs font-medium text-gray-700 md:sr-only">Action for {item.name}</label>
                      <select
                        id={`import-action-${item.id}`}
                        aria-label={`Action for ${item.name}`}
                        value={choice?.action ?? ''}
                        disabled={controlsDisabled || item.errors.length > 0 || !choice?.selected}
                        onChange={event => {
                          const action = event.target.value as ImportItemChoice['action'];
                          onChoiceChange(item.id, {
                            action,
                            endpointId: action === 'merge' && item.exactTargets.length === 1
                              ? item.exactTargets[0]!.endpointId
                              : undefined,
                            confirmOverlap: action === 'create' ? false : undefined,
                          });
                        }}
                        className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/30 disabled:cursor-not-allowed disabled:bg-gray-100"
                      >
                        <option value="">Resolve action</option>
                        {item.allowedActions.map(action => <option key={action} value={action}>{action === 'create' ? 'Create new' : action === 'merge' ? 'Merge' : 'Skip'}</option>)}
                      </select>
                      {choice?.action === 'merge' ? (
                        <>
                          <label htmlFor={`import-target-${item.id}`} className="block text-xs font-medium text-gray-700">Merge target for {item.name}</label>
                          <select
                            id={`import-target-${item.id}`}
                            aria-label={`Merge target for ${item.name}`}
                            value={choice.endpointId ?? ''}
                            disabled={controlsDisabled || !choice.selected}
                            onChange={event => onChoiceChange(item.id, { endpointId: event.target.value || undefined })}
                            className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/30 disabled:cursor-not-allowed disabled:bg-gray-100"
                          >
                            <option value="">Choose Endpoint</option>
                            {item.exactTargets.map(target => (
                              <option key={target.endpointId} value={target.endpointId}>{target.name} ({target.newVariantCount} new)</option>
                            ))}
                          </select>
                        </>
                      ) : null}
                      {requiresConfirmation ? (
                        <label className="flex items-start gap-2 text-xs text-gray-700">
                          <input
                            type="checkbox"
                            aria-label={`Confirm overlap for ${item.name}`}
                            checked={choice.confirmOverlap ?? false}
                            disabled={controlsDisabled || !choice.selected}
                            onChange={event => onChoiceChange(item.id, { confirmOverlap: event.target.checked })}
                            className="mt-0.5 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
                          />
                          Confirm equal-specificity overlap
                        </label>
                      ) : null}
                    </div>
                    <div role="cell" className="col-start-3 row-start-1 md:col-auto md:row-auto">
                      <button
                        type="button"
                        aria-label={`${isExpanded ? 'Hide' : 'Show'} details for ${item.name}`}
                        aria-expanded={isExpanded}
                        onClick={() => toggleExpanded(item.id)}
                        disabled={committing}
                        className="rounded px-2 py-1 text-sm font-medium text-gray-600 hover:bg-gray-100 hover:text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {isExpanded ? 'Hide' : 'Show'}
                      </button>
                    </div>
                  </div>
                  {isExpanded ? <ExpandedDetails item={item} /> : null}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <Summary preview={preview} choices={choices} />
      <div className="flex shrink-0 items-center justify-end gap-2 border-t border-gray-200 bg-white px-4 py-3 sm:px-6">
        {stale ? (
          <button
            type="button"
            onClick={() => void onRefresh()}
            disabled={committing || refreshing}
            className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {refreshing ? 'Refreshing preview...' : 'Refresh preview'}
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => void onCommit()}
          disabled={committing || stale || outcomeUnknown || !canCommit}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {committing ? 'Importing...' : 'Import selected'}
        </button>
      </div>
    </div>
  );
}
