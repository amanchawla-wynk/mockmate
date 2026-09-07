import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiClientError, projectsApi, statesApi } from '../api/client';
import type { AppStateSummary, EndpointSummary, Project } from '../api/types';
import { AppStateSwitcher } from './AppStateSwitcher';

vi.mock('../api/client', async importOriginal => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  projectsApi: { get: vi.fn() },
  statesApi: { setMode: vi.fn(), setSelection: vi.fn() },
}));

const project: Project = {
  schemaVersion: 4,
  id: 'prj_1',
  name: 'Streaming',
  appStateMode: 'enabled',
  activeStateId: 'state_expired',
  revision: 7,
  createdAt: '2026-08-28T00:00:00.000Z',
  updatedAt: '2026-08-28T00:00:00.000Z',
};
const endpoints = [{ id: 'ep_1' }, { id: 'ep_2' }] as EndpointSummary[];
const partialState: AppStateSummary = {
  id: 'state_expired',
  projectId: 'prj_1',
  name: 'Expired session',
  tags: [],
  revision: 1,
  boundEndpointCount: 0,
  totalEndpointCount: 2,
};

describe('AppStateSwitcher', () => {
  beforeEach(() => vi.resetAllMocks());

  it('changes App State mode without clearing dormant selections', async () => {
    vi.mocked(statesApi.setMode).mockResolvedValue({ ...project, appStateMode: 'disabled', revision: 8 });
    const onActivated = vi.fn();
    render(<AppStateSwitcher project={project} states={[partialState]} endpoints={endpoints} onActivated={onActivated} />);

    await userEvent.click(screen.getByRole('button', { name: 'Disable App States' }));

    expect(statesApi.setMode).toHaveBeenCalledWith('prj_1', 'disabled', 7);
    expect(onActivated).toHaveBeenCalledWith(expect.objectContaining({
      appStateMode: 'disabled',
      activeStateId: project.activeStateId,
    }));
  });

  it('activates a sparse App State without a coverage acknowledgement', async () => {
    const activated = { ...project, appStateMode: 'enabled' as const, activeStateId: 'state_expired', revision: 8 };
    vi.mocked(statesApi.setSelection).mockResolvedValue(activated);
    const onActivated = vi.fn();
    render(
      <AppStateSwitcher
        project={{ ...project, appStateMode: 'disabled', activeStateId: undefined }}
        states={[partialState]}
        endpoints={endpoints}
        onActivated={onActivated}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Activate Expired session' }));

    expect(statesApi.setSelection).toHaveBeenCalledWith('prj_1', 7, { activeStateId: 'state_expired' });
    expect(onActivated).toHaveBeenCalledWith(activated);
  });

  it('counts only mock-ready Endpoints for App State coverage', () => {
    render(<AppStateSwitcher
      project={project}
      states={[partialState]}
      endpoints={[
        { ...endpoints[0], mode: 'mock', mockReady: true },
        { ...endpoints[1], mode: 'passthrough', mockReady: true },
      ] as EndpointSummary[]}
      onActivated={vi.fn()}
    />);

    expect(screen.getByText('1 Mock-ready Endpoint')).toBeVisible();
  });

  it('preserves dormant selection when the mode revision conflicts', async () => {
    vi.mocked(statesApi.setMode).mockRejectedValue(new ApiClientError(
      409, 'REVISION_CONFLICT', 'Project changed', 'req_mode', undefined, { currentRevision: 9 },
    ));
    const onActivated = vi.fn();
    render(<AppStateSwitcher project={project} states={[partialState]} endpoints={endpoints} onActivated={onActivated} />);

    await userEvent.click(screen.getByRole('button', { name: 'Disable App States' }));

    expect(await screen.findByText('Server revision 9')).toBeVisible();
    expect(onActivated).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Activate Expired session' })).toHaveClass('bg-blue-50');
  });

  it('reconciles an unknown mode outcome through GET without repeating the mutation', async () => {
    const canonical = { ...project, appStateMode: 'disabled' as const, revision: 8 };
    vi.mocked(statesApi.setMode).mockRejectedValue(new Error('connection lost'));
    vi.mocked(projectsApi.get).mockResolvedValue(canonical);
    const onActivated = vi.fn();
    render(<AppStateSwitcher project={project} states={[partialState]} endpoints={endpoints} onActivated={onActivated} />);

    await userEvent.click(screen.getByRole('button', { name: 'Disable App States' }));

    expect(projectsApi.get).toHaveBeenCalledWith('prj_1');
    expect(statesApi.setMode).toHaveBeenCalledTimes(1);
    expect(onActivated).toHaveBeenCalledWith(canonical);
  });
});
