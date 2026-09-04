import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiClientError, statesApi } from '../api/client';
import type { AppState, EndpointDetail, Project } from '../api/types';
import { AppStateEditor } from './AppStateEditor';

vi.mock('../api/client', async importOriginal => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  statesApi: { delete: vi.fn(), update: vi.fn() },
}));

const state: AppState = {
  schemaVersion: 4,
  id: 'state_1',
  projectId: 'prj_1',
  name: 'Signed in',
  tags: [],
  bindings: { ep_playback: 'var_allowed' },
  revision: 3,
};
const endpointDetail: EndpointDetail = {
  schemaVersion: 4,
  id: 'ep_playback',
  projectId: 'prj_1',
  name: 'Playback authorization',
  baseUrl: 'https://api.example.test',
  matcher: { method: 'GET', path: '/playback' },
  mode: 'mock',
  defaultVariantId: 'var_allowed',
  variants: [
    { id: 'var_allowed', endpointId: 'ep_playback', name: 'Allowed', status: 200, responseHeaders: {}, revision: 1 },
    { id: 'var_denied', endpointId: 'ep_playback', name: 'Denied', status: 403, responseHeaders: {}, revision: 1 },
  ],
  revision: 2,
};
const project: Project = {
  schemaVersion: 4,
  id: 'prj_1',
  name: 'Streaming UI',
  appStateMode: 'enabled',
  activeStateId: 'state_1',
  revision: 7,
  createdAt: '2026-08-28T00:00:00.000Z',
  updatedAt: '2026-08-28T00:00:00.000Z',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(next => { resolve = next; });
  return { promise, resolve };
}

