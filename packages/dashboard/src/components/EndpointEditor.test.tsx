import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLayoutEffect, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiClientError, endpointsApi, variantsApi } from '../api/client';
import type {
  EndpointDeletionImpact,
  EndpointDetail,
  Project,
  VariantDeletionImpact,
} from '../api/types';
import { EndpointEditor } from './EndpointEditor';

vi.mock('../api/client', async importOriginal => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  endpointsApi: { create: vi.fn(), delete: vi.fn(), deletionImpact: vi.fn(), get: vi.fn(), setMode: vi.fn(), update: vi.fn() },
  variantsApi: { create: vi.fn(), delete: vi.fn(), deletionImpact: vi.fn(), update: vi.fn() },
  bodiesApi: { download: vi.fn(), upload: vi.fn() },
}));

const endpoint: EndpointDetail = {
  schemaVersion: 4,
  id: 'ep_1',
  projectId: 'prj_1',
  name: 'Playback',
  baseUrl: 'https://api.example.test',
  matcher: {
    method: 'GET',
    path: '/playback',
    query: { quality: [{ operator: 'equals', value: 'hd' }, { operator: 'glob', value: 'h*' }] },
    headers: { 'x-plan': { operator: 'equals', value: 'paid' } },
  },
  mode: 'mock',
  defaultVariantId: 'var_1',
  variants: [
    {
      id: 'var_1',
      endpointId: 'ep_1',
      name: 'Allowed',
      description: 'Original description',
      status: 503,
      responseHeaders: { 'set-cookie': ['one=1', 'two=2'] },
      bodyAssetId: 'a'.repeat(64),
      delayMs: 250,
      revision: 1,
    },
    { id: 'var_2', endpointId: 'ep_1', name: 'Denied', status: 403, responseHeaders: {}, revision: 2 },
  ],
  revision: 4,
};

const project: Project = {
  schemaVersion: 4,
  id: 'prj_1',
  name: 'Playback project',
  appStateMode: 'disabled',
  revision: 3,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((next, fail) => { resolve = next; reject = fail; });
  return { promise, resolve, reject };
}

