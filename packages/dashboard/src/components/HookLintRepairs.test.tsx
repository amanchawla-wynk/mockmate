import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { endpointsApi, projectsApi, staticFilesApi } from '../api/client';
import type { EndpointSummary, Project } from '../api/types';
import { useEndpoints } from '../hooks/useEndpoints';
import { useProjects } from '../hooks/useProjects';
import { DeviceSetup } from './DeviceSetup';
import { InputDialog } from './InputDialog';
import { ProjectModal } from './ProjectModal';
import { StaticFilesView } from './StaticFilesView';

vi.mock('../api/client', () => ({
  ApiClientError: class ApiClientError extends Error {},
  endpointsApi: { get: vi.fn(), list: vi.fn() },
  projectsApi: { create: vi.fn(), delete: vi.fn(), get: vi.fn(), getWorkspace: vi.fn(), list: vi.fn(), setActive: vi.fn(), update: vi.fn() },
  staticFilesApi: { delete: vi.fn(), list: vi.fn(), upload: vi.fn() },
}));

const project: Project = {
  schemaVersion: 4, id: 'prj_1', name: 'Project', appStateMode: 'enabled', revision: 1,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
};
const endpoint = (projectId: string): EndpointSummary => ({
  schemaVersion: 4, id: `ep_${projectId}`, projectId, name: 'Users',
  baseUrl: 'https://api.example.test', mode: 'mock', method: 'GET', path: '/users',
  queryConstraintCount: 0, headerConstraintCount: 0, variantCount: 0, mockReady: false, revision: 1,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(projectsApi.list).mockResolvedValue([]);
  vi.mocked(projectsApi.getWorkspace).mockResolvedValue({ schemaVersion: 4, revision: 0 });
  vi.mocked(endpointsApi.list).mockResolvedValue([]);
  vi.mocked(staticFilesApi.list).mockResolvedValue({ files: [] });
});

describe('hook lifecycle behavior', () => {
  it('updates device setup URLs when network props change', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<DeviceSetup localIPs={['192.168.1.2']} />);
    await user.click(screen.getByRole('button', { name: /Device Setup/ }));
    expect(screen.getByText('http://192.168.1.2:3456/setup')).toBeInTheDocument();
    rerender(<DeviceSetup httpPort={4567} localIPs={['10.0.0.2']} />);
    expect(screen.getByText('http://10.0.0.2:4567/setup')).toBeInTheDocument();
  });

  it('resets dialog and Project form values whenever they reopen', async () => {
    const user = userEvent.setup();
    const dialogProps = { title: 'Name', message: 'Enter a name', defaultValue: 'Initial', onConfirm: vi.fn(), onCancel: vi.fn() };
    const dialog = render(<InputDialog isOpen {...dialogProps} />);
    await user.clear(screen.getByRole('textbox'));
    await user.type(screen.getByRole('textbox'), 'Draft');
    dialog.rerender(<InputDialog isOpen={false} {...dialogProps} />);
    dialog.rerender(<InputDialog isOpen {...dialogProps} />);
    expect(screen.getByRole('textbox')).toHaveValue('Initial');
    dialog.unmount();

    const modalProps = { onClose: vi.fn(), onSubmit: vi.fn() };
    const modal = render(<ProjectModal isOpen {...modalProps} />);
    await user.type(screen.getByLabelText('Project Name'), 'Draft Project');
    modal.rerender(<ProjectModal isOpen={false} {...modalProps} />);
    modal.rerender(<ProjectModal isOpen {...modalProps} />);
    expect(screen.getByLabelText('Project Name')).toHaveValue('');
  });

  it('loads Project summaries, workspace, and active detail on mount', async () => {
    vi.mocked(projectsApi.list).mockResolvedValue([{ id: project.id, name: project.name, revision: 1, updatedAt: project.updatedAt }]);
    vi.mocked(projectsApi.getWorkspace).mockResolvedValue({ schemaVersion: 4, activeProjectId: project.id, revision: 2 });
    vi.mocked(projectsApi.get).mockResolvedValue(project);
    const { result } = renderHook(() => useProjects());
    await waitFor(() => expect(result.current.activeProject).toEqual(project));
    expect(result.current.projects).toHaveLength(1);
  });

  it('aborts stale Endpoint lists when the active Project changes', async () => {
    let firstSignal: AbortSignal | undefined;
    let resolveFirst: ((value: EndpointSummary[]) => void) | undefined;
    vi.mocked(endpointsApi.list)
      .mockImplementationOnce((_id, signal) => {
        firstSignal = signal;
        return new Promise(resolve => { resolveFirst = resolve; });
      })
      .mockResolvedValueOnce([endpoint('prj_2')]);
    const { result, rerender } = renderHook(
      ({ projectId }) => useEndpoints(projectId),
      { initialProps: { projectId: 'prj_1' } },
    );
    await waitFor(() => expect(endpointsApi.list).toHaveBeenCalledTimes(1));
    rerender({ projectId: 'prj_2' });
    await waitFor(() => expect(result.current.endpoints[0]?.projectId).toBe('prj_2'));
    expect(firstSignal?.aborted).toBe(true);
    await act(async () => resolveFirst?.([endpoint('prj_1')]));
    expect(result.current.endpoints[0]?.projectId).toBe('prj_2');
  });

  it('loads static files for the current Project and aborts cleanup', async () => {
    let signal: AbortSignal | undefined;
    vi.mocked(staticFilesApi.list).mockImplementation((_id, currentSignal) => {
      signal = currentSignal;
      return new Promise(() => undefined);
    });
    const view = render(<StaticFilesView projectId="prj_1" />);
    await waitFor(() => expect(staticFilesApi.list).toHaveBeenCalledWith('prj_1', expect.any(AbortSignal)));
    view.unmount();
    expect(signal?.aborted).toBe(true);
  });
});
