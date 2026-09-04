import type { RepositoryDiagnostic } from '../api/types';

export interface RepositoryDiagnosticsProps {
  diagnostics: RepositoryDiagnostic[];
}

export function RepositoryDiagnostics({ diagnostics }: RepositoryDiagnosticsProps) {
  if (diagnostics.length === 0) return null;
  return (
    <section aria-label="Repository diagnostics" className="border-b border-amber-300 bg-amber-50 px-4 py-3">
      <h2 className="text-sm font-semibold text-amber-950">Repository diagnostics</h2>
      <div className="mt-2 space-y-2">
        {diagnostics.map((diagnostic, index) => (
          <article key={`${diagnostic.code}:${diagnostic.file}:${diagnostic.path ?? ''}:${index}`} className="rounded border border-amber-200 bg-white p-3 text-xs text-gray-700">
            <div className="flex flex-wrap items-center gap-2">
              <strong className="text-gray-900">{diagnostic.code}</strong>
              <span className={diagnostic.severity === 'blocking' ? 'text-red-700' : 'text-amber-700'}>{diagnostic.severity}</span>
              <code>{diagnostic.file}{diagnostic.path ? `:${diagnostic.path}` : ''}</code>
            </div>
            <p className="mt-1">{diagnostic.message}</p>
            <p className="mt-1 font-medium">{diagnostic.recovery}</p>
            {diagnostic.requestId ? <p className="mt-1 text-gray-500">Request {diagnostic.requestId}</p> : null}
          </article>
        ))}
      </div>
    </section>
  );
}
