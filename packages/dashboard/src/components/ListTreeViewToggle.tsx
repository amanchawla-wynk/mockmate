import type { ListTreeView } from '../hooks/useStoredListTreeView';

export function ListTreeViewToggle({
  label,
  view,
  onChange,
}: {
  label: string;
  view: ListTreeView;
  onChange(view: ListTreeView): void;
}) {
  return (
    <div role="group" aria-label={label} className="flex rounded border border-gray-300 bg-white p-0.5">
      {(['list', 'tree'] as const).map(option => (
        <button
          key={option}
          type="button"
          aria-pressed={view === option}
          onClick={() => onChange(option)}
          className={`rounded px-2 py-1 text-[11px] font-medium ${view === option ? 'bg-gray-800 text-white' : 'text-gray-600 hover:bg-gray-50'}`}
        >
          {option === 'list' ? 'List' : 'Tree'}
        </button>
      ))}
    </div>
  );
}
