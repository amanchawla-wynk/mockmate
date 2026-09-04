import { useEffect, useRef, useState } from 'react';

export interface UnsavedChangesGuard {
  markDirty(draftKey: string, discard?: () => void): void;
  clearDraft(draftKey: string): void;
  attemptNavigation(action: () => void, draftKeys?: string | string[]): void;
  stay(): void;
  discard(): void;
  dialog: { open: boolean; draftKey?: string; draftKeys?: string[] };
}

export function useUnsavedChangesGuard(): UnsavedChangesGuard {
  const [dirtyDrafts, setDirtyDrafts] = useState<Set<string>>(() => new Set());
  const [dialog, setDialog] = useState<UnsavedChangesGuard['dialog']>({ open: false });
  const pendingAction = useRef<(() => void) | undefined>(undefined);
  const discarders = useRef(new Map<string, () => void>());

  useEffect(() => {
    if (dirtyDrafts.size === 0) return;

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [dirtyDrafts]);

  const markDirty = (draftKey: string, discard?: () => void) => {
    if (discard) discarders.current.set(draftKey, discard);
    setDirtyDrafts(current => {
      if (current.has(draftKey)) return current;
      const next = new Set(current);
      next.add(draftKey);
      return next;
    });
  };

  const clearDraft = (draftKey: string) => {
    discarders.current.delete(draftKey);
    setDirtyDrafts(current => {
      if (!current.has(draftKey)) return current;
      const next = new Set(current);
      next.delete(draftKey);
      return next;
    });
  };

  const attemptNavigation = (action: () => void, draftKeys?: string | string[]) => {
    const affected = (draftKeys === undefined
      ? [...dirtyDrafts]
      : Array.isArray(draftKeys) ? draftKeys : [draftKeys]
    ).filter(draftKey => dirtyDrafts.has(draftKey));
    if (affected.length === 0) {
      action();
      return;
    }
    pendingAction.current = action;
    setDialog(affected.length === 1 && typeof draftKeys === 'string'
      ? { open: true, draftKey: affected[0] }
      : { open: true, draftKeys: affected });
  };

  const stay = () => {
    setDialog(current => ({ ...current, open: false }));
  };

  const discard = () => {
    const draftKeys = dialog.draftKeys ?? (dialog.draftKey ? [dialog.draftKey] : []);
    const action = pendingAction.current;
    for (const draftKey of draftKeys) discarders.current.get(draftKey)?.();
    setDirtyDrafts(current => {
      const next = new Set(current);
      for (const draftKey of draftKeys) {
        next.delete(draftKey);
        discarders.current.delete(draftKey);
      }
      return next;
    });
    pendingAction.current = undefined;
    setDialog({ open: false });
    action?.();
  };

  return { markDirty, clearDraft, attemptNavigation, stay, discard, dialog };
}
