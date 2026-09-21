import { useState } from 'react';

export type ListTreeView = 'list' | 'tree';

export function useStoredListTreeView(storageKey: string): [
  ListTreeView,
  (view: ListTreeView) => void,
] {
  const [view, setView] = useState<ListTreeView>(() => {
    try {
      return window.localStorage.getItem(storageKey) === 'tree' ? 'tree' : 'list';
    } catch {
      return 'list';
    }
  });

  const selectView = (next: ListTreeView) => {
    setView(next);
    try {
      window.localStorage.setItem(storageKey, next);
    } catch {
      // View preferences are optional and must never block the workspace.
    }
  };

  return [view, selectView];
}
