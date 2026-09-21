import {
  useMemo,
  useState,
  type KeyboardEvent,
} from 'react';

import type { EndpointSummary } from '../api/types';

export interface EndpointListProps {
  endpoints: EndpointSummary[];
  selectedEndpointId?: string;
  loading?: boolean;
  onSelect(endpointId: string): void;
  onImport(): void;
  onCreate(): void;
}

type EndpointView = 'list' | 'tree';

interface EndpointFolder {
  key: string;
  label: string;
  children: Map<string, EndpointFolder>;
  endpoints: EndpointSummary[];
}

type EndpointTreeRow =
  | { kind: 'folder'; key: string; label: string; depth: number; expanded: boolean }
  | { kind: 'endpoint'; key: string; endpoint: EndpointSummary; depth: number };

const ENDPOINT_VIEW_STORAGE_KEY = 'mockmate.endpoint-view.v1';

function readEndpointView(): EndpointView {
  try {
    const stored = window.localStorage.getItem(ENDPOINT_VIEW_STORAGE_KEY);
    return stored === 'tree' ? 'tree' : 'list';
  } catch {
    return 'list';
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameKeys(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

function buildEndpointTree(endpoints: EndpointSummary[]): {
  roots: EndpointFolder[];
  ancestorsByEndpoint: Map<string, string[]>;
} {
  const roots = new Map<string, EndpointFolder>();
  const ancestorsByEndpoint = new Map<string, string[]>();

  for (const endpoint of endpoints) {
    const existingRoot = roots.get(endpoint.baseUrl);
    let folder: EndpointFolder;
    if (existingRoot === undefined) {
      folder = {
        key: `origin:${JSON.stringify(endpoint.baseUrl)}`,
        label: endpoint.baseUrl,
        children: new Map(),
        endpoints: [],
      };
      roots.set(endpoint.baseUrl, folder);
    } else {
      folder = existingRoot;
    }

    const ancestors = [folder.key];
    for (const segment of endpoint.path.split('/').filter(Boolean)) {
      let child: EndpointFolder | undefined = folder.children.get(segment);
      if (child === undefined) {
        child = {
          key: `${folder.key}/path:${JSON.stringify(segment)}`,
          label: segment,
          children: new Map(),
          endpoints: [],
        };
        folder.children.set(segment, child);
      }
      folder = child;
      ancestors.push(folder.key);
    }
    folder.endpoints.push(endpoint);
    ancestorsByEndpoint.set(endpoint.id, ancestors);
  }

  return {
    roots: [...roots.values()].sort((left, right) => compareText(left.label, right.label)),
    ancestorsByEndpoint,
  };
}

function flattenEndpointTree(
  roots: EndpointFolder[],
  expanded: ReadonlySet<string>,
): EndpointTreeRow[] {
  const rows: EndpointTreeRow[] = [];
  const appendFolder = (folder: EndpointFolder, depth: number) => {
    const open = expanded.has(folder.key);
    rows.push({ kind: 'folder', key: folder.key, label: folder.label, depth, expanded: open });
    if (!open) return;

    const children = [...folder.children.values()]
      .sort((left, right) => compareText(left.label, right.label));
    for (const child of children) appendFolder(child, depth + 1);

    const leaves = [...folder.endpoints].sort((left, right) => (
      compareText(left.method, right.method)
      || compareText(left.name, right.name)
      || compareText(left.id, right.id)
    ));
    for (const endpoint of leaves) {
      rows.push({ kind: 'endpoint', key: `endpoint:${endpoint.id}`, endpoint, depth: depth + 1 });
    }
  };

  for (const root of roots) appendFolder(root, 1);
  return rows;
}

function treeItems(current: HTMLElement): HTMLElement[] {
  const tree = current.closest('[role="tree"]');
  return tree === null ? [] : [...tree.querySelectorAll<HTMLElement>('[role="treeitem"]')];
}

function focusTreeItem(current: HTMLElement, offset: number | 'first' | 'last') {
  const items = treeItems(current);
  const currentIndex = items.indexOf(current);
  const nextIndex = offset === 'first'
    ? 0
    : offset === 'last'
      ? items.length - 1
      : Math.min(items.length - 1, Math.max(0, currentIndex + offset));
  items[nextIndex]?.focus();
}

function EndpointCards({
  endpoints,
  selectedEndpointId,
  onSelect,
}: Pick<EndpointListProps, 'endpoints' | 'selectedEndpointId' | 'onSelect'>) {
  return endpoints.map(endpoint => (
    <button
      key={endpoint.id}
      type="button"
      onClick={() => onSelect(endpoint.id)}
      className={`mb-1 w-full rounded-md border px-3 py-2 text-left ${selectedEndpointId === endpoint.id ? 'border-blue-300 bg-blue-50' : 'border-transparent hover:bg-gray-50'}`}
    >
      <span className="block truncate text-sm font-medium text-gray-900">{endpoint.name}</span>
      <span className="mt-1 block truncate font-mono text-xs text-gray-500">
        {endpoint.method} {endpoint.baseUrl}{endpoint.path}
      </span>
      <span className="mt-1 flex flex-wrap gap-x-2 text-[11px] text-gray-500">
        <span>{endpoint.mode === 'mock' ? 'Mock' : 'Passthrough'}</span>
        <span>{endpoint.mockReady ? 'Mock ready' : 'Mock not ready'}</span>
        <span>{`${endpoint.variantCount} ${endpoint.variantCount === 1 ? 'variant' : 'variants'}`}</span>
        <span>{`${endpoint.queryConstraintCount} query expressions`}</span>
        <span>{`${endpoint.headerConstraintCount} header constraints`}</span>
        {' · '}
        <span>{`revision ${endpoint.revision}`}</span>
      </span>
    </button>
  ));
}

function EndpointTree({
  endpoints,
  selectedEndpointId,
  onSelect,
}: Pick<EndpointListProps, 'endpoints' | 'selectedEndpointId' | 'onSelect'>) {
  const tree = useMemo(() => buildEndpointTree(endpoints), [endpoints]);
  const selectedAncestors = selectedEndpointId === undefined
    ? []
    : tree.ancestorsByEndpoint.get(selectedEndpointId) ?? [];
  const [treeState, setTreeState] = useState(() => ({
    expanded: new Set(selectedAncestors),
    selectedEndpointId,
    selectedAncestors,
  }));
  const [focusedKey, setFocusedKey] = useState<string>();
  let currentTreeState = treeState;
  if (treeState.selectedEndpointId !== selectedEndpointId
    || !sameKeys(treeState.selectedAncestors, selectedAncestors)) {
    currentTreeState = {
      expanded: new Set([...treeState.expanded, ...selectedAncestors]),
      selectedEndpointId,
      selectedAncestors,
    };
    setTreeState(currentTreeState);
  }
  const rows = flattenEndpointTree(tree.roots, currentTreeState.expanded);
  const selectedKey = selectedEndpointId === undefined ? undefined : `endpoint:${selectedEndpointId}`;
  const defaultFocusKey = rows.some(row => row.key === selectedKey) ? selectedKey : rows[0]?.key;
  const activeFocusKey = rows.some(row => row.key === focusedKey) ? focusedKey : defaultFocusKey;

  const toggleFolder = (key: string) => {
    setTreeState(current => {
      const next = new Set(current.expanded);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return { ...current, expanded: next };
    });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, row: EndpointTreeRow) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      focusTreeItem(event.currentTarget, event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      focusTreeItem(event.currentTarget, event.key === 'Home' ? 'first' : 'last');
      return;
    }
    if (event.key === 'ArrowRight' && row.kind === 'folder') {
      event.preventDefault();
      if (!row.expanded) toggleFolder(row.key);
      else focusTreeItem(event.currentTarget, 1);
      return;
    }
    if (event.key !== 'ArrowLeft') return;
    event.preventDefault();
    if (row.kind === 'folder' && row.expanded) {
      toggleFolder(row.key);
      return;
    }
    const items = treeItems(event.currentTarget);
    const currentIndex = items.indexOf(event.currentTarget);
    for (let index = currentIndex - 1; index >= 0; index -= 1) {
      if (Number(items[index]!.getAttribute('aria-level')) < row.depth) {
        items[index]!.focus();
        return;
      }
    }
  };

  return (
    <div role="tree" aria-label="Endpoints by origin and path">
      {rows.map(row => row.kind === 'folder' ? (
        <button
          key={row.key}
          type="button"
          role="treeitem"
          aria-level={row.depth}
          aria-expanded={row.expanded}
          tabIndex={row.key === activeFocusKey ? 0 : -1}
          onClick={() => toggleFolder(row.key)}
          onFocus={() => setFocusedKey(row.key)}
          onKeyDown={event => handleKeyDown(event, row)}
          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-blue-500"
          style={{ paddingLeft: `${8 + (row.depth - 1) * 16}px` }}
        >
          <span aria-hidden="true" className="w-3 text-center text-gray-400">{row.expanded ? '-' : '+'}</span>
          <span className="truncate font-mono" title={row.label}>{row.label}</span>
        </button>
      ) : (
        <button
          key={row.key}
          type="button"
          role="treeitem"
          aria-level={row.depth}
          aria-selected={selectedEndpointId === row.endpoint.id}
          tabIndex={row.key === activeFocusKey ? 0 : -1}
          onClick={() => onSelect(row.endpoint.id)}
          onFocus={() => setFocusedKey(row.key)}
          onKeyDown={event => handleKeyDown(event, row)}
          className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left focus:outline-none focus:ring-2 focus:ring-inset focus:ring-blue-500 ${selectedEndpointId === row.endpoint.id ? 'bg-blue-50 text-blue-900' : 'text-gray-700 hover:bg-gray-50'}`}
          style={{ paddingLeft: `${8 + (row.depth - 1) * 16}px` }}
        >
          <span className="shrink-0 rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-gray-600">
            {row.endpoint.method}
          </span>
          <span className="truncate text-xs font-medium" title={row.endpoint.name}>{row.endpoint.name}</span>
        </button>
      ))}
    </div>
  );
}

export function EndpointList({
  endpoints,
  selectedEndpointId,
  loading = false,
  onSelect,
  onImport,
  onCreate,
}: EndpointListProps) {
  const [view, setView] = useState<EndpointView>(readEndpointView);
  const selectView = (next: EndpointView) => {
    setView(next);
    try {
      window.localStorage.setItem(ENDPOINT_VIEW_STORAGE_KEY, next);
    } catch {
      // Storage is an optional preference and must never block Endpoint work.
    }
  };

  return (
    <div className="flex h-full flex-col bg-white">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-200 px-4 py-3">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-semibold text-gray-800">Endpoints</h3>
          <div role="group" aria-label="Endpoint view" className="flex rounded border border-gray-300 bg-white p-0.5">
            {(['list', 'tree'] as const).map(option => (
              <button
                key={option}
                type="button"
                aria-pressed={view === option}
                onClick={() => selectView(option)}
                className={`rounded px-2 py-1 text-[11px] font-medium capitalize ${view === option ? 'bg-gray-800 text-white' : 'text-gray-600 hover:bg-gray-50'}`}
              >
                {option === 'list' ? 'List' : 'Tree'}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={onImport} className="rounded border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50">
            Import
          </button>
          <button type="button" onClick={onCreate} className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700">
            New Endpoint
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {loading ? <p className="p-3 text-xs text-gray-500">Loading Endpoints...</p> : null}
        {!loading && endpoints.length === 0 ? <p className="p-3 text-xs text-gray-500">No Endpoints yet.</p> : null}
        {endpoints.length > 0 && view === 'list' ? (
          <EndpointCards endpoints={endpoints} selectedEndpointId={selectedEndpointId} onSelect={onSelect} />
        ) : null}
        {endpoints.length > 0 && view === 'tree' ? (
          <EndpointTree endpoints={endpoints} selectedEndpointId={selectedEndpointId} onSelect={onSelect} />
        ) : null}
      </div>
    </div>
  );
}
