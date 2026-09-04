import { useEffect, useRef } from 'react';

import type { ImportCommitResult } from '../../api/types';

export interface ImportResultStepProps {
  result: ImportCommitResult;
  discoveredOrigins: string[];
  onViewEndpoints(): void;
}

function countLabel(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function ImportResultStep({ result, discoveredOrigins, onViewEndpoints }: ImportResultStepProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const counts = [
    countLabel(result.createdEndpointIds.length, 'Endpoint created', 'Endpoints created'),
    countLabel(result.updatedEndpointIds.length, 'Endpoint updated', 'Endpoints updated'),
    countLabel(result.createdVariantIds.length, 'Variant created', 'Variants created'),
    countLabel(result.skippedItemIds.length, 'request skipped', 'requests skipped'),
  ];

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 items-start justify-center overflow-y-auto px-4 py-8 sm:px-6 sm:py-12">
        <div className="w-full max-w-xl">
          <h2 ref={headingRef} tabIndex={-1} className="text-xl font-semibold text-gray-900">Import complete</h2>
          <p className="mt-2 text-sm text-gray-600">The dashboard now reflects the canonical import result.</p>
          <dl className="mt-6 grid grid-cols-1 gap-px overflow-hidden rounded-md border border-gray-200 bg-gray-200 sm:grid-cols-2">
            {counts.map(label => (
              <div key={label} className="bg-white px-4 py-3 text-sm font-medium text-gray-900">{label}</div>
            ))}
           </dl>
           {discoveredOrigins.length > 0 ? (
             <section className="mt-6 rounded-md border border-amber-200 bg-amber-50 p-4" aria-labelledby="interception-checklist-heading">
               <h3 id="interception-checklist-heading" className="text-sm font-semibold text-amber-900">Review interception checklist</h3>
               <p className="mt-1 text-sm text-amber-800">Interception settings were not changed.</p>
               <ul className="mt-3 space-y-1 font-mono text-xs text-amber-900">
                 {discoveredOrigins.map(origin => <li key={origin}>{origin}</li>)}
               </ul>
             </section>
           ) : null}
        </div>
      </div>
      <div className="flex shrink-0 justify-end border-t border-gray-200 bg-gray-50 px-4 py-3 sm:px-6">
        <button
          type="button"
          onClick={onViewEndpoints}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
        >
          View Endpoints
        </button>
      </div>
    </div>
  );
}