describe('EndpointEditor', () => {
  const onEndpointSaveStarted = () => vi.fn(() => true);

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(endpointsApi.get).mockResolvedValue(endpoint);
  });

  function renderEditor(overrides: Partial<React.ComponentProps<typeof EndpointEditor>> = {}) {
    const props: React.ComponentProps<typeof EndpointEditor> = {
      projectId: 'prj_1',
      endpoint,
      onEndpointSaveStarted,
      onSaved: vi.fn(),
      onDeleted: vi.fn(),
      onClose: vi.fn(),
      ...overrides,
    };
    return { ...render(<EndpointEditor {...props} />), props };
  }

  async function openVariantActions() {
    await userEvent.click(screen.getByText('Variant actions'));
  }

  function expectPostCommitMutationLock() {
    expect(screen.getByLabelText('Endpoint name')).toBeDisabled();
    expect(screen.getByLabelText('Variant name')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save Endpoint' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save Variant' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'New Variant' })).toBeDisabled();
    for (const tab of screen.getAllByRole('tab')) expect(tab).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Close' })).toBeEnabled();
  }

  const referencedImpact: VariantDeletionImpact = {
    endpointId: 'ep_1',
    endpointRevision: 7,
    variantId: 'var_2',
    variantRevision: 6,
    isFallback: true,
    affectedStates: [{ id: 'state_1', name: 'Signed out', revision: 3 }],
    replacementVariants: [{ id: 'var_1', name: 'Allowed', revision: 1 }],
  };

  const endpointImpact: EndpointDeletionImpact = {
    endpointId: 'ep_1',
    endpointRevision: 4,
    affectedStates: [
      { id: 'state_1', name: 'Signed out', revision: 3 },
      { id: 'state_2', name: 'Expired session', revision: 6 },
    ],
  };

  it('creates canonical Endpoints with a default Variant', () => {
    render(<EndpointEditor projectId="prj_1" onEndpointSaveStarted={onEndpointSaveStarted} onSaved={vi.fn()} onDeleted={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByLabelText('Endpoint name')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Create Endpoint' })).toBeVisible();
    expect(screen.getByLabelText('Endpoint base URL')).toBeRequired();
    expect(screen.getByText(/origin only/i)).toBeVisible();
  });

  it('preserves repeated query matchers and switches mode without clearing Variants', async () => {
    vi.mocked(endpointsApi.update).mockResolvedValue({ ...endpoint, revision: 5 });
    vi.mocked(endpointsApi.setMode).mockResolvedValue({ ...endpoint, mode: 'passthrough', revision: 6 });
    renderEditor();

    expect(screen.getAllByLabelText('Query name')).toHaveLength(2);
    expect(screen.getAllByLabelText('Query name').map(input => input.getAttribute('value')))
      .toEqual(['quality', 'quality']);
    expect(screen.getAllByLabelText('Header name')).toHaveLength(1);
    expect(screen.getByLabelText('Header name')).toHaveValue('x-plan');

    await userEvent.click(screen.getByRole('button', { name: 'Save Endpoint' }));
    expect(endpointsApi.update).toHaveBeenCalledWith('prj_1', 'ep_1', 4, expect.objectContaining({
      baseUrl: 'https://api.example.test',
      matcher: expect.objectContaining({
        query: { quality: [{ operator: 'equals', value: 'hd' }, { operator: 'glob', value: 'h*' }] },
      }),
    }));

    await userEvent.click(screen.getByRole('button', { name: 'Use passthrough mode' }));
    expect(endpointsApi.setMode).toHaveBeenCalledWith('prj_1', 'ep_1', 'passthrough', 5);
    expect(screen.getAllByRole('tab')).toHaveLength(2);
  });

  it('gives Endpoint mode one owner and preserves dirty matcher drafts on conflict', async () => {
    const pending = deferred<EndpointDetail>();
    vi.mocked(endpointsApi.setMode).mockReturnValue(pending.promise);
    renderEditor();
    await userEvent.clear(screen.getByLabelText('Endpoint path'));
    await userEvent.type(screen.getByLabelText('Endpoint path'), '/dirty-path');

    const toggle = screen.getByRole('button', { name: 'Use passthrough mode' });
    await userEvent.click(toggle);
    await userEvent.click(toggle);
    expect(endpointsApi.setMode).toHaveBeenCalledTimes(1);

    pending.reject(new ApiClientError(
      409, 'REVISION_CONFLICT', 'Endpoint changed', 'req_mode', undefined, { currentRevision: 9 },
    ));
    expect(await screen.findByText('Server revision 9')).toBeVisible();
    expect(screen.getByLabelText('Endpoint path')).toHaveValue('/dirty-path');
  });

  it('reconciles an unknown Endpoint mode outcome through one canonical GET', async () => {
    const canonical = { ...endpoint, mode: 'passthrough' as const, revision: 5 };
    vi.mocked(endpointsApi.setMode).mockRejectedValue(new Error('connection lost'));
    vi.mocked(endpointsApi.get).mockResolvedValue(canonical);
    const onSaved = vi.fn();
    renderEditor({ onSaved });
    await userEvent.clear(screen.getByLabelText('Endpoint name'));
    await userEvent.type(screen.getByLabelText('Endpoint name'), 'Dirty name');

    await userEvent.click(screen.getByRole('button', { name: 'Use passthrough mode' }));

    await waitFor(() => expect(endpointsApi.get).toHaveBeenCalledWith('prj_1', 'ep_1'));
    expect(endpointsApi.setMode).toHaveBeenCalledTimes(1);
    expect(onSaved).toHaveBeenCalledWith(canonical);
    expect(screen.getByLabelText('Endpoint name')).toHaveValue('Dirty name');
  });

  it('owns Endpoint fields separately and guards a dirty Variant transition', async () => {
    const onDirtyChange = vi.fn();
    const onAttemptNavigation = vi.fn();
    render(
      <EndpointEditor
        projectId="prj_1"
        endpoint={endpoint}
        onEndpointSaveStarted={onEndpointSaveStarted}
        onSaved={vi.fn()}
        onDeleted={vi.fn()}
        onClose={vi.fn()}
        onDirtyChange={onDirtyChange}
        onAttemptNavigation={onAttemptNavigation}
      />,
    );

    await userEvent.type(screen.getByLabelText('Endpoint description'), ' local');
    expect(onDirtyChange).toHaveBeenCalledWith(
      'endpoint:prj_1:ep_1:4',
      true,
      expect.any(Function),
    );
    await userEvent.clear(screen.getByLabelText('Variant name'));
    await userEvent.type(screen.getByLabelText('Variant name'), 'Local Allowed');
    await userEvent.click(screen.getByRole('tab', { name: 'Denied' }));
    expect(onAttemptNavigation).toHaveBeenCalledWith(expect.any(Function), [expect.stringContaining('var_1')]);
    expect(screen.getByLabelText('Variant name')).toHaveValue('Local Allowed');
  });

  it('renders every Variant as a tab and marks the canonical Serving now Variant', () => {
    renderEditor();

    const tabs = screen.getAllByRole('tab');
    expect(tabs.map(tab => tab.textContent)).toEqual(['AllowedServing now', 'Denied']);
    expect(within(tabs[0]).getByText('Serving now')).toBeVisible();
    expect(screen.getByText('Endpoint revision 4')).toBeVisible();
  });

  it('associates Variant tabs with their panel and supports roving automatic keyboard activation', async () => {
    const user = userEvent.setup();
    renderEditor();
    const allowed = screen.getByRole('tab', { name: /Allowed/ });
    const denied = screen.getByRole('tab', { name: 'Denied' });
    let panel = screen.getByRole('tabpanel');

    expect(allowed).toHaveAttribute('tabindex', '0');
    expect(denied).toHaveAttribute('tabindex', '-1');
    expect(allowed).toHaveAttribute('aria-controls', panel.id);
    expect(panel).toHaveAttribute('aria-labelledby', allowed.id);

    allowed.focus();
    await user.keyboard('{ArrowRight}');
    expect(denied).toHaveFocus();
    expect(denied).toHaveAttribute('aria-selected', 'true');
    panel = screen.getByRole('tabpanel');
    expect(denied).toHaveAttribute('aria-controls', panel.id);
    expect(panel).toHaveAttribute('aria-labelledby', denied.id);

    await user.keyboard('{ArrowRight}');
    expect(allowed).toHaveFocus();
    await user.keyboard('{End}');
    expect(denied).toHaveFocus();
    await user.keyboard('{Home}');
    expect(allowed).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(denied).toHaveFocus();
  });

  it('builds unique whitespace-free ARIA relationships from ambiguous accepted stable IDs', () => {
    const firstEndpointId = 'ep one-variant-tail';
    const secondEndpointId = 'ep one';
    const firstVariant = {
      ...endpoint.variants[0],
      id: 'var/path',
      endpointId: firstEndpointId,
      name: 'First Variant',
    };
    const secondVariant = {
      ...endpoint.variants[1],
      id: 'tail-variant-var/path',
      endpointId: secondEndpointId,
      name: 'Second Variant',
    };
    render(
      <>
        <EndpointEditor
          projectId="prj_1"
          endpoint={{
            ...endpoint,
            id: firstEndpointId,
            defaultVariantId: firstVariant.id,
            variants: [firstVariant],
          }}
          onEndpointSaveStarted={onEndpointSaveStarted}
          onSaved={vi.fn()}
          onDeleted={vi.fn()}
          onClose={vi.fn()}
        />
        <EndpointEditor
          projectId="prj_1"
          endpoint={{
            ...endpoint,
            id: secondEndpointId,
            defaultVariantId: secondVariant.id,
            variants: [secondVariant],
          }}
          onEndpointSaveStarted={onEndpointSaveStarted}
          onSaved={vi.fn()}
          onDeleted={vi.fn()}
          onClose={vi.fn()}
        />
      </>,
    );

    const tabs = screen.getAllByRole('tab');
    const panels = screen.getAllByRole('tabpanel');
    expect(new Set(tabs.map(tab => tab.id)).size).toBe(tabs.length);
    expect(new Set(panels.map(panel => panel.id)).size).toBe(panels.length);
    for (const tab of tabs) {
      expect(tab.id).not.toMatch(/\s/);
      const panel = document.getElementById(tab.getAttribute('aria-controls')!);
      expect(panel).not.toBeNull();
      expect(panel).toHaveAttribute('aria-labelledby', tab.id);
    }
  });

  it('routes keyboard tab activation and focus through the dirty Variant guard', async () => {
    const user = userEvent.setup();
    const onAttemptNavigation = vi.fn();
    renderEditor({ onAttemptNavigation });
    await user.clear(screen.getByLabelText('Variant name'));
    await user.type(screen.getByLabelText('Variant name'), 'Local Allowed');
    const allowed = screen.getByRole('tab', { name: /Allowed/ });
    const denied = screen.getByRole('tab', { name: 'Denied' });
    allowed.focus();

    await user.keyboard('{ArrowRight}');

    expect(onAttemptNavigation).toHaveBeenCalledWith(expect.any(Function), [expect.stringContaining('var_1')]);
    expect(allowed).toHaveFocus();
    expect(allowed).toHaveAttribute('aria-selected', 'true');
    await act(async () => onAttemptNavigation.mock.calls[0][0]());
    expect(denied).toHaveFocus();
    expect(denied).toHaveAttribute('aria-selected', 'true');
  });

  it('restores the selected tab focus when a guarded pointer selection is cancelled', async () => {
    const user = userEvent.setup();
    const onAttemptNavigation = vi.fn();
    renderEditor({ onAttemptNavigation });
    await user.clear(screen.getByLabelText('Variant name'));
    await user.type(screen.getByLabelText('Variant name'), 'Local Allowed');
    const allowed = screen.getByRole('tab', { name: /Allowed/ });
    const denied = screen.getByRole('tab', { name: 'Denied' });

    await user.click(denied);

    expect(allowed).toHaveFocus();
    expect(allowed).toHaveAttribute('aria-selected', 'true');
    expect(allowed).toHaveAttribute('tabindex', '0');
    expect(denied).toHaveAttribute('tabindex', '-1');

    await user.keyboard('{ArrowRight}');
    expect(onAttemptNavigation).toHaveBeenCalledTimes(2);
    await act(async () => onAttemptNavigation.mock.calls[1][0]());
    expect(denied).toHaveFocus();
    expect(denied).toHaveAttribute('aria-selected', 'true');
  });

  it('keeps a committed Variant create closed and retries only its failed canonical reload', async () => {
    const created = { id: 'var_3', endpointId: 'ep_1', name: 'Created', status: 200, responseHeaders: {}, revision: 1 };
    const refreshed = { ...endpoint, variants: [...endpoint.variants, created], revision: 5 };
    vi.mocked(variantsApi.create).mockResolvedValue(created);
    vi.mocked(endpointsApi.get)
      .mockRejectedValueOnce(new Error('Reload unavailable'))
      .mockResolvedValueOnce(refreshed);
    renderEditor();
    await userEvent.click(screen.getByRole('button', { name: 'New Variant' }));
    await userEvent.type(screen.getByLabelText('New Variant name'), 'Created');
    await userEvent.click(screen.getByRole('button', { name: 'Create Variant' }));

    expect(await screen.findByText('Change saved, refresh failed')).toBeVisible();
    expect(screen.queryByRole('dialog', { name: 'New Variant' })).not.toBeInTheDocument();
    expectPostCommitMutationLock();
    await userEvent.click(screen.getByRole('button', { name: 'Refresh saved changes' }));

    expect(await screen.findByText('Endpoint revision 5')).toBeVisible();
    expect(variantsApi.create).toHaveBeenCalledOnce();
    expect(endpointsApi.get).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('Change saved, refresh failed')).not.toBeInTheDocument();
  });

  it('creates the first passthrough Variant and recovers the Endpoint to mock readiness', async () => {
    const emptyEndpoint: EndpointDetail = {
      ...endpoint,
      mode: 'passthrough',
      defaultVariantId: undefined,
      variants: [],
    };
    const created = {
      id: 'var_first', endpointId: endpoint.id, name: 'First response',
      status: 200, responseHeaders: {}, revision: 0,
    };
    const ready: EndpointDetail = {
      ...emptyEndpoint, variants: [created], defaultVariantId: created.id, revision: 5,
    };
    vi.mocked(variantsApi.create).mockResolvedValue(created);
    vi.mocked(endpointsApi.get).mockResolvedValue(ready);
    vi.mocked(endpointsApi.setMode).mockResolvedValue({ ...ready, mode: 'mock', revision: 6 });
    renderEditor({ endpoint: emptyEndpoint });

    expect(screen.getByText(/Mock not ready/)).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'New Variant' }));
    await userEvent.type(screen.getByLabelText('New Variant name'), created.name);
    await userEvent.click(screen.getByRole('button', { name: 'Create Variant' }));

    expect(variantsApi.create).toHaveBeenCalledWith('prj_1', 'ep_1', 4, {
      name: created.name, status: 200, responseHeaders: {},
    });
    expect(await screen.findByLabelText('Variant name')).toHaveValue(created.name);
    expect(screen.getByText('Serving now')).toBeVisible();
    expect(endpointsApi.update).not.toHaveBeenCalled();
    expect(await screen.findByText('Endpoint revision 5')).toBeVisible();
    expect(screen.queryByText(/Mock not ready/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Use mock mode' }));
    expect(endpointsApi.setMode).toHaveBeenCalledWith('prj_1', 'ep_1', 'mock', 5);
  });

  it('does not repeat a committed Serving now mutation when canonical reload is retried', async () => {
    const refreshed = { ...endpoint, defaultVariantId: 'var_2', revision: 5 };
    vi.mocked(endpointsApi.update).mockResolvedValue(refreshed);
    vi.mocked(endpointsApi.get)
      .mockRejectedValueOnce(new Error('Reload unavailable'))
      .mockResolvedValueOnce(refreshed);
    renderEditor();
    await userEvent.click(screen.getByRole('tab', { name: 'Denied' }));
    await openVariantActions();
    await userEvent.click(screen.getByRole('button', { name: 'Set as Serving now' }));

    expect(await screen.findByText('Change saved, refresh failed')).toBeVisible();
    expectPostCommitMutationLock();
    await userEvent.click(screen.getByRole('button', { name: 'Refresh saved changes' }));

    expect(await screen.findByText('Endpoint revision 5')).toBeVisible();
    expect(endpointsApi.update).toHaveBeenCalledOnce();
    expect(endpointsApi.get).toHaveBeenCalledTimes(2);
  });

  it('keeps a committed Variant delete closed and retries only its failed canonical reload', async () => {
    const impact = { ...referencedImpact, isFallback: false, affectedStates: [], replacementVariants: [] };
    const refreshed = { ...endpoint, variants: [endpoint.variants[0]], revision: 5 };
    vi.mocked(variantsApi.deletionImpact).mockResolvedValue(impact);
    vi.mocked(variantsApi.delete).mockResolvedValue(undefined);
    vi.mocked(endpointsApi.get)
      .mockRejectedValueOnce(new Error('Reload unavailable'))
      .mockResolvedValueOnce(refreshed);
    renderEditor();
    await userEvent.click(screen.getByRole('tab', { name: 'Denied' }));
    await openVariantActions();
    await userEvent.click(screen.getByRole('button', { name: 'Delete Variant' }));
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Delete Denied' }))
      .getByRole('button', { name: 'Delete Variant' }));

    expect(await screen.findByText('Change saved, refresh failed')).toBeVisible();
    expect(screen.queryByRole('dialog', { name: 'Delete Denied' })).not.toBeInTheDocument();
    expectPostCommitMutationLock();
    await userEvent.click(screen.getByRole('button', { name: 'Refresh saved changes' }));

    expect(await screen.findByText('Endpoint revision 5')).toBeVisible();
    expect(variantsApi.delete).toHaveBeenCalledOnce();
    expect(endpointsApi.get).toHaveBeenCalledTimes(2);
  });

  it('treats Variant update as committed when only its canonical reload fails', async () => {
    const savedVariant = { ...endpoint.variants[0], name: 'Saved Variant', revision: 2 };
    const refreshed: EndpointDetail = {
      ...endpoint,
      name: 'Canonical Endpoint',
      description: 'Canonical description',
      baseUrl: 'https://canonical.example.test',
      matcher: { method: 'POST', path: '/canonical' },
      variants: [savedVariant, endpoint.variants[1]],
      revision: 5,
    };
    vi.mocked(variantsApi.update).mockResolvedValue(savedVariant);
    vi.mocked(endpointsApi.get)
      .mockRejectedValueOnce(new Error('Reload unavailable'))
      .mockResolvedValueOnce(refreshed);
    const onDirtyChange = vi.fn();
    renderEditor({ onDirtyChange });
    await userEvent.clear(screen.getByLabelText('Variant name'));
    await userEvent.type(screen.getByLabelText('Variant name'), 'Saved Variant');
    await userEvent.click(screen.getByRole('button', { name: 'Save Variant' }));

    expect(await screen.findByText('Change saved, refresh failed')).toBeVisible();
    expect(screen.queryByText('Reload unavailable')).not.toBeInTheDocument();
    expect(onDirtyChange).toHaveBeenCalledWith(expect.stringContaining('var_1'), false, undefined);
    expectPostCommitMutationLock();
    await userEvent.click(screen.getByRole('button', { name: 'Refresh saved changes' }));

    expect(await screen.findByText('Endpoint revision 5')).toBeVisible();
    expect(screen.getByLabelText('Endpoint name')).toHaveValue('Canonical Endpoint');
    expect(screen.getByLabelText('Endpoint description')).toHaveValue('Canonical description');
    expect(variantsApi.update).toHaveBeenCalledOnce();
    expect(endpointsApi.get).toHaveBeenCalledTimes(2);
  });

  it('preserves a sibling Endpoint draft through Variant post-commit recovery', async () => {
    const savedVariant = { ...endpoint.variants[0], name: 'Saved Variant', revision: 2 };
    const refreshed: EndpointDetail = {
      ...endpoint,
      name: 'External Endpoint',
      description: 'External description',
      defaultVariantId: 'var_2',
      variants: [endpoint.variants[1], savedVariant],
      revision: 8,
    };
    vi.mocked(variantsApi.update).mockResolvedValue(savedVariant);
    vi.mocked(endpointsApi.get)
      .mockRejectedValueOnce(new Error('Reload unavailable'))
      .mockResolvedValueOnce(refreshed);
    const onSaved = vi.fn();
    renderEditor({ onSaved });
    await userEvent.type(screen.getByLabelText('Endpoint description'), 'Local Endpoint draft');
    await userEvent.clear(screen.getByLabelText('Variant name'));
    await userEvent.type(screen.getByLabelText('Variant name'), 'Saved Variant');

    await userEvent.click(screen.getByRole('button', { name: 'Save Variant' }));
    await screen.findByText('Change saved, refresh failed');
    await userEvent.click(screen.getByRole('button', { name: 'Refresh saved changes' }));

    expect(await screen.findByText('Endpoint revision 8')).toBeVisible();
    expect(screen.getByLabelText('Endpoint name')).toHaveValue('Playback');
    expect(screen.getByLabelText('Endpoint description')).toHaveValue('Local Endpoint draft');
    expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual([
      'DeniedServing now',
      'Saved Variant',
    ]);
    expect(onSaved).toHaveBeenCalledWith(refreshed);
    expect(variantsApi.update).toHaveBeenCalledOnce();
    expect(endpointsApi.get).toHaveBeenCalledTimes(2);
  });

  it('locks a mounted editor when committed canonical GET publication is rejected', async () => {
    const savedVariant = { ...endpoint.variants[0], name: 'Saved Variant', revision: 2 };
    const rejectedDetail = { ...endpoint, variants: [savedVariant, endpoint.variants[1]], revision: 5 };
    const recoveredDetail = { ...rejectedDetail, revision: 6 };
    vi.mocked(variantsApi.update).mockResolvedValue(savedVariant);
    vi.mocked(endpointsApi.get)
      .mockResolvedValueOnce(rejectedDetail)
      .mockResolvedValueOnce(recoveredDetail);
    const rejectedPublication = vi.fn(() => false);
    const recoveryPublication = vi.fn(() => true);
    const onEndpointSaveStarted = vi.fn()
      .mockReturnValueOnce(rejectedPublication)
      .mockReturnValueOnce(recoveryPublication);
    const onSaved = vi.fn();
    renderEditor({ onEndpointSaveStarted, onSaved });
    await userEvent.clear(screen.getByLabelText('Variant name'));
    await userEvent.type(screen.getByLabelText('Variant name'), 'Saved Variant');

    await userEvent.click(screen.getByRole('button', { name: 'Save Variant' }));

    expect(await screen.findByText('Change saved, refresh failed')).toBeVisible();
    expect(rejectedPublication).toHaveBeenCalledWith(rejectedDetail);
    expect(onSaved).not.toHaveBeenCalled();
    expectPostCommitMutationLock();
    await userEvent.click(screen.getByRole('button', { name: 'Refresh saved changes' }));

    expect(await screen.findByText('Endpoint revision 6')).toBeVisible();
    expect(recoveryPublication).toHaveBeenCalledWith(recoveredDetail);
    expect(onSaved).toHaveBeenCalledWith(recoveredDetail);
    expect(variantsApi.update).toHaveBeenCalledOnce();
    expect(endpointsApi.get).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('Change saved, refresh failed')).not.toBeInTheDocument();
  });

  it('does not recover or publish after navigation unmounts the rejected mutation owner', async () => {
    const pendingReload = deferred<EndpointDetail>();
    const savedVariant = { ...endpoint.variants[0], name: 'Saved Variant', revision: 2 };
    const refreshed = { ...endpoint, variants: [savedVariant, endpoint.variants[1]], revision: 5 };
    vi.mocked(variantsApi.update).mockResolvedValue(savedVariant);
    vi.mocked(endpointsApi.get).mockReturnValue(pendingReload.promise);
    const rejectedPublication = vi.fn(() => false);
    const onSaved = vi.fn();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const view = renderEditor({ onEndpointSaveStarted: () => rejectedPublication, onSaved });
    await userEvent.clear(screen.getByLabelText('Variant name'));
    await userEvent.type(screen.getByLabelText('Variant name'), 'Saved Variant');
    await userEvent.click(screen.getByRole('button', { name: 'Save Variant' }));
    await waitFor(() => expect(endpointsApi.get).toHaveBeenCalledOnce());

    view.unmount();
    await act(async () => pendingReload.resolve(refreshed));

    const consoleErrors = [...consoleError.mock.calls];
    consoleError.mockRestore();
    expect(rejectedPublication).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    expect(consoleErrors).toHaveLength(0);
  });

  it('does not publish a committed canonical reload after Close unmounts its accepting owner', async () => {
    const pendingReload = deferred<EndpointDetail>();
    const savedVariant = { ...endpoint.variants[0], name: 'Saved Variant', revision: 2 };
    const refreshed = { ...endpoint, variants: [savedVariant, endpoint.variants[1]], revision: 5 };
    vi.mocked(variantsApi.update).mockResolvedValue(savedVariant);
    vi.mocked(endpointsApi.get).mockReturnValue(pendingReload.promise);
    const completePublication = vi.fn<(canonical: EndpointDetail) => boolean>(() => true);
    const onSaved = vi.fn();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    function CloseHarness() {
      const [open, setOpen] = useState(true);
      const [parentEndpoint, setParentEndpoint] = useState(endpoint);
      return (
        <>
          {open ? (
            <EndpointEditor
              projectId="prj_1"
              endpoint={parentEndpoint}
              onEndpointSaveStarted={() => canonical => {
                const accepted = completePublication(canonical);
                if (accepted) setParentEndpoint(canonical);
                return accepted;
              }}
              onSaved={canonical => {
                onSaved(canonical);
                setParentEndpoint(canonical);
              }}
              onDeleted={vi.fn()}
              onClose={() => setOpen(false)}
            />
          ) : (
            <button type="button" onClick={() => setOpen(true)}>Reopen Endpoint</button>
          )}
        </>
      );
    }

    render(<CloseHarness />);
    await userEvent.clear(screen.getByLabelText('Variant name'));
    await userEvent.type(screen.getByLabelText('Variant name'), 'Saved Variant');
    await userEvent.click(screen.getByRole('button', { name: 'Save Variant' }));
    await waitFor(() => expect(endpointsApi.get).toHaveBeenCalledOnce());
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));

    await act(async () => pendingReload.resolve(refreshed));

    const consoleErrors = [...consoleError.mock.calls];
    consoleError.mockRestore();
    expect(completePublication).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    expect(consoleErrors).toHaveLength(0);
    expect(screen.queryByText('Change saved, refresh failed')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Reopen Endpoint' }));
    expect(screen.getByText('Endpoint revision 4')).toBeVisible();
    expect(screen.getByLabelText('Variant name')).toHaveValue('Allowed');
    expect(screen.queryByText('Change saved, refresh failed')).not.toBeInTheDocument();
  });

  it('revokes canonical publication before parent layout work resolves GET after removal', async () => {
    const pendingReload = deferred<EndpointDetail>();
    const savedVariant = { ...endpoint.variants[0], name: 'Saved Variant', revision: 2 };
    const refreshed = { ...endpoint, variants: [savedVariant, endpoint.variants[1]], revision: 5 };
    vi.mocked(variantsApi.update).mockResolvedValue(savedVariant);
    vi.mocked(endpointsApi.get).mockReturnValue(pendingReload.promise);
    const completePublication = vi.fn(() => true);
    const onSaved = vi.fn();

    function LayoutResolutionHarness() {
      const [open, setOpen] = useState(true);
      useLayoutEffect(() => {
        const removeEditor = () => setOpen(false);
        window.addEventListener('mockmate-remove-endpoint-editor', removeEditor);
        return () => window.removeEventListener('mockmate-remove-endpoint-editor', removeEditor);
      }, []);
      useLayoutEffect(() => {
        if (!open) pendingReload.resolve(refreshed);
      }, [open]);
      return open ? (
        <EndpointEditor
          projectId="prj_1"
          endpoint={endpoint}
          onEndpointSaveStarted={() => completePublication}
          onSaved={onSaved}
          onDeleted={vi.fn()}
          onClose={() => setOpen(false)}
        />
      ) : <p>Editor removed</p>;
    }

    render(<LayoutResolutionHarness />);
    await userEvent.clear(screen.getByLabelText('Variant name'));
    await userEvent.type(screen.getByLabelText('Variant name'), 'Saved Variant');
    await userEvent.click(screen.getByRole('button', { name: 'Save Variant' }));
    await waitFor(() => expect(endpointsApi.get).toHaveBeenCalledOnce());

    const endpointName = screen.getByLabelText('Endpoint name');
    const removed = new Promise<void>(resolve => {
      const observer = new MutationObserver(() => {
        if (endpointName.isConnected) return;
        observer.disconnect();
        resolve();
      });
      observer.observe(document.body, { childList: true, subtree: true });
    });
    const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
    window.dispatchEvent(new Event('mockmate-remove-endpoint-editor'));
    await removed;
    await Promise.resolve();
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;

    expect(await screen.findByText('Editor removed')).toBeVisible();
    expect(completePublication).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('does not publish or clear recovery when its Refresh loses publication ownership', async () => {
    const pendingRefresh = deferred<EndpointDetail>();
    const savedVariant = { ...endpoint.variants[0], name: 'Saved Variant', revision: 2 };
    const refreshed = { ...endpoint, variants: [savedVariant, endpoint.variants[1]], revision: 5 };
    vi.mocked(variantsApi.update).mockResolvedValue(savedVariant);
    vi.mocked(endpointsApi.get)
      .mockRejectedValueOnce(new Error('Reload unavailable'))
      .mockReturnValueOnce(pendingRefresh.promise);
    const mutationPublication = vi.fn(() => true);
    const recoveryPublication = vi.fn(() => false);
    const onEndpointSaveStarted = vi.fn()
      .mockReturnValueOnce(mutationPublication)
      .mockReturnValueOnce(recoveryPublication);
    const onSaved = vi.fn();
    renderEditor({ onEndpointSaveStarted, onSaved });
    await userEvent.clear(screen.getByLabelText('Variant name'));
    await userEvent.type(screen.getByLabelText('Variant name'), 'Saved Variant');
    await userEvent.click(screen.getByRole('button', { name: 'Save Variant' }));
    await screen.findByText('Change saved, refresh failed');

    await userEvent.click(screen.getByRole('button', { name: 'Refresh saved changes' }));
    await act(async () => pendingRefresh.resolve(refreshed));

    expect(recoveryPublication).toHaveBeenCalledWith(refreshed);
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.getByText('Endpoint revision 4')).toBeVisible();
    expect(screen.getByText('Change saved, refresh failed')).toBeVisible();
    expectPostCommitMutationLock();
  });

  it('clones the selected Variant and reloads canonical revision and order', async () => {
    const created = {
      id: 'var_3', endpointId: 'ep_1', name: 'Copied failure', status: 503,
      responseHeaders: {}, revision: 1,
    };
    const refreshed: EndpointDetail = {
      ...endpoint,
      variants: [endpoint.variants[1], created, endpoint.variants[0]],
      revision: 8,
    };
    vi.mocked(variantsApi.create).mockResolvedValue(created);
    vi.mocked(endpointsApi.get).mockResolvedValue(refreshed);
    const onSaved = vi.fn();
    renderEditor({ onSaved });

    await userEvent.click(screen.getByRole('button', { name: 'New Variant' }));
    expect(screen.getByRole('radio', { name: 'Clone selected Variant' })).toBeChecked();
    await userEvent.type(screen.getByLabelText('New Variant name'), 'Copied failure');
    await userEvent.click(screen.getByRole('button', { name: 'Create Variant' }));

    const bodyAssetId = 'a'.repeat(64);
    expect(variantsApi.create).toHaveBeenCalledWith('prj_1', 'ep_1', 4, {
      name: 'Copied failure',
      description: 'Original description',
      status: 503,
      responseHeaders: { 'set-cookie': ['one=1', 'two=2'] },
      bodyAssetId,
      delayMs: 250,
    });
    const cloneInput = vi.mocked(variantsApi.create).mock.calls[0][3];
    expect(cloneInput.responseHeaders).not.toBe(endpoint.variants[0].responseHeaders);
    expect(cloneInput.responseHeaders['set-cookie']).not.toBe(endpoint.variants[0].responseHeaders['set-cookie']);
    expect(endpointsApi.get).toHaveBeenCalledWith('prj_1', 'ep_1');
    expect(await screen.findByText('Endpoint revision 8')).toBeVisible();
    expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['Denied', 'Copied failure', 'AllowedServing now']);
    expect(screen.getByLabelText('Variant name')).toHaveValue('Copied failure');
    expect(onSaved).toHaveBeenCalledWith(refreshed);
  });

  it('creates a blank Variant without optional fields and reloads canonical detail', async () => {
    const created = { id: 'var_3', endpointId: 'ep_1', name: 'Empty', status: 200, responseHeaders: {}, revision: 1 };
    const refreshed = { ...endpoint, variants: [...endpoint.variants, created], revision: 5 };
    vi.mocked(variantsApi.create).mockResolvedValue(created);
    vi.mocked(endpointsApi.get).mockResolvedValue(refreshed);
    renderEditor();

    await userEvent.click(screen.getByRole('button', { name: 'New Variant' }));
    await userEvent.type(screen.getByLabelText('New Variant name'), 'Empty');
    await userEvent.click(screen.getByRole('radio', { name: 'Blank Variant' }));
    await userEvent.click(screen.getByRole('button', { name: 'Create Variant' }));

    expect(variantsApi.create).toHaveBeenCalledWith('prj_1', 'ep_1', 4, {
      name: 'Empty', status: 200, responseHeaders: {},
    });
    expect(endpointsApi.get).toHaveBeenCalledWith('prj_1', 'ep_1');
    expect(await screen.findByText('Endpoint revision 5')).toBeVisible();
  });

  it('sets Serving now with the current revision and publishes canonical detail', async () => {
    const refreshed = {
      ...endpoint,
      defaultVariantId: 'var_2',
      variants: [endpoint.variants[1], endpoint.variants[0]],
      revision: 9,
    };
    vi.mocked(endpointsApi.update).mockResolvedValue({ ...endpoint, defaultVariantId: 'var_2', revision: 5 });
    vi.mocked(endpointsApi.get).mockResolvedValue(refreshed);
    renderEditor();

    await userEvent.click(screen.getByRole('tab', { name: 'Denied' }));
    await openVariantActions();
    await userEvent.click(screen.getByRole('button', { name: 'Set as Serving now' }));

    expect(endpointsApi.update).toHaveBeenCalledWith('prj_1', 'ep_1', 4, { defaultVariantId: 'var_2' });
    expect(endpointsApi.get).toHaveBeenCalledWith('prj_1', 'ep_1');
    expect(await screen.findByText('Endpoint revision 9')).toBeVisible();
    expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['DeniedServing now', 'Allowed']);
  });

  it.each([
    ['App States are disabled', { appStateMode: 'disabled', activeStateId: 'state_1' }],
    ['no App State is active', { appStateMode: 'enabled', activeStateId: undefined }],
  ] as const)('keeps Serving now editable while %s', async (_label, selection) => {
    renderEditor({ project: { ...project, ...selection } });

    await userEvent.click(screen.getByRole('tab', { name: 'Denied' }));
    await openVariantActions();

    const action = screen.getByRole('button', { name: 'Set as Serving now' });
    expect(action).toBeEnabled();
    expect(action).not.toHaveAttribute('title');
  });

  it('disables Serving now while an active App State drives the mocks', async () => {
    renderEditor({ project: { ...project, appStateMode: 'enabled', activeStateId: 'state_1' } });

    await userEvent.click(screen.getByRole('tab', { name: 'Denied' }));
    await openVariantActions();

    const action = screen.getByRole('button', { name: 'Set as Serving now' });
    expect(action).toBeDisabled();
    expect(action).toHaveAttribute('title', 'Disable App States to change Serving now');
    expect(screen.getByRole('tab', { name: 'Denied' })).toBeEnabled();

    await userEvent.click(action);
    expect(endpointsApi.update).not.toHaveBeenCalled();
  });

  it('blocks deletion of a referenced fallback without offering binding rewrites', async () => {
    vi.mocked(variantsApi.deletionImpact).mockResolvedValue(referencedImpact);
    renderEditor();

    await userEvent.click(screen.getByRole('tab', { name: 'Denied' }));
    await openVariantActions();
    await userEvent.click(screen.getByRole('button', { name: 'Delete Variant' }));
    expect(variantsApi.deletionImpact).toHaveBeenCalledWith('prj_1', 'ep_1', 'var_2');
    const dialog = screen.getByRole('dialog', { name: 'Delete Denied' });
    expect(within(dialog).getByText(/remove the App State bindings before deleting/i)).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Delete Variant' })).toBeDisabled();
    expect(variantsApi.delete).not.toHaveBeenCalled();
  });

  it('deletes an unreferenced non-fallback without replacement options', async () => {
    const impact = {
      ...referencedImpact,
      isFallback: false,
      affectedStates: [],
      replacementVariants: [],
    };
    vi.mocked(variantsApi.deletionImpact).mockResolvedValue(impact);
    vi.mocked(variantsApi.delete).mockResolvedValue(undefined);
    vi.mocked(endpointsApi.get).mockResolvedValue({ ...endpoint, variants: [endpoint.variants[0]], revision: 8 });
    renderEditor();

    await userEvent.click(screen.getByRole('tab', { name: 'Denied' }));
    await openVariantActions();
    await userEvent.click(screen.getByRole('button', { name: 'Delete Variant' }));

    expect(screen.queryByLabelText('Replacement Variant')).not.toBeInTheDocument();
    const dialog = screen.getByRole('dialog', { name: 'Delete Denied' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete Variant' }));
    expect(variantsApi.delete).toHaveBeenCalledWith('prj_1', 'ep_1', 'var_2', 6);
    expect(endpointsApi.get).toHaveBeenCalledWith('prj_1', 'ep_1');
  });

  it('discloses every affected App State and deletes with the impact revision', async () => {
    vi.mocked(endpointsApi.deletionImpact).mockResolvedValue(endpointImpact);
    vi.mocked(endpointsApi.delete).mockResolvedValue(undefined);
    const onDeleted = vi.fn();
    renderEditor({ onDeleted });

    await userEvent.click(screen.getByText('Endpoint actions'));
    await userEvent.click(screen.getByRole('button', { name: 'Delete Endpoint' }));

    expect(endpointsApi.deletionImpact).toHaveBeenCalledWith('prj_1', 'ep_1');
    const dialog = await screen.findByRole('dialog', { name: 'Delete Endpoint' });
    expect(within(dialog).getByText(/Affected App States \(2\):/).textContent).toBe(
      'Delete "Playback"? This cannot be undone.\n\nAffected App States (2):\nSigned out\nExpired session',
    );

    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete Endpoint' }));
    expect(endpointsApi.delete).toHaveBeenCalledWith('prj_1', 'ep_1', 4);
    expect(onDeleted).toHaveBeenCalledWith('ep_1');
  });

  it('guards Endpoint deletion with Endpoint and Variant draft keys', async () => {
    const onAttemptNavigation = vi.fn();
    renderEditor({ onAttemptNavigation });
    await userEvent.type(screen.getByLabelText('Endpoint description'), ' local');
    await userEvent.clear(screen.getByLabelText('Variant name'));
    await userEvent.type(screen.getByLabelText('Variant name'), 'Local Allowed');

    await userEvent.click(screen.getByText('Endpoint actions'));
    await userEvent.click(screen.getByRole('button', { name: 'Delete Endpoint' }));

    expect(onAttemptNavigation).toHaveBeenCalledWith(expect.any(Function), [
      'endpoint:prj_1:ep_1:4',
      expect.stringContaining('var_1'),
    ]);
    expect(endpointsApi.deletionImpact).not.toHaveBeenCalled();
  });

  it('preserves the Endpoint deletion dialog and drafts on conflict', async () => {
    vi.mocked(endpointsApi.deletionImpact).mockResolvedValue(endpointImpact);
    vi.mocked(endpointsApi.delete).mockRejectedValue(new ApiClientError(
      409, 'REVISION_CONFLICT', 'Endpoint changed', 'req_1', undefined, { currentRevision: 11 },
    ));
    renderEditor();
    await userEvent.type(screen.getByLabelText('Endpoint description'), ' local');
    await userEvent.click(screen.getByText('Endpoint actions'));
    await userEvent.click(screen.getByRole('button', { name: 'Delete Endpoint' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete Endpoint' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete Endpoint' }));

    expect(await screen.findByRole('dialog', { name: 'Delete Endpoint' })).toBeVisible();
    expect(within(dialog).getByText('Server revision 11')).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Refresh Endpoint' })).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Delete Endpoint' })).toBeDisabled();
    expect(screen.getByLabelText('Endpoint description')).toHaveValue(' local');
    expect(within(dialog).getByText(/Signed out/)).toBeVisible();
  });

  it('closes Endpoint deletion conflict recovery before using the guarded canonical refresh', async () => {
    const onAttemptNavigation = vi.fn()
      .mockImplementationOnce((action: () => void) => action());
    vi.mocked(endpointsApi.deletionImpact).mockResolvedValue(endpointImpact);
    vi.mocked(endpointsApi.delete).mockRejectedValue(new ApiClientError(
      409, 'REVISION_CONFLICT', 'Endpoint changed', 'req_1', undefined, { currentRevision: 11 },
    ));
    renderEditor({ onAttemptNavigation });
    await userEvent.type(screen.getByLabelText('Endpoint description'), ' local');
    await userEvent.click(screen.getByText('Endpoint actions'));
    await userEvent.click(screen.getByRole('button', { name: 'Delete Endpoint' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete Endpoint' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete Endpoint' }));

    await userEvent.click(within(dialog).getByRole('button', { name: 'Refresh Endpoint' }));

    expect(screen.queryByRole('dialog', { name: 'Delete Endpoint' })).not.toBeInTheDocument();
    expect(onAttemptNavigation).toHaveBeenCalledTimes(2);
    expect(onAttemptNavigation).toHaveBeenLastCalledWith(expect.any(Function), [
      'endpoint:prj_1:ep_1:4',
    ]);
    expect(endpointsApi.get).not.toHaveBeenCalled();
    await act(async () => onAttemptNavigation.mock.calls[1][0]());
    expect(endpointsApi.get).toHaveBeenCalledWith('prj_1', 'ep_1');
  });

  it('disables deletion of the last mock Variant with the required explanation', async () => {
    renderEditor({ endpoint: { ...endpoint, variants: [endpoint.variants[0]] } });
    await openVariantActions();

    expect(screen.getByRole('button', { name: 'Delete Variant' })).toBeDisabled();
    expect(screen.getByText('Mock Endpoints require a Serving now response')).toBeVisible();
  });

  it('deletes the last unreferenced passthrough Variant without a replacement', async () => {
    const passthrough = {
      ...endpoint, mode: 'passthrough' as const, variants: [endpoint.variants[0]],
    };
    const impact: VariantDeletionImpact = {
      endpointId: endpoint.id,
      endpointRevision: endpoint.revision,
      variantId: endpoint.variants[0].id,
      variantRevision: endpoint.variants[0].revision,
      isFallback: true,
      affectedStates: [],
      replacementVariants: [],
    };
    vi.mocked(variantsApi.deletionImpact).mockResolvedValue(impact);
    vi.mocked(variantsApi.delete).mockResolvedValue(undefined);
    vi.mocked(endpointsApi.get).mockResolvedValue({
      ...passthrough, defaultVariantId: undefined, variants: [], revision: 5,
    });
    renderEditor({ endpoint: passthrough });
    await openVariantActions();

    await userEvent.click(screen.getByRole('button', { name: 'Delete Variant' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete Allowed' });
    expect(within(dialog).queryByLabelText('Replacement Variant')).not.toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete Variant' }));

    expect(variantsApi.delete).toHaveBeenCalledWith('prj_1', 'ep_1', 'var_1', 1);
    expect(await screen.findByText(/Mock not ready/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'New Variant' })).toBeEnabled();
  });

  it('guards create, clone, Serving now, and delete with all dirty draft keys', async () => {
    const onAttemptNavigation = vi.fn();
    vi.mocked(variantsApi.deletionImpact).mockResolvedValue(referencedImpact);
    renderEditor({ onAttemptNavigation });
    await userEvent.click(screen.getByRole('tab', { name: 'Denied' }));
    await userEvent.type(screen.getByLabelText('Endpoint description'), ' local');
    await userEvent.clear(screen.getByLabelText('Variant name'));
    await userEvent.type(screen.getByLabelText('Variant name'), 'Local Denied');
    const endpointKey = 'endpoint:prj_1:ep_1:4';
    const variantKey = expect.stringContaining('var_2');

    await userEvent.click(screen.getByRole('button', { name: 'New Variant' }));
    await openVariantActions();
    await userEvent.click(screen.getByRole('button', { name: 'Clone Variant' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete Variant' }));
    await userEvent.click(screen.getByRole('button', { name: 'Set as Serving now' }));

    expect(onAttemptNavigation).toHaveBeenCalledTimes(4);
    for (const [, keys] of onAttemptNavigation.mock.calls) {
      expect(keys).toEqual([endpointKey, variantKey]);
    }
    expect(variantsApi.deletionImpact).not.toHaveBeenCalled();
    expect(endpointsApi.update).not.toHaveBeenCalled();
  });

  it('preserves the creation dialog and Endpoint and Variant drafts on conflict', async () => {
    vi.mocked(variantsApi.create).mockRejectedValue(new ApiClientError(
      409, 'REVISION_CONFLICT', 'Endpoint changed', 'req_1', undefined, { currentRevision: 9 },
    ));
    renderEditor();
    await userEvent.clear(screen.getByLabelText('Endpoint name'));
    await userEvent.type(screen.getByLabelText('Endpoint name'), 'Local Endpoint');
    await userEvent.clear(screen.getByLabelText('Variant name'));
    await userEvent.type(screen.getByLabelText('Variant name'), 'Local Variant');
    await userEvent.click(screen.getByRole('button', { name: 'New Variant' }));
    await userEvent.type(screen.getByLabelText('New Variant name'), 'Conflict copy');
    await userEvent.click(screen.getByRole('button', { name: 'Create Variant' }));

    expect(await screen.findByRole('dialog', { name: 'New Variant' })).toBeVisible();
    expect(screen.getByText('Server revision 9')).toBeVisible();
    expect(screen.getByLabelText('Endpoint name')).toHaveValue('Local Endpoint');
    expect(screen.getByLabelText('Variant name')).toHaveValue('Local Variant');
    expect(screen.getByLabelText('New Variant name')).toHaveValue('Conflict copy');
  });

  it('preserves the deletion dialog and drafts on conflict', async () => {
    vi.mocked(variantsApi.deletionImpact).mockResolvedValue({
      ...referencedImpact,
      isFallback: false,
      affectedStates: [],
      replacementVariants: [],
    });
    vi.mocked(variantsApi.delete).mockRejectedValue(new ApiClientError(
      409, 'REVISION_CONFLICT', 'Variant changed', 'req_1', undefined, { currentRevision: 10 },
    ));
    renderEditor();
    await userEvent.type(screen.getByLabelText('Endpoint description'), ' local');
    await userEvent.click(screen.getByRole('tab', { name: 'Denied' }));
    await userEvent.clear(screen.getByLabelText('Variant name'));
    await userEvent.type(screen.getByLabelText('Variant name'), 'Local Denied');
    await openVariantActions();
    await userEvent.click(screen.getByRole('button', { name: 'Delete Variant' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete Denied' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete Variant' }));

    expect(await screen.findByRole('dialog', { name: 'Delete Denied' })).toBeVisible();
    expect(within(dialog).getByText('Server revision 10')).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Refresh Variant' })).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Delete Variant' })).toBeDisabled();
    expect(screen.getByLabelText('Endpoint description')).toHaveValue(' local');
    expect(screen.getByLabelText('Variant name')).toHaveValue('Local Denied');
  });

  it('closes Variant deletion conflict recovery before using the guarded canonical refresh', async () => {
    const onAttemptNavigation = vi.fn()
      .mockImplementationOnce((action: () => void) => action());
    vi.mocked(variantsApi.deletionImpact).mockResolvedValue({
      ...referencedImpact,
      isFallback: false,
      affectedStates: [],
      replacementVariants: [],
    });
    vi.mocked(variantsApi.delete).mockRejectedValue(new ApiClientError(
      409, 'REVISION_CONFLICT', 'Variant changed', 'req_1', undefined, { currentRevision: 10 },
    ));
    renderEditor({ onAttemptNavigation });
    await userEvent.click(screen.getByRole('tab', { name: 'Denied' }));
    await userEvent.clear(screen.getByLabelText('Variant name'));
    await userEvent.type(screen.getByLabelText('Variant name'), 'Local Denied');
    await openVariantActions();
    await userEvent.click(screen.getByRole('button', { name: 'Delete Variant' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete Denied' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete Variant' }));

    await userEvent.click(within(dialog).getByRole('button', { name: 'Refresh Variant' }));

    expect(screen.queryByRole('dialog', { name: 'Delete Denied' })).not.toBeInTheDocument();
    expect(onAttemptNavigation).toHaveBeenCalledTimes(2);
    expect(onAttemptNavigation).toHaveBeenLastCalledWith(expect.any(Function), [
      expect.stringContaining('var_2'),
    ]);
    expect(endpointsApi.get).not.toHaveBeenCalled();
    await act(async () => onAttemptNavigation.mock.calls[1][0]());
    expect(endpointsApi.get).toHaveBeenCalledWith('prj_1', 'ep_1');
  });

  it('refreshes stale Variant deletion impact after a non-revision domain conflict', async () => {
    const staleImpact: VariantDeletionImpact = {
      ...referencedImpact,
      variantId: 'var_2',
      variantRevision: 2,
      endpointRevision: 4,
      isFallback: false,
      affectedStates: [],
      replacementVariants: [],
    };
    const freshImpact: VariantDeletionImpact = {
      ...referencedImpact,
      variantId: 'var_2',
      variantRevision: 7,
      endpointRevision: 8,
      isFallback: true,
      affectedStates: [],
      replacementVariants: [{ id: 'var_1', name: 'Allowed', revision: 1 }],
    };
    vi.mocked(variantsApi.deletionImpact)
      .mockResolvedValueOnce(staleImpact)
      .mockResolvedValueOnce(freshImpact);
    vi.mocked(variantsApi.delete)
      .mockRejectedValueOnce(new ApiClientError(
        409,
        'VARIANT_REPLACEMENT_REQUIRED',
        'A fresh replacement Variant is required',
        'req_domain',
      ))
      .mockResolvedValueOnce(undefined);
    vi.mocked(endpointsApi.get).mockResolvedValue({
      ...endpoint,
      defaultVariantId: 'var_1',
      variants: [endpoint.variants[0]],
      revision: 9,
    });
    renderEditor();
    await userEvent.click(screen.getByRole('tab', { name: 'Denied' }));
    await openVariantActions();
    await userEvent.click(screen.getByRole('button', { name: 'Delete Variant' }));
    let dialog = await screen.findByRole('dialog', { name: 'Delete Denied' });
    expect(within(dialog).queryByLabelText('Replacement Variant')).not.toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete Variant' }));

    expect(await screen.findByText('A fresh replacement Variant is required')).toBeVisible();
    await waitFor(() => expect(variantsApi.deletionImpact).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/Server revision/)).not.toBeInTheDocument();
    dialog = screen.getByRole('dialog', { name: 'Delete Denied' });
    expect(within(dialog).getByText('A fresh replacement Variant is required')).toBeVisible();
    expect(within(dialog).getByText('This Variant is Serving now.')).toBeVisible();
    expect(within(dialog).getByLabelText('Replacement Variant')).toHaveValue('');
    expect(within(dialog).getByRole('button', { name: 'Delete Variant' })).toBeDisabled();

    await userEvent.selectOptions(within(dialog).getByLabelText('Replacement Variant'), 'var_1');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete Variant' }));

    expect(variantsApi.delete).toHaveBeenLastCalledWith('prj_1', 'ep_1', 'var_2', 7, {
      expectedEndpointRevision: 8,
      replacementVariantId: 'var_1',
    });
  });

  it('preserves Endpoint fields and displays the current revision on conflict', async () => {
    vi.mocked(endpointsApi.update).mockRejectedValue(new ApiClientError(
      409, 'REVISION_CONFLICT', 'Endpoint changed', 'req_1', undefined, { currentRevision: 9 },
    ));
    render(<EndpointEditor projectId="prj_1" endpoint={endpoint} onEndpointSaveStarted={onEndpointSaveStarted} onSaved={vi.fn()} onDeleted={vi.fn()} onClose={vi.fn()} />);
    await userEvent.clear(screen.getByLabelText('Endpoint name'));
    await userEvent.type(screen.getByLabelText('Endpoint name'), 'Local Playback');
    await userEvent.click(screen.getByRole('button', { name: 'Save Endpoint' }));

    expect(await screen.findByText('Server revision 9')).toBeVisible();
    expect(screen.getByLabelText('Endpoint name')).toHaveValue('Local Playback');
  });

  it('guards explicit Endpoint conflict refresh before loading canonical detail', async () => {
    vi.mocked(endpointsApi.update).mockRejectedValue(new ApiClientError(
      409, 'REVISION_CONFLICT', 'Endpoint changed', 'req_1', undefined, { currentRevision: 9 },
    ));
    vi.mocked(endpointsApi.get).mockResolvedValue({ ...endpoint, name: 'Canonical Playback', revision: 9 });
    const onAttemptNavigation = vi.fn();
    renderEditor({ onAttemptNavigation });
    await userEvent.clear(screen.getByLabelText('Endpoint name'));
    await userEvent.type(screen.getByLabelText('Endpoint name'), 'Local Playback');
    await userEvent.click(screen.getByRole('button', { name: 'Save Endpoint' }));
    await screen.findByText('Server revision 9');

    await userEvent.click(screen.getByRole('button', { name: 'Refresh Endpoint' }));

    expect(onAttemptNavigation).toHaveBeenCalledWith(expect.any(Function), [
      'endpoint:prj_1:ep_1:4',
    ]);
    expect(endpointsApi.get).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Endpoint name')).toHaveValue('Local Playback');

    await act(async () => onAttemptNavigation.mock.calls[0][0]());
    expect(await screen.findByText('Endpoint revision 9')).toBeVisible();
    expect(screen.getByLabelText('Endpoint name')).toHaveValue('Canonical Playback');
  });

  it('guards explicit Variant conflict refresh with the Variant draft owner', async () => {
    vi.mocked(variantsApi.update).mockRejectedValue(new ApiClientError(
      409, 'REVISION_CONFLICT', 'Variant changed', 'req_1', undefined, { currentRevision: 10 },
    ));
    vi.mocked(endpointsApi.get).mockResolvedValue({ ...endpoint, revision: 9 });
    const onAttemptNavigation = vi.fn();
    renderEditor({ onAttemptNavigation });
    await userEvent.clear(screen.getByLabelText('Variant name'));
    await userEvent.type(screen.getByLabelText('Variant name'), 'Local Variant');
    await userEvent.click(screen.getByRole('button', { name: 'Save Variant' }));
    await screen.findByText('Server revision 10');

    await userEvent.click(screen.getByRole('button', { name: 'Refresh Variant' }));

    expect(onAttemptNavigation).toHaveBeenCalledWith(expect.any(Function), [
      expect.stringContaining('var_1'),
    ]);
    expect(endpointsApi.get).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Variant name')).toHaveValue('Local Variant');

    await act(async () => onAttemptNavigation.mock.calls[0][0]());
    expect(await screen.findByText('Endpoint revision 9')).toBeVisible();
  });

  it('blocks Endpoint edits while an authorized conflict refresh is pending', async () => {
    const user = userEvent.setup();
    const pendingRefresh = deferred<EndpointDetail>();
    vi.mocked(endpointsApi.update).mockRejectedValue(new ApiClientError(
      409, 'REVISION_CONFLICT', 'Endpoint changed', 'req_1', undefined, { currentRevision: 9 },
    ));
    vi.mocked(endpointsApi.get).mockReturnValue(pendingRefresh.promise);
    let discard: (() => void) | undefined;
    renderEditor({
      onDirtyChange: (_key, dirty, nextDiscard) => {
        if (dirty) discard = nextDiscard;
      },
      onAttemptNavigation: action => {
        discard?.();
        action();
      },
    });
    await user.clear(screen.getByLabelText('Endpoint name'));
    await user.type(screen.getByLabelText('Endpoint name'), 'Local Playback');
    await user.click(screen.getByRole('button', { name: 'Save Endpoint' }));
    await screen.findByText('Server revision 9');

    await user.click(screen.getByRole('button', { name: 'Refresh Endpoint' }));

    expect(screen.getByRole('button', { name: 'Refreshing Endpoint...' })).toBeDisabled();
    expect(screen.getByLabelText('Endpoint name')).toBeDisabled();
    await user.type(screen.getByLabelText('Endpoint name'), 'must not survive');
    expect(screen.getByLabelText('Endpoint name')).toHaveValue('Playback');

    await act(async () => pendingRefresh.resolve({
      ...endpoint,
      name: 'Canonical Playback',
      revision: 9,
    }));

    await waitFor(() => expect(screen.getByLabelText('Endpoint name')).toHaveValue('Canonical Playback'));
    expect(screen.getByText('Endpoint revision 9')).toBeVisible();
    expect(screen.getByLabelText('Endpoint name')).toBeEnabled();
  });

  it('blocks Variant edits while an authorized conflict refresh is pending', async () => {
    const user = userEvent.setup();
    const pendingRefresh = deferred<EndpointDetail>();
    vi.mocked(variantsApi.update).mockRejectedValue(new ApiClientError(
      409, 'REVISION_CONFLICT', 'Variant changed', 'req_1', undefined, { currentRevision: 10 },
    ));
    vi.mocked(endpointsApi.get).mockReturnValue(pendingRefresh.promise);
    let discard: (() => void) | undefined;
    renderEditor({
      onDirtyChange: (_key, dirty, nextDiscard) => {
        if (dirty) discard = nextDiscard;
      },
      onAttemptNavigation: action => {
        discard?.();
        action();
      },
    });
    await user.clear(screen.getByLabelText('Variant name'));
    await user.type(screen.getByLabelText('Variant name'), 'Local Variant');
    await user.click(screen.getByRole('button', { name: 'Save Variant' }));
    await screen.findByText('Server revision 10');

    await user.click(screen.getByRole('button', { name: 'Refresh Variant' }));

    expect(screen.getByRole('button', { name: 'Refreshing Variant...' })).toBeDisabled();
    expect(screen.getByLabelText('Variant name')).toBeDisabled();
    expect(screen.getByLabelText('Endpoint name')).toBeDisabled();
    await user.type(screen.getByLabelText('Variant name'), 'must not survive');
    expect(screen.getByLabelText('Variant name')).toHaveValue('Allowed');

    const canonicalVariant = { ...endpoint.variants[0], name: 'Canonical Allowed', revision: 10 };
    await act(async () => pendingRefresh.resolve({
      ...endpoint,
      variants: [canonicalVariant, endpoint.variants[1]],
      revision: 9,
    }));

    await waitFor(() => expect(screen.getByLabelText('Variant name')).toHaveValue('Canonical Allowed'));
    expect(screen.getByText('Endpoint revision 9')).toBeVisible();
    expect(screen.getByLabelText('Variant name')).toBeEnabled();
  });

  it('preserves a dirty Variant across a deep-cloned Endpoint save response', async () => {
    const user = userEvent.setup();
    const savedEndpoint = structuredClone({
      ...endpoint,
      description: 'Saved endpoint',
      revision: 5,
    });
    const savedVariant = {
      ...savedEndpoint.variants[0],
      responseHeaders: { 'set-cookie': ['local=1', 'two=2'] },
      bodyAssetId: undefined,
      revision: 2,
    };
    vi.mocked(endpointsApi.update).mockResolvedValue(savedEndpoint);
    vi.mocked(variantsApi.update).mockResolvedValue(savedVariant);
    vi.mocked(endpointsApi.get).mockResolvedValue({
      ...savedEndpoint,
      variants: [savedVariant, savedEndpoint.variants[1]],
      revision: 6,
    });
    renderEditor();
    expect(savedEndpoint.variants[0]).not.toBe(endpoint.variants[0]);
    expect(savedEndpoint.variants[0].responseHeaders).not.toBe(endpoint.variants[0].responseHeaders);
    expect(savedEndpoint.variants[0].responseHeaders['set-cookie'])
      .not.toBe(endpoint.variants[0].responseHeaders['set-cookie']);
    const headerValues = screen.getAllByPlaceholderText('application/json');
    await user.clear(headerValues[0]);
    await user.type(headerValues[0], 'local=1');
    await user.click(screen.getByRole('button', { name: 'Remove response body' }));
    await user.type(screen.getByLabelText('Endpoint description'), 'Saved endpoint');

    await user.click(screen.getByRole('button', { name: 'Save Endpoint' }));

    await waitFor(() => expect(screen.getByLabelText('Endpoint description')).toHaveValue('Saved endpoint'));
    expect(screen.getAllByPlaceholderText('application/json')[0]).toHaveValue('local=1');
    expect(screen.getAllByPlaceholderText('application/json')[1]).toHaveValue('two=2');
    await user.click(screen.getByRole('button', { name: 'Save Variant' }));
    await waitFor(() => expect(variantsApi.update).toHaveBeenCalledWith(
      'prj_1',
      'ep_1',
      'var_1',
      1,
      {
        responseHeaders: { 'set-cookie': ['local=1', 'two=2'] },
        bodyAssetId: null,
      },
    ));
  });

  it('adopts external canonical Endpoint fields after Variant save when the sibling form was clean', async () => {
    const savedVariant = { ...endpoint.variants[0], name: 'Saved Variant', revision: 2 };
    const canonicalEndpoint: EndpointDetail = {
      ...endpoint,
      name: 'External Endpoint',
      description: 'External description',
      baseUrl: 'https://external.example.test',
      matcher: { method: 'POST', path: '/external' },
      variants: [savedVariant, endpoint.variants[1]],
      revision: 8,
    };
    vi.mocked(variantsApi.update).mockResolvedValue(savedVariant);
    vi.mocked(endpointsApi.get).mockResolvedValue(canonicalEndpoint);
    renderEditor();
    await userEvent.clear(screen.getByLabelText('Variant name'));
    await userEvent.type(screen.getByLabelText('Variant name'), 'Saved Variant');

    await userEvent.click(screen.getByRole('button', { name: 'Save Variant' }));

    await waitFor(() => expect(screen.getByText('Endpoint revision 8')).toBeVisible());
    expect(screen.getByLabelText('Endpoint name')).toHaveValue('External Endpoint');
    expect(screen.getByLabelText('Endpoint description')).toHaveValue('External description');
    expect(screen.getByRole('combobox', { name: 'Method' })).toHaveValue('POST');
    expect(screen.getByLabelText('Endpoint base URL')).toHaveValue('https://external.example.test');
    expect(screen.getByLabelText('Endpoint path')).toHaveValue('/external');
  });

  it('reloads canonical Endpoint structure after Variant save without overwriting its sibling draft', async () => {
    const user = userEvent.setup();
    const pendingVariantSave = deferred<(typeof endpoint.variants)[number]>();
    const pendingCanonicalReload = deferred<EndpointDetail>();
    const savedVariant = { ...endpoint.variants[0], name: 'Saved Variant', revision: 2 };
    const canonicalEndpoint: EndpointDetail = structuredClone({
      ...endpoint,
      name: 'External Endpoint',
      description: 'External description',
      defaultVariantId: 'var_2',
      variants: [endpoint.variants[1], savedVariant],
      revision: 8,
    });
    vi.mocked(variantsApi.update).mockReturnValue(pendingVariantSave.promise);
    vi.mocked(endpointsApi.get).mockReturnValue(pendingCanonicalReload.promise);
    const completePublication = vi.fn(() => true);
    const onEndpointSaveStarted = vi.fn(() => completePublication);
    const onSaved = vi.fn();
    const onDirtyChange = vi.fn();
    const view = renderEditor({ onEndpointSaveStarted, onSaved, onDirtyChange });
    await user.type(screen.getByLabelText('Endpoint description'), 'Local Endpoint draft');
    await waitFor(() => expect(onDirtyChange).toHaveBeenCalledWith(
      'endpoint:prj_1:ep_1:4', true, expect.any(Function),
    ));
    await user.clear(screen.getByLabelText('Variant name'));
    await user.type(screen.getByLabelText('Variant name'), 'Saved Variant');

    await user.click(screen.getByRole('button', { name: 'Save Variant' }));
    await waitFor(() => expect(variantsApi.update).toHaveBeenCalledOnce());
    await act(async () => pendingVariantSave.resolve(savedVariant));

    await waitFor(() => expect(endpointsApi.get).toHaveBeenCalledWith('prj_1', 'ep_1'));
    expect(screen.getByLabelText('Endpoint name')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save Variant' })).toBeDisabled();
    await act(async () => pendingCanonicalReload.resolve(canonicalEndpoint));
    expect(completePublication).toHaveBeenCalledWith(canonicalEndpoint);
    expect(screen.getByText('Endpoint revision 8')).toBeVisible();
    expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual([
      'DeniedServing now',
      'Saved Variant',
    ]);
    expect(screen.getByLabelText('Variant name')).toHaveValue('Saved Variant');
    expect(screen.getByLabelText('Endpoint name')).toHaveValue('Playback');
    expect(screen.getByLabelText('Endpoint description')).toHaveValue('Local Endpoint draft');
    expect(onSaved).toHaveBeenLastCalledWith(canonicalEndpoint);
    expect(onDirtyChange).toHaveBeenCalledWith('endpoint:prj_1:ep_1:4', false);
    expect(onDirtyChange).toHaveBeenCalledWith(
      'endpoint:prj_1:ep_1:8', true, expect.any(Function),
    );
    view.unmount();
    expect(onDirtyChange).toHaveBeenCalledWith('endpoint:prj_1:ep_1:8', false);
  });

  it('rejects a Variant canonical reload through its original publication owner', async () => {
    const savedVariant = { ...endpoint.variants[0], name: 'Saved Variant', revision: 2 };
    const canonicalEndpoint: EndpointDetail = {
      ...endpoint,
      defaultVariantId: 'var_2',
      variants: [endpoint.variants[1], savedVariant],
      revision: 8,
    };
    vi.mocked(variantsApi.update).mockResolvedValue(savedVariant);
    vi.mocked(endpointsApi.get).mockResolvedValue(canonicalEndpoint);
    const completePublication = vi.fn(() => false);
    const onSaved = vi.fn();
    renderEditor({ onEndpointSaveStarted: () => completePublication, onSaved });
    await userEvent.clear(screen.getByLabelText('Variant name'));
    await userEvent.type(screen.getByLabelText('Variant name'), 'Saved Variant');

    await userEvent.click(screen.getByRole('button', { name: 'Save Variant' }));

    await waitFor(() => expect(endpointsApi.get).toHaveBeenCalledWith('prj_1', 'ep_1'));
    expect(completePublication).toHaveBeenCalledWith(canonicalEndpoint);
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.getByText('Endpoint revision 4')).toBeVisible();
    expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual([
      'AllowedServing now',
      'Denied',
    ]);
  });

  it('serializes Endpoint then Variant saves and merges from the completed Endpoint', async () => {
    const user = userEvent.setup();
    const endpointSave = deferred<EndpointDetail>();
    const variantSave = deferred<(typeof endpoint.variants)[number]>();
    const savedEndpoint = { ...endpoint, name: 'Saved Endpoint', revision: 5 };
    const savedVariant = { ...endpoint.variants[0], name: 'Saved Variant', revision: 2 };
    vi.mocked(endpointsApi.update).mockReturnValue(endpointSave.promise);
    vi.mocked(variantsApi.update).mockReturnValue(variantSave.promise);
    vi.mocked(endpointsApi.get).mockResolvedValue({
      ...savedEndpoint,
      variants: [savedVariant, endpoint.variants[1]],
    });
    const onSaved = vi.fn();
    renderEditor({ onSaved });
    await user.clear(screen.getByLabelText('Endpoint name'));
    await user.type(screen.getByLabelText('Endpoint name'), 'Saved Endpoint');
    await user.clear(screen.getByLabelText('Variant name'));
    await user.type(screen.getByLabelText('Variant name'), 'Saved Variant');

    await user.click(screen.getByRole('button', { name: 'Save Endpoint' }));

    await waitFor(() => expect(endpointsApi.update).toHaveBeenCalledOnce());
    expect(screen.getByLabelText('Endpoint name')).toBeDisabled();
    expect(screen.getByLabelText('Variant name')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save Variant' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Save Variant' }));
    expect(variantsApi.update).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText('Endpoint name'), ' must not survive');
    expect(screen.getByLabelText('Endpoint name')).toHaveValue('Saved Endpoint');

    await act(async () => endpointSave.resolve(savedEndpoint));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Save Variant' })).toBeEnabled());
    expect(screen.getByLabelText('Variant name')).toHaveValue('Saved Variant');
    await user.click(screen.getByRole('button', { name: 'Save Variant' }));
    await waitFor(() => expect(variantsApi.update).toHaveBeenCalledOnce());
    await act(async () => variantSave.resolve(savedVariant));

    expect(onSaved).toHaveBeenLastCalledWith({
      ...savedEndpoint,
      variants: [savedVariant, endpoint.variants[1]],
    });
  });

  it('blocks Endpoint and structural mutations while a Variant save owns the editor', async () => {
    const user = userEvent.setup();
    const variantSave = deferred<(typeof endpoint.variants)[number]>();
    vi.mocked(variantsApi.update).mockReturnValue(variantSave.promise);
    renderEditor();
    await user.clear(screen.getByLabelText('Variant name'));
    await user.type(screen.getByLabelText('Variant name'), 'Saved Variant');

    await user.click(screen.getByRole('button', { name: 'Save Variant' }));

    await waitFor(() => expect(variantsApi.update).toHaveBeenCalledOnce());
    expect(screen.getByLabelText('Endpoint name')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save Endpoint' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'New Variant' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Save Endpoint' }));
    expect(endpointsApi.update).not.toHaveBeenCalled();

    await act(async () => variantSave.resolve({ ...endpoint.variants[0], name: 'Saved Variant', revision: 2 }));

    await waitFor(() => expect(screen.getByLabelText('Endpoint name')).toBeEnabled());
  });

  it('normalizes Endpoint fields and dirty ownership to the successful server detail', async () => {
    const saved: EndpointDetail = {
      ...endpoint,
      name: 'Playback saved',
      description: 'Canonical description',
      baseUrl: 'https://canonical.example.test',
      revision: 5,
    };
    vi.mocked(endpointsApi.update).mockResolvedValue(saved);
    const onDirtyChange = vi.fn();
    const completeSave = vi.fn(() => true);
    const startSave = vi.fn(() => completeSave);
    render(
      <EndpointEditor
        projectId="prj_1"
        endpoint={endpoint}
        onEndpointSaveStarted={startSave}
        onSaved={vi.fn()}
        onDeleted={vi.fn()}
        onClose={vi.fn()}
        onDirtyChange={onDirtyChange}
      />,
    );
    await userEvent.clear(screen.getByLabelText('Endpoint name'));
    await userEvent.type(screen.getByLabelText('Endpoint name'), '  Playback saved  ');
    await userEvent.type(screen.getByLabelText('Endpoint description'), '  Canonical description  ');
    await userEvent.clear(screen.getByLabelText('Endpoint base URL'));
    await userEvent.type(screen.getByLabelText('Endpoint base URL'), '  https://api.example.test  ');
    await userEvent.click(screen.getByRole('button', { name: 'Save Endpoint' }));

    await waitFor(() => expect(screen.getByLabelText('Endpoint name')).toHaveValue('Playback saved'));
    expect(screen.getByLabelText('Endpoint description')).toHaveValue('Canonical description');
    expect(screen.getByLabelText('Endpoint base URL')).toHaveValue('https://canonical.example.test');
    expect(startSave).toHaveBeenCalledOnce();
    expect(completeSave).toHaveBeenCalledWith(saved);
    expect(onDirtyChange).toHaveBeenCalledWith('endpoint:prj_1:ep_1:4', false);
    expect(onDirtyChange).toHaveBeenLastCalledWith(
      'endpoint:prj_1:ep_1:5',
      false,
      expect.any(Function),
    );
  });

  it('does not clear or normalize fields when save publication is rejected', async () => {
    const saved = { ...endpoint, name: 'Server name', description: 'Server description', revision: 5 };
    vi.mocked(endpointsApi.update).mockResolvedValue(saved);
    const onDirtyChange = vi.fn();
    const completeSave = vi.fn(() => false);
    render(
      <EndpointEditor
        projectId="prj_1"
        endpoint={endpoint}
        onEndpointSaveStarted={() => completeSave}
        onSaved={vi.fn()}
        onDeleted={vi.fn()}
        onClose={vi.fn()}
        onDirtyChange={onDirtyChange}
      />,
    );
    await userEvent.clear(screen.getByLabelText('Endpoint name'));
    await userEvent.type(screen.getByLabelText('Endpoint name'), 'Current local draft');
    await userEvent.click(screen.getByRole('button', { name: 'Save Endpoint' }));

    await waitFor(() => expect(completeSave).toHaveBeenCalledWith(saved));
    expect(screen.getByLabelText('Endpoint name')).toHaveValue('Current local draft');
    expect(onDirtyChange).not.toHaveBeenCalledWith('endpoint:prj_1:ep_1:4', false);
  });
});
