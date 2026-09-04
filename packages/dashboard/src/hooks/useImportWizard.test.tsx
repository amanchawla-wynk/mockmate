import { act, renderHook, waitFor } from '@testing-library/react';
import { useLayoutEffect, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiClientError, importApi } from '../api/client';
import type { ImportPreview, ImportPreviewItem } from '../api/types';
import {
  ImportCommitOutcomeUnknownError,
  ImportWizardValidationError,
  reconcileImportChoices,
  useImportWizard,
} from './useImportWizard';

function previewItem(overrides: Partial<ImportPreviewItem> = {}): ImportPreviewItem {
  return {
    id: 'create-item',
    memberIds: ['member-1'],
    locations: [{ type: 'curl', commandIndex: 0 }],
    breadcrumbs: [[]],
    name: 'List users',
    baseUrl: 'https://api.example.test',
    matcher: { method: 'GET', path: '/users' },
    requests: [{
      scheme: 'https',
      hostname: 'api.example.test',
      query: [],
      headers: [],
    }],
    responses: [{
      name: 'Default',
      status: 200,
      responseHeaders: {},
      body: { kind: 'none' },
      identity: 'response-1',
    }],
    proposedAction: 'create',
    allowedActions: ['create', 'skip'],
    exactTargets: [],
    overlaps: [],
    warnings: [],
    errors: [],
    selectedByDefault: true,
    createEffect: { createsEndpoint: true, createsVariants: 1 },
    ...overrides,
  };
}

