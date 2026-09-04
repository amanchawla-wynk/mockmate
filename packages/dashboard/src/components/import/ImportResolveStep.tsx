import { useEffect, useRef } from 'react';

import type { ImportPreview } from '../../api/types';

export interface ImportResolveStepProps {
  preview: ImportPreview;
  variables: Record<string, string>;
  error?: Error;
  loading: boolean;
  disabled: boolean;
  onVariableChange(name: string, value: string): void;
  onContinue(): Promise<void>;
}

function sourceLabel(location: ImportPreview['unresolvedMembers'][number]['location'], breadcrumb: string[]) {
  if (breadcrumb.length > 0) return breadcrumb.join(' / ');
  return location.type === 'curl'
    ? `cURL command ${location.commandIndex + 1}`
    : `Postman item ${location.itemPath.map(index => index + 1).join('.')}`;
}

export function ImportResolveStep({
  preview,
  variables,
  error,
  loading,
  disabled,
  onVariableChange,
  onContinue,
}: ImportResolveStepProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const firstVariableRef = useRef<HTMLInputElement>(null);
  const invalidItems = preview.items.filter(item => item.errors.length > 0);
  const canContinue = preview.unresolvedVariables.every(requirement => variables[requirement.name]?.trim());

  useEffect(() => {
    (firstVariableRef.current ?? headingRef.current)?.focus();
  }, []);

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
        <div className="mx-auto max-w-3xl space-y-6">
          <div>
            <h2 ref={headingRef} tabIndex={-1} className="text-base font-semibold text-gray-900">Resolve import issues</h2>
            <p className="mt-1 text-sm text-gray-600">
              Supply URL variables and review requests that cannot be imported.
            </p>
          </div>

          {preview.unresolvedVariables.length > 0 ? (
            <section aria-labelledby="import-variables-heading" className="space-y-4">
              <h3 id="import-variables-heading" className="text-sm font-semibold text-gray-900">URL variables</h3>
              {preview.unresolvedVariables.map((requirement, index) => {
                const helperId = `import-variable-${requirement.name}-helper`;
                return (
                  <div key={requirement.name} className="space-y-2">
                    <label htmlFor={`import-variable-${requirement.name}`} className="block text-sm font-medium text-gray-800">
                      {requirement.name}
                    </label>
                    <input
                      ref={index === 0 ? firstVariableRef : undefined}
                      id={`import-variable-${requirement.name}`}
                      value={variables[requirement.name] ?? ''}
                      aria-describedby={helperId}
                      disabled={disabled || loading}
                      onChange={event => onVariableChange(requirement.name, event.target.value)}
                      className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/30 disabled:cursor-not-allowed disabled:bg-gray-100"
                    />
                    <p id={helperId} className="text-sm text-gray-600">
                      Used in {requirement.memberIds.length} source {requirement.memberIds.length === 1 ? 'request' : 'requests'}.
                    </p>
                  </div>
                );
              })}
            </section>
          ) : null}

          {invalidItems.length > 0 || preview.unresolvedMembers.length > 0 ? (
            <section aria-labelledby="invalid-import-heading">
              <h3 id="invalid-import-heading" className="text-sm font-semibold text-gray-900">Requests needing attention</h3>
              <ul className="mt-2 divide-y divide-gray-200 rounded-md border border-gray-200">
                {invalidItems.map(item => (
                  <li key={item.id} className="flex gap-3 p-3">
                    <input type="checkbox" aria-label={`Select ${item.name}`} disabled className="mt-1 h-4 w-4" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-900">{item.name}</p>
                      {item.errors.map(message => <p key={`${message.code}:${message.memberId ?? ''}`} className="mt-1 text-sm text-red-700">{message.message}</p>)}
                    </div>
                  </li>
                ))}
                {preview.unresolvedMembers.map(member => (
                  <li key={member.id} className="flex gap-3 p-3">
                    <input type="checkbox" aria-label={`Select ${member.name}`} disabled className="mt-1 h-4 w-4" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-900">{member.name}</p>
                      <p className="mt-1 text-xs text-gray-600">{sourceLabel(member.location, member.breadcrumb)}</p>
                      {member.errors.map(message => <p key={message.code} className="mt-1 text-sm text-red-700">{message.message}</p>)}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {error ? <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error.message}</p> : null}
        </div>
      </div>

      <div className="flex shrink-0 justify-end border-t border-gray-200 bg-gray-50 px-4 py-3 sm:px-6">
        <button
          type="button"
          onClick={() => void onContinue()}
          disabled={disabled || loading || !canContinue}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? 'Checking variables...' : 'Continue to review'}
        </button>
      </div>
    </>
  );
}
