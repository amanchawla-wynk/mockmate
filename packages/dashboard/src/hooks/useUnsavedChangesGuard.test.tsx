import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useUnsavedChangesGuard } from './useUnsavedChangesGuard';

describe('useUnsavedChangesGuard', () => {
  it('installs beforeunload while any draft is dirty', () => {
    const { result } = renderHook(() => useUnsavedChangesGuard());

    act(() => result.current.markDirty('p1:r1:s1'));
    const dirtyEvent = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(dirtyEvent);
    expect(dirtyEvent.defaultPrevented).toBe(true);

    act(() => result.current.clearDraft('p1:r1:s1'));
    const cleanEvent = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(cleanEvent);
    expect(cleanEvent.defaultPrevented).toBe(false);
  });

  it('retains the draft and pending action on Stay', () => {
    const action = vi.fn();
    const { result } = renderHook(() => useUnsavedChangesGuard());
    act(() => result.current.markDirty('p1:r1:s1'));
    act(() => result.current.attemptNavigation(action, 'p1:r1:s1'));

    expect(result.current.dialog).toEqual({ open: true, draftKey: 'p1:r1:s1' });
    act(() => result.current.stay());
    expect(result.current.dialog).toEqual({ open: false, draftKey: 'p1:r1:s1' });
    expect(action).not.toHaveBeenCalled();

    act(() => result.current.discard());
    expect(action).toHaveBeenCalledOnce();
    expect(result.current.dialog).toEqual({ open: false });
  });

  it('discards only the guarded draft before executing navigation', () => {
    const action = vi.fn();
    const secondAction = vi.fn();
    const { result } = renderHook(() => useUnsavedChangesGuard());
    act(() => {
      result.current.markDirty('p1:r1:s1');
      result.current.markDirty('p1:r1:s2');
    });
    act(() => result.current.attemptNavigation(action, 'p1:r1:s1'));
    act(() => result.current.discard());

    expect(action).toHaveBeenCalledOnce();
    act(() => result.current.attemptNavigation(secondAction, 'p1:r1:s2'));
    expect(secondAction).not.toHaveBeenCalled();
    expect(result.current.dialog).toEqual({ open: true, draftKey: 'p1:r1:s2' });
  });

  it('executes navigation immediately for a clean draft', () => {
    const action = vi.fn();
    const { result } = renderHook(() => useUnsavedChangesGuard());

    act(() => result.current.attemptNavigation(action, 'p1:r1:s1'));

    expect(action).toHaveBeenCalledOnce();
    expect(result.current.dialog).toEqual({ open: false });
  });

  it('guards every dirty owner and runs keyed discard callbacks before navigation', () => {
    const action = vi.fn();
    const discardEndpoint = vi.fn();
    const discardState = vi.fn();
    const { result } = renderHook(() => useUnsavedChangesGuard());
    act(() => {
      result.current.markDirty('endpoint:1', discardEndpoint);
      result.current.markDirty('state:1', discardState);
    });

    act(() => result.current.attemptNavigation(action));
    expect(action).not.toHaveBeenCalled();
    expect(result.current.dialog).toEqual({
      open: true,
      draftKeys: ['endpoint:1', 'state:1'],
    });
    act(() => result.current.stay());
    expect(discardEndpoint).not.toHaveBeenCalled();
    expect(discardState).not.toHaveBeenCalled();
    act(() => result.current.attemptNavigation(action));
    act(() => result.current.discard());
    expect(discardEndpoint).toHaveBeenCalledOnce();
    expect(discardState).toHaveBeenCalledOnce();
    expect(action).toHaveBeenCalledOnce();
  });

  it('discards only explicitly affected owners during an in-editor transition', () => {
    const action = vi.fn();
    const discardEndpoint = vi.fn();
    const discardVariant = vi.fn();
    const { result } = renderHook(() => useUnsavedChangesGuard());
    act(() => {
      result.current.markDirty('endpoint:1', discardEndpoint);
      result.current.markDirty('variant:1', discardVariant);
    });
    act(() => result.current.attemptNavigation(action, ['variant:1']));
    act(() => result.current.discard());

    expect(discardVariant).toHaveBeenCalledOnce();
    expect(discardEndpoint).not.toHaveBeenCalled();
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
  });
});