describe('AppStateEditor', () => {
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetAllMocks();
    writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
  });

  function renderEditor(overrides: Partial<React.ComponentProps<typeof AppStateEditor>> = {}) {
    const props: React.ComponentProps<typeof AppStateEditor> = {
      state,
      project,
      endpoints: [endpointDetail],
      onSaveStarted: () => vi.fn(() => true),
      onRefresh: vi.fn(),
      onDeleted: vi.fn(),
      ...overrides,
    };
    return { ...render(<AppStateEditor {...props} />), props };
  }

  it('saves App State bindings by stable Endpoint and Variant IDs', async () => {
    vi.mocked(statesApi.update).mockResolvedValue({ ...state, bindings: { ep_playback: 'var_denied' } });
    renderEditor({ onDirtyChange: vi.fn() });

    await userEvent.selectOptions(screen.getByLabelText('Playback authorization variant'), 'var_denied');
    await userEvent.click(screen.getByRole('button', { name: 'Save App State' }));
    expect(statesApi.update).toHaveBeenCalledWith('prj_1', 'state_1', 3, {
      bindings: { ep_playback: 'var_denied' },
    });
  });

  it('owns and disables every App State mutation control until save completes', async () => {
    const user = userEvent.setup();
    const pendingSave = deferred<AppState>();
    vi.mocked(statesApi.update).mockReturnValue(pendingSave.promise);
    renderEditor();
    await user.type(screen.getByLabelText('Expected UI'), 'Local screen');

    await user.click(screen.getByRole('button', { name: 'Save App State' }));

    await waitFor(() => expect(statesApi.update).toHaveBeenCalledOnce());
    expect(screen.getByLabelText('App State name')).toBeDisabled();
    expect(screen.getByLabelText('Expected UI')).toBeDisabled();
    expect(screen.getByLabelText('Playback authorization variant')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save App State' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Delete App State' })).toBeDisabled();
    await user.type(screen.getByLabelText('Expected UI'), ' must not survive');
    expect(screen.getByLabelText('Expected UI')).toHaveValue('Local screen');

    await act(async () => pendingSave.resolve({ ...state, expectedUi: 'Local screen', revision: 4 }));

    await waitFor(() => expect(screen.getByLabelText('Expected UI')).toBeEnabled());
  });

  it('preserves App State fields and displays the current revision on conflict', async () => {
    vi.mocked(statesApi.update).mockRejectedValue(new ApiClientError(
      409, 'REVISION_CONFLICT', 'App State changed', 'req_2', undefined, { currentRevision: 8 },
    ));
    renderEditor();
    await userEvent.type(screen.getByLabelText('Expected UI'), 'Local screen');
    await userEvent.click(screen.getByRole('button', { name: 'Save App State' }));

    expect(await screen.findByText('Server revision 8')).toBeVisible();
    expect(screen.getByLabelText('Expected UI')).toHaveValue('Local screen');
  });

  it('shows and copies the stable App State ID after a rename', async () => {
    vi.mocked(statesApi.update).mockResolvedValue({ ...state, name: 'Renamed', revision: 4 });
    renderEditor();

    expect(screen.getByText('state_1', { selector: 'code' })).toBeVisible();
    await userEvent.clear(screen.getByLabelText('App State name'));
    await userEvent.type(screen.getByLabelText('App State name'), 'Renamed');
    await userEvent.click(screen.getByRole('button', { name: 'Save App State' }));
    await userEvent.click(screen.getByRole('button', { name: 'Copy App State ID' }));

    expect(writeText).toHaveBeenCalledWith('state_1');
    expect(screen.getByText('/setMockServerflags')).toBeVisible();
  });

  it.each([
    ['Active and Base', { activeStateId: 'state_1', baseStateId: 'state_1' }],
    ['Active', { activeStateId: 'state_1', baseStateId: undefined }],
    ['Base', { activeStateId: undefined, baseStateId: 'state_1' }],
    ['Neither Active nor Base', { activeStateId: undefined, baseStateId: undefined }],
  ] as const)('describes the %s selection impact and external reference limit', async (label, selection) => {
    renderEditor({ project: { ...project, ...selection } });

    await userEvent.click(screen.getByRole('button', { name: 'Delete App State' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete App State' });
    expect(within(dialog).getByText(new RegExp(label))).toBeVisible();
    expect(within(dialog).getByText(/External iOS\/Android references cannot be discovered/)).toBeVisible();
    cleanup();
  });

  it('deletes with the current App State revision', async () => {
    vi.mocked(statesApi.delete).mockResolvedValue(undefined);
    const onDeleted = vi.fn();
    renderEditor({ onDeleted });

    await userEvent.click(screen.getByRole('button', { name: 'Delete App State' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete App State' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete App State' }));

    expect(statesApi.delete).toHaveBeenCalledWith('prj_1', 'state_1', 3);
    expect(onDeleted).toHaveBeenCalledWith('state_1');
  });

  it('routes deletion through the current App State draft key', async () => {
    const onAttemptNavigation = vi.fn();
    renderEditor({ onAttemptNavigation });
    await userEvent.type(screen.getByLabelText('Expected UI'), 'Local screen');

    await userEvent.click(screen.getByRole('button', { name: 'Delete App State' }));

    expect(onAttemptNavigation).toHaveBeenCalledWith(expect.any(Function), [
      'state:prj_1:state_1:3',
    ]);
    expect(screen.queryByRole('dialog', { name: 'Delete App State' })).not.toBeInTheDocument();
  });

  it('preserves the editor, warning, and draft when deletion conflicts', async () => {
    vi.mocked(statesApi.delete).mockRejectedValue(new ApiClientError(
      409, 'REVISION_CONFLICT', 'App State changed', 'req_2', undefined, { currentRevision: 8 },
    ));
    renderEditor();
    await userEvent.type(screen.getByLabelText('Expected UI'), 'Local screen');
    await userEvent.click(screen.getByRole('button', { name: 'Delete App State' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete App State' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete App State' }));

    const openDialog = screen.getByRole('dialog', { name: 'Delete App State' });
    expect(await within(openDialog).findByText('Server revision 8')).toBeVisible();
    expect(screen.getByLabelText('Expected UI')).toHaveValue('Local screen');
    expect(openDialog).toBeVisible();
    expect(within(openDialog).getByText('Server revision 8')).toBeVisible();
    expect(within(openDialog).getByRole('button', { name: 'Refresh App State' })).toBeVisible();
    expect(within(openDialog).getByRole('button', { name: 'Delete App State' })).toBeDisabled();
    expect(within(openDialog).getByText(/External iOS\/Android references cannot be discovered/)).toBeVisible();
  });

  it('closes App State deletion conflict recovery before using the guarded canonical refresh', async () => {
    const onAttemptNavigation = vi.fn()
      .mockImplementationOnce((action: () => void) => action());
    const onRefresh = vi.fn();
    vi.mocked(statesApi.delete).mockRejectedValue(new ApiClientError(
      409, 'REVISION_CONFLICT', 'App State changed', 'req_2', undefined, { currentRevision: 8 },
    ));
    renderEditor({ onAttemptNavigation, onRefresh });
    await userEvent.type(screen.getByLabelText('Expected UI'), 'Local screen');
    await userEvent.click(screen.getByRole('button', { name: 'Delete App State' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete App State' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete App State' }));

    await userEvent.click(within(dialog).getByRole('button', { name: 'Refresh App State' }));

    expect(screen.queryByRole('dialog', { name: 'Delete App State' })).not.toBeInTheDocument();
    expect(onAttemptNavigation).toHaveBeenCalledTimes(2);
    expect(onAttemptNavigation).toHaveBeenLastCalledWith(expect.any(Function), [
      'state:prj_1:state_1:3',
    ]);
    expect(onRefresh).not.toHaveBeenCalled();
    await act(async () => onAttemptNavigation.mock.calls[1][0]());
    expect(onRefresh).toHaveBeenCalledOnce();
  });
});
