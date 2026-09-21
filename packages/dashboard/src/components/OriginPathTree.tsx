import {
  useMemo,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

export interface OriginPathTreeItem {
  id: string;
  origin: string;
  path: string;
}

interface OriginPathFolder<T> {
  key: string;
  label: string;
  children: Map<string, OriginPathFolder<T>>;
  items: T[];
}

type OriginPathTreeRow<T> =
  | { kind: 'folder'; key: string; label: string; depth: number; expanded: boolean }
  | { kind: 'item'; key: string; item: T; depth: number };

export interface OriginPathTreeProps<T extends OriginPathTreeItem> {
  items: readonly T[];
  selectedId?: string;
  ariaLabel: string;
  compareItems(left: T, right: T): number;
  renderItem(item: T, selected: boolean): ReactNode;
  onSelect(id: string): void;
  itemClassName?(item: T, selected: boolean): string;
}

function compareTreeText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameKeys(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

function buildTree<T extends OriginPathTreeItem>(items: readonly T[]): {
  roots: OriginPathFolder<T>[];
  ancestorsByItem: Map<string, string[]>;
} {
  const roots = new Map<string, OriginPathFolder<T>>();
  const ancestorsByItem = new Map<string, string[]>();

  for (const item of items) {
    const existingRoot = roots.get(item.origin);
    let folder: OriginPathFolder<T>;
    if (existingRoot === undefined) {
      folder = {
        key: `origin:${JSON.stringify(item.origin)}`,
        label: item.origin,
        children: new Map(),
        items: [],
      };
      roots.set(item.origin, folder);
    } else {
      folder = existingRoot;
    }

    const ancestors = [folder.key];
    for (const segment of item.path.split('/').filter(Boolean)) {
      let child: OriginPathFolder<T> | undefined = folder.children.get(segment);
      if (child === undefined) {
        child = {
          key: `${folder.key}/path:${JSON.stringify(segment)}`,
          label: segment,
          children: new Map(),
          items: [],
        };
        folder.children.set(segment, child);
      }
      folder = child;
      ancestors.push(folder.key);
    }
    folder.items.push(item);
    ancestorsByItem.set(item.id, ancestors);
  }

  return {
    roots: [...roots.values()].sort((left, right) => compareTreeText(left.label, right.label)),
    ancestorsByItem,
  };
}

function flattenTree<T extends OriginPathTreeItem>(
  roots: OriginPathFolder<T>[],
  expanded: ReadonlySet<string>,
  compareItems: (left: T, right: T) => number,
): OriginPathTreeRow<T>[] {
  const rows: OriginPathTreeRow<T>[] = [];
  const appendFolder = (folder: OriginPathFolder<T>, depth: number) => {
    const open = expanded.has(folder.key);
    rows.push({ kind: 'folder', key: folder.key, label: folder.label, depth, expanded: open });
    if (!open) return;

    const children = [...folder.children.values()]
      .sort((left, right) => compareTreeText(left.label, right.label));
    for (const child of children) appendFolder(child, depth + 1);

    for (const item of [...folder.items].sort(compareItems)) {
      rows.push({ kind: 'item', key: `item:${JSON.stringify(item.id)}`, item, depth: depth + 1 });
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

export function OriginPathTree<T extends OriginPathTreeItem>({
  items,
  selectedId,
  ariaLabel,
  compareItems,
  renderItem,
  onSelect,
  itemClassName,
}: OriginPathTreeProps<T>) {
  const tree = useMemo(() => buildTree(items), [items]);
  const selectedAncestors = selectedId === undefined
    ? []
    : tree.ancestorsByItem.get(selectedId) ?? [];
  const [treeState, setTreeState] = useState(() => ({
    expanded: new Set(selectedAncestors),
    selectedId,
    selectedAncestors,
  }));
  const [focusedKey, setFocusedKey] = useState<string>();
  let currentTreeState = treeState;
  if (treeState.selectedId !== selectedId
    || !sameKeys(treeState.selectedAncestors, selectedAncestors)) {
    currentTreeState = {
      expanded: new Set([...treeState.expanded, ...selectedAncestors]),
      selectedId,
      selectedAncestors,
    };
    setTreeState(currentTreeState);
  }
  const rows = flattenTree(tree.roots, currentTreeState.expanded, compareItems);
  const selectedKey = selectedId === undefined ? undefined : `item:${JSON.stringify(selectedId)}`;
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

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, row: OriginPathTreeRow<T>) => {
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
    <div role="tree" aria-label={ariaLabel}>
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
          aria-selected={selectedId === row.item.id}
          tabIndex={row.key === activeFocusKey ? 0 : -1}
          onClick={() => onSelect(row.item.id)}
          onFocus={() => setFocusedKey(row.key)}
          onKeyDown={event => handleKeyDown(event, row)}
          className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left focus:outline-none focus:ring-2 focus:ring-inset focus:ring-blue-500 ${itemClassName?.(row.item, selectedId === row.item.id) ?? (selectedId === row.item.id ? 'bg-blue-50 text-blue-900' : 'text-gray-700 hover:bg-gray-50')}`}
          style={{ paddingLeft: `${8 + (row.depth - 1) * 16}px` }}
        >
          {renderItem(row.item, selectedId === row.item.id)}
        </button>
      ))}
    </div>
  );
}