function importPreview(overrides: Partial<ImportPreview> = {}): ImportPreview {
  return {
    snapshotToken: 'snapshot-1',
    sourceType: 'curl',
    items: [previewItem()],
    unresolvedMembers: [],
    unresolvedVariables: [],
    warnings: [],
    discoveredOrigins: ['https://api.example.test'],
    affectedStates: [],
    summary: { valid: 1, invalid: 0, create: 1, merge: 0, skip: 0 },
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function runBeforePassiveEffects(operation: () => Promise<void>) {
  const environment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  const previous = environment.IS_REACT_ACT_ENVIRONMENT;
  environment.IS_REACT_ACT_ENVIRONMENT = false;
  try {
    await operation();
  } finally {
    environment.IS_REACT_ACT_ENVIRONMENT = previous;
  }
}

describe('useImportWizard', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('aborts and resets preview state when the Project changes', async () => {
    const pending = deferred<ImportPreview>();
    let previewSignal: AbortSignal | undefined;
    vi.spyOn(importApi, 'preview').mockImplementation((_projectId, _input, signal) => {
      previewSignal = signal;
      return pending.promise;
    });
    const { result, rerender } = renderHook(
      ({ projectId }) => useImportWizard(projectId),
      { initialProps: { projectId: 'project-a' } },
    );

    act(() => result.current.setCurlText('curl https://api.example.test/users'));
    act(() => { void result.current.previewSource(); });
    await waitFor(() => expect(result.current.loadingPreview).toBe(true));

    rerender({ projectId: 'project-b' });

    expect(previewSignal?.aborted).toBe(true);
    expect(result.current.curlText).toBe('');
    expect(result.current.preview).toBeUndefined();
    expect(result.current.step).toBe('source');
    expect(result.current.dirty).toBe(false);
  });

  it('publishes only the newest preview when an older request resolves last', async () => {
    const older = deferred<ImportPreview>();
    const newer = deferred<ImportPreview>();
    const signals: AbortSignal[] = [];
    vi.spyOn(importApi, 'preview')
      .mockImplementationOnce((_projectId, _input, signal) => {
        signals.push(signal!);
        return older.promise;
      })
      .mockImplementationOnce((_projectId, _input, signal) => {
        signals.push(signal!);
        return newer.promise;
      });
    const { result } = renderHook(() => useImportWizard('project-a'));
    act(() => result.current.setCurlText('curl https://api.example.test/users'));

    act(() => { void result.current.previewSource(); });
    act(() => { void result.current.previewSource(); });
    expect(signals[0]?.aborted).toBe(true);

    await act(async () => newer.resolve(importPreview({ snapshotToken: 'newer' })));
    expect(result.current.preview?.snapshotToken).toBe('newer');
    await act(async () => older.resolve(importPreview({ snapshotToken: 'older' })));
    expect(result.current.preview?.snapshotToken).toBe('newer');
    expect(result.current.loadingPreview).toBe(false);
  });

  it('aborts preview on reset and never passes an abort signal to commit', async () => {
    const pending = deferred<ImportPreview>();
    let signal: AbortSignal | undefined;
    vi.spyOn(importApi, 'preview')
      .mockImplementationOnce((_projectId, _input, nextSignal) => {
        signal = nextSignal;
        return pending.promise;
      })
      .mockResolvedValueOnce(importPreview());
    const commit = vi.spyOn(importApi, 'commit').mockResolvedValue({
      createdEndpointIds: ['endpoint-1'],
      updatedEndpointIds: [],
      createdVariantIds: ['variant-1'],
      skippedItemIds: [],
    });
    const { result } = renderHook(() => useImportWizard('project-a'));
    act(() => result.current.setCurlText('curl https://api.example.test/users'));
    act(() => { void result.current.previewSource(); });
    act(() => result.current.reset());
    expect(signal?.aborted).toBe(true);

    act(() => result.current.setCurlText('curl https://api.example.test/users'));
    await act(() => result.current.previewSource());
    await act(() => result.current.commit());

    expect(commit).toHaveBeenCalledWith('project-a', expect.objectContaining({
      snapshotToken: 'snapshot-1',
      selectedItemIds: ['create-item'],
      actions: [{ itemId: 'create-item', action: 'create' }],
    }));
    expect(commit.mock.calls[0]).toHaveLength(2);
    expect(result.current.step).toBe('complete');
    expect(result.current.curlText).toBe('');
    expect(result.current.variables).toEqual({});
    expect(result.current.preview).toBeUndefined();
    expect(result.current.choices).toEqual({});
    expect(result.current.discoveredOrigins).toEqual(['https://api.example.test']);
  });

  it('does not publish a late commit settlement into a different Project', async () => {
    const pendingCommit = deferred<{
      createdEndpointIds: string[];
      updatedEndpointIds: string[];
      createdVariantIds: string[];
      skippedItemIds: string[];
    }>();
    vi.spyOn(importApi, 'preview').mockResolvedValue(importPreview());
    vi.spyOn(importApi, 'commit').mockReturnValue(pendingCommit.promise);
    const { result, rerender } = renderHook(
      ({ projectId }) => useImportWizard(projectId),
      { initialProps: { projectId: 'project-a' } },
    );
    act(() => result.current.setCurlText('curl https://api.example.test/users'));
    await act(() => result.current.previewSource());
    let caught: unknown;
    act(() => {
      void result.current.commit().catch(error => { caught = error; });
    });

    rerender({ projectId: 'project-b' });
    await act(async () => pendingCommit.resolve({
      createdEndpointIds: ['endpoint-a'],
      updatedEndpointIds: [],
      createdVariantIds: ['variant-a'],
      skippedItemIds: [],
    }));

    expect(caught).toBeInstanceOf(ImportWizardValidationError);
    expect(result.current.step).toBe('source');
    expect(result.current.result).toBeUndefined();
    expect(result.current.error).toBeUndefined();
  });

  it('rejects commit settlement at the synchronous Project boundary', async () => {
    const pendingCommit = deferred<{
      createdEndpointIds: string[];
      updatedEndpointIds: string[];
      createdVariantIds: string[];
      skippedItemIds: string[];
    }>();
    const committed = {
      createdEndpointIds: ['endpoint-a'],
      updatedEndpointIds: [],
      createdVariantIds: ['variant-a'],
      skippedItemIds: [],
    };
    vi.spyOn(importApi, 'preview').mockResolvedValue(importPreview());
    vi.spyOn(importApi, 'commit').mockReturnValue(pendingCommit.promise);
    const switched = deferred<void>();
    const switchProject = { current: () => {} };
    const { result } = renderHook(() => {
      const [projectId, setProjectId] = useState('project-a');
      const wizard = useImportWizard(projectId);
      useLayoutEffect(() => {
        switchProject.current = () => setProjectId('project-b');
      }, []);
      useLayoutEffect(() => {
        if (projectId === 'project-a') return;
        pendingCommit.resolve(committed);
        switched.resolve();
      }, [projectId]);
      return wizard;
    });
    act(() => result.current.setCurlText('curl https://api.example.test/users'));
    await act(() => result.current.previewSource());
    let settlement: unknown;
    act(() => {
      void result.current.commit().then(
        value => { settlement = value; },
        error => { settlement = error; },
      );
    });

    await runBeforePassiveEffects(async () => {
      switchProject.current();
      await switched.promise;
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(settlement).toBeInstanceOf(ImportWizardValidationError);
    await act(async () => {});
    expect(result.current.step).toBe('source');
    expect(result.current.result).toBeUndefined();
    expect(result.current.error).toBeUndefined();
  });

  it('keeps local validation failures out of the client and ambiguous outcome path', async () => {
    const commit = vi.spyOn(importApi, 'commit');
    const { result } = renderHook(() => useImportWizard('project-a'));

    let caught: unknown;
    await act(async () => {
      try {
        await result.current.commit();
      } catch (error) {
        caught = error;
      }
    });

    expect(caught).toBeInstanceOf(ImportWizardValidationError);
    expect(commit).not.toHaveBeenCalled();
    expect(result.current.error).toBeInstanceOf(ImportWizardValidationError);
    expect(result.current.error).not.toBeInstanceOf(ImportCommitOutcomeUnknownError);
  });

  it('keeps disabled skip-only rows unselected and outside commit construction', async () => {
    const skipOnly = previewItem({
      id: 'disabled-item',
      name: 'Disabled request',
      proposedAction: 'skip',
      allowedActions: ['skip'],
      selectedByDefault: true,
      createEffect: { createsEndpoint: false, createsVariants: 0 },
    });
    vi.spyOn(importApi, 'preview').mockResolvedValue(importPreview({ items: [previewItem(), skipOnly] }));
    const commit = vi.spyOn(importApi, 'commit').mockResolvedValue({
      createdEndpointIds: ['endpoint-1'],
      updatedEndpointIds: [],
      createdVariantIds: ['variant-1'],
      skippedItemIds: [],
    });
    const { result } = renderHook(() => useImportWizard('project-a'));
    act(() => result.current.setCurlText('curl https://api.example.test/users'));
    await act(() => result.current.previewSource());

    expect(result.current.choices['disabled-item']?.selected).toBe(false);
    act(() => result.current.setChoice('disabled-item', { selected: true }));
    expect(result.current.choices['disabled-item']?.selected).toBe(false);
    await act(() => result.current.commit());
    expect(commit).toHaveBeenCalledWith('project-a', expect.objectContaining({
      selectedItemIds: ['create-item'],
    }));
  });

  it('preserves replay data and choices when commit reports a stale preview', async () => {
    vi.spyOn(importApi, 'preview').mockResolvedValue(importPreview());
    vi.spyOn(importApi, 'commit').mockRejectedValue(new ApiClientError(
      409,
      'IMPORT_PREVIEW_STALE',
      'Preview is stale',
      'request-1',
    ));
    const { result } = renderHook(() => useImportWizard('project-a'));
    act(() => result.current.setCurlText('curl https://api.example.test/users'));
    act(() => result.current.setVariable('tenant', 'acme'));
    await act(() => result.current.previewSource());
    const choices = result.current.choices;

    let caught: unknown;
    await act(async () => {
      try {
        await result.current.commit();
      } catch (error) {
        caught = error;
      }
    });

    expect(caught).toMatchObject({ code: 'IMPORT_PREVIEW_STALE' });
    expect(result.current.stale).toBe(true);
    expect(result.current.step).toBe('review');
    expect(result.current.curlText).toContain('api.example.test');
    expect(result.current.variables).toEqual({ tenant: 'acme' });
    expect(result.current.choices).toEqual(choices);
  });

  it('keeps stale data during refresh and clears it only after refreshed data arrives', async () => {
    const stable = previewItem({ id: 'stable-item', name: 'Stable skip' });
    const changed = previewItem({
      id: 'changed-item',
      name: 'Changed conflict',
      overlaps: [{
        endpointId: 'old-overlap',
        baseUrl: 'https://api.example.test',
        matcher: { method: 'GET', path: '/users/*' },
        relativeSpecificity: 'equal',
        confirmationRequired: true,
      }],
    });
    const previewRequest = vi.spyOn(importApi, 'preview').mockResolvedValueOnce(importPreview({
      items: [stable, changed],
    }));
    vi.spyOn(importApi, 'commit').mockRejectedValue(new ApiClientError(
      409,
      'IMPORT_PREVIEW_STALE',
      'Preview is stale',
      'request-1',
    ));
    const { result } = renderHook(() => useImportWizard('project-a'));
    act(() => result.current.setCurlText('curl https://{{tenant}}.example.test/users'));
    act(() => result.current.setVariable('tenant', 'acme'));
    await act(() => result.current.previewSource());
    act(() => result.current.setChoice('stable-item', { selected: false, action: 'skip' }));
    act(() => result.current.setChoice('changed-item', {
      selected: true,
      action: 'create',
      confirmOverlap: true,
    }));
    await act(async () => {
      await expect(result.current.commit()).rejects.toMatchObject({ code: 'IMPORT_PREVIEW_STALE' });
    });
    const stalePreview = result.current.preview;
    const staleChoices = result.current.choices;
    previewRequest.mockRejectedValueOnce(new Error('refresh failed'));

    await act(async () => {
      await expect(result.current.refreshPreview()).rejects.toThrow('refresh failed');
    });
    expect(result.current.stale).toBe(true);
    expect(result.current.preview).toBe(stalePreview);
    expect(result.current.choices).toEqual(staleChoices);

    const refresh = deferred<ImportPreview>();
    previewRequest.mockReturnValueOnce(refresh.promise);

    let refreshPromise!: Promise<void>;
    act(() => {
      refreshPromise = result.current.refreshPreview();
    });

    expect(result.current.loadingPreview).toBe(true);
    expect(result.current.stale).toBe(true);
    expect(result.current.preview).toBe(stalePreview);
    expect(result.current.choices).toEqual(staleChoices);
    expect(previewRequest).toHaveBeenLastCalledWith(
      'project-a',
      {
        source: { type: 'curl', text: 'curl https://{{tenant}}.example.test/users' },
        variables: { tenant: 'acme' },
      },
      expect.any(AbortSignal),
    );

    await act(async () => {
      refresh.resolve(importPreview({
        snapshotToken: 'snapshot-2',
        items: [
          stable,
          {
            ...changed,
            proposedAction: 'merge',
            allowedActions: ['merge', 'skip'],
            exactTargets: [{
              endpointId: 'canonical-target',
              endpointRevision: 2,
              name: 'Canonical users',
              newVariantCount: 1,
              candidateResponses: [],
            }],
            overlaps: [],
            createEffect: { createsEndpoint: false, createsVariants: 0 },
          },
          previewItem({ id: 'added-item', name: 'Added request' }),
        ],
      }));
      await refreshPromise;
    });
    expect(result.current.loadingPreview).toBe(false);
    expect(result.current.stale).toBe(false);
    expect(result.current.preview?.snapshotToken).toBe('snapshot-2');
    expect(result.current.choices).toEqual({
      'stable-item': { selected: false, action: 'skip' },
      'changed-item': { selected: true },
      'added-item': { selected: true, action: 'create', confirmOverlap: false },
    });
  });

  it('wraps an indeterminate commit failure without publishing it as hook error', async () => {
    vi.spyOn(importApi, 'preview').mockResolvedValue(importPreview());
    vi.spyOn(importApi, 'commit').mockRejectedValue(new TypeError('connection closed'));
    const { result } = renderHook(() => useImportWizard('project-a'));
    act(() => result.current.setCurlText('curl https://api.example.test/users'));
    await act(() => result.current.previewSource());

    let caught: unknown;
    await act(async () => {
      try {
        await result.current.commit();
      } catch (error) {
        caught = error;
      }
    });
    expect(caught).toBeInstanceOf(ImportCommitOutcomeUnknownError);
    expect(result.current.error).toBeUndefined();
    expect(result.current.curlText).toBe('');
    expect(result.current.postmanFile).toBeUndefined();
    expect(result.current.variables).toEqual({});
    expect(result.current.preview).toBeDefined();
  });

  it('treats a commit 5xx as indeterminate while retaining documented 4xx as definite', async () => {
    vi.spyOn(importApi, 'preview').mockResolvedValue(importPreview());
    const commit = vi.spyOn(importApi, 'commit');
    const { result } = renderHook(() => useImportWizard('project-a'));
    act(() => result.current.setCurlText('curl https://api.example.test/users'));
    await act(() => result.current.previewSource());
    commit.mockRejectedValueOnce(new ApiClientError(503, 'INTERNAL_ERROR', 'Unavailable', 'request-5xx'));

    await act(async () => {
      await expect(result.current.commit()).rejects.toBeInstanceOf(ImportCommitOutcomeUnknownError);
    });
    expect(result.current.error).toBeUndefined();
  });

  it('preserves a selected Postman file while reporting parse errors inline', async () => {
    const { result } = renderHook(() => useImportWizard('project-a'));
    const file = new File(['not-json'], 'collection.json', { type: 'application/json' });
    Object.defineProperty(file, 'text', { value: () => Promise.resolve('not-json') });

    await act(() => result.current.setPostmanFile(file));

    expect(result.current.postmanFile).toBe(file);
    expect(result.current.error?.message).toMatch(/valid JSON/i);
    expect(result.current.dirty).toBe(true);
  });

  it('does not let an older Postman read replace a newer selected file', async () => {
    const olderText = deferred<string>();
    const older = new File(['{}'], 'older.json', { type: 'application/json' });
    Object.defineProperty(older, 'text', { value: () => olderText.promise });
    const newer = new File(['invalid'], 'newer.json', { type: 'application/json' });
    Object.defineProperty(newer, 'text', { value: () => Promise.resolve('invalid') });
    const preview = vi.spyOn(importApi, 'preview');
    const { result } = renderHook(() => useImportWizard('project-a'));
    let olderRead!: Promise<void>;
    act(() => {
      olderRead = result.current.setPostmanFile(older);
    });
    await act(() => result.current.setPostmanFile(newer));

    await act(async () => {
      olderText.resolve('{}');
      await olderRead;
    });

    expect(result.current.postmanFile).toBe(newer);
    expect(result.current.error?.message).toMatch(/valid JSON/i);
    let caught: unknown;
    await act(async () => {
      try {
        await result.current.previewSource();
      } catch (error) {
        caught = error;
      }
    });
    expect(caught).toBeInstanceOf(ImportWizardValidationError);
    expect(preview).not.toHaveBeenCalled();
  });

  it('reruns Resolve with variables and advances despite persistent item errors', async () => {
    const invalid = previewItem({
      id: 'invalid-item',
      errors: [{ code: 'IMPORT_METHOD_UNSUPPORTED', message: 'TRACE is unsupported' }],
      selectedByDefault: true,
      proposedAction: 'skip',
      allowedActions: ['skip'],
      createEffect: { createsEndpoint: false, createsVariants: 0 },
    });
    vi.spyOn(importApi, 'preview')
      .mockResolvedValueOnce(importPreview({
        items: [invalid],
        unresolvedVariables: [{ name: 'tenant', memberIds: ['member-1'] }],
      }))
      .mockResolvedValueOnce(importPreview({ items: [invalid] }));
    const { result } = renderHook(() => useImportWizard('project-a'));
    act(() => result.current.setCurlText('curl https://{{tenant}}.example.test/users'));
    await act(() => result.current.previewSource());
    expect(result.current.step).toBe('resolve');
    expect(result.current.choices['invalid-item']?.selected).toBe(false);
    act(() => result.current.setVariable('tenant', 'acme'));

    await act(() => result.current.continueFromResolve());

    expect(importApi.preview).toHaveBeenLastCalledWith(
      'project-a',
      expect.objectContaining({ variables: { tenant: 'acme' } }),
      expect.any(AbortSignal),
    );
    expect(result.current.step).toBe('review');
    expect(result.current.choices['invalid-item']?.selected).toBe(false);
  });
});

describe('reconcileImportChoices', () => {
  it('preserves stable actions and clears changed conflicts while adding defaults', () => {
    const stableMerge = previewItem({
      id: 'stableMerge',
      proposedAction: 'merge',
      allowedActions: ['merge', 'skip'],
      exactTargets: [{
        endpointId: 'ep_same', endpointRevision: 1, name: 'Same', newVariantCount: 1,
        candidateResponses: [],
      }],
      createEffect: { createsEndpoint: false, createsVariants: 0 },
    });
    const stableCreate = previewItem({
      id: 'stableCreate',
      overlaps: [{
        endpointId: 'ep_overlap',
        baseUrl: 'https://api.example.test',
        matcher: { method: 'GET', path: '/users/*' },
        relativeSpecificity: 'equal',
        confirmationRequired: true,
      }],
    });
    const changedCreate = previewItem({
      id: 'changedCreate',
      overlaps: [{
        endpointId: 'ep_old',
        baseUrl: 'https://api.example.test',
        matcher: { method: 'GET', path: '/users/*' },
        relativeSpecificity: 'equal',
        confirmationRequired: true,
      }],
    });
    const previous = importPreview({ items: [stableMerge, stableCreate, changedCreate] });
    const refreshed = importPreview({ items: [
      stableMerge,
      stableCreate,
      { ...changedCreate, overlaps: [{
        endpointId: 'ep_new',
        baseUrl: 'https://api.example.test',
        matcher: { method: 'GET', path: '/users/*' },
        relativeSpecificity: 'equal',
        confirmationRequired: true,
      }] },
      previewItem({ id: 'newItem' }),
    ] });

    expect(reconcileImportChoices(previous, refreshed, {
      stableMerge: { selected: true, action: 'merge', endpointId: 'ep_same' },
      stableCreate: { selected: true, action: 'create', confirmOverlap: true },
      changedCreate: { selected: true, action: 'create', confirmOverlap: true },
    })).toEqual({
      stableMerge: { selected: true, action: 'merge', endpointId: 'ep_same' },
      stableCreate: { selected: true, action: 'create', confirmOverlap: true },
      changedCreate: { selected: true },
      newItem: { selected: true, action: 'create', confirmOverlap: false },
    });
  });

  it('uses code-unit conflict signatures, removes old IDs, and unselects invalid new rows', () => {
    const overlaps = ['ä-target', 'z-target'].map(endpointId => ({
      endpointId,
      baseUrl: 'https://api.example.test',
      matcher: { method: 'GET', path: '/users/*' },
      relativeSpecificity: 'equal' as const,
      confirmationRequired: true,
    }));
    const previousItem = previewItem({ id: 'create', overlaps });
    const nextItem = previewItem({ id: 'create', overlaps: [...overlaps].reverse() });
    const invalid = previewItem({
      id: 'invalid',
      errors: [{ code: 'INVALID', message: 'Invalid request' }],
    });
    const localeCompare = vi.spyOn(String.prototype, 'localeCompare')
      .mockImplementation(() => { throw new Error('localeCompare must not be used'); });

    const reconciled = reconcileImportChoices(
      importPreview({ items: [previousItem, previewItem({ id: 'removed' })] }),
      importPreview({ items: [nextItem, invalid] }),
      {
        create: { selected: true, action: 'create', confirmOverlap: true },
        removed: { selected: true, action: 'skip' },
      },
    );
    localeCompare.mockRestore();

    expect(reconciled).toEqual({
      create: { selected: true, action: 'create', confirmOverlap: true },
      invalid: { selected: false, action: 'create', confirmOverlap: false },
    });
  });

  it('clears create when a canonical exact match leaves only merge or skip', () => {
    const previous = previewItem({ id: 'item' });
    const refreshed = previewItem({
      id: 'item',
      proposedAction: 'merge',
      allowedActions: ['merge', 'skip'],
      exactTargets: [{
        endpointId: 'endpoint-1', endpointRevision: 1, name: 'Existing', newVariantCount: 1,
        candidateResponses: [],
      }],
      createEffect: { createsEndpoint: false, createsVariants: 0 },
    });

    expect(reconcileImportChoices(
      importPreview({ items: [previous] }),
      importPreview({ items: [refreshed] }),
      { item: { selected: true, action: 'create', confirmOverlap: true } },
    )).toEqual({ item: { selected: true } });
  });
});
