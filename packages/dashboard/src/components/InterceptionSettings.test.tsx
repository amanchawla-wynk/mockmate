import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiClientError, projectsApi } from '../api/client';
import type { Project, ProjectRuntimeSettings } from '../api/types';
import { useInterceptionGuidance } from '../hooks/useInterceptionGuidance';
import { InterceptionSettings } from './InterceptionSettings';

vi.mock('../api/client', async importOriginal => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  projectsApi: { getRuntimeSettings: vi.fn(), updateRuntimeSettings: vi.fn() },
}));
vi.mock('../hooks/useInterceptionGuidance', () => ({ useInterceptionGuidance: vi.fn() }));

const project: Project = {
  schemaVersion: 4, id: 'prj_1', name: 'Playback', appStateMode: 'enabled', revision: 4,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
};
const settings: ProjectRuntimeSettings = {
  schemaVersion: 4, projectId: 'prj_1', interceptHosts: ['api.example.test'],
  captureRawTraffic: false, debugProvenanceHeaders: true, revision: 9,
};
const refreshGuidance = vi.fn().mockResolvedValue(undefined);

describe('InterceptionSettings', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    refreshGuidance.mockResolvedValue(undefined);
    vi.mocked(projectsApi.getRuntimeSettings).mockResolvedValue(settings);
    vi.mocked(useInterceptionGuidance).mockReturnValue({
      guidance: {
        configuredPatterns: ['api.example.test'],
        origins: [
          { origin: 'https://api.example.test', hostname: 'api.example.test', source: 'endpoint', coveredBy: 'api.example.test', missing: false },
          { origin: 'https://upload.example.test', hostname: 'upload.example.test', source: 'import', missing: true },
        ],
        unusedPatterns: [],
      },
      loading: false,
      refresh: refreshGuidance,
    });
  });

  it('saves exact suggestions and always-on capture in one revisioned command', async () => {
    const saved = { ...settings, interceptHosts: ['api.example.test', 'upload.example.test'], captureRawTraffic: true, revision: 10 };
    vi.mocked(projectsApi.updateRuntimeSettings).mockResolvedValue(saved);
    const onUpdate = vi.fn();
    render(<InterceptionSettings project={project} discoveredOrigins={['https://upload.example.test']} onUpdate={onUpdate} />);
    await screen.findByRole('button', { name: 'Save interception settings' });

    await userEvent.click(screen.getByRole('checkbox', { name: 'Intercept upload.example.test' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save interception settings' }));

    expect(projectsApi.updateRuntimeSettings).toHaveBeenCalledWith('prj_1', {
      interceptHosts: ['api.example.test', 'upload.example.test'],
      captureRawTraffic: true,
      debugProvenanceHeaders: true,
      expectedRevision: 9,
    });
    expect(onUpdate).toHaveBeenCalledOnce();
  });

  it('requires reviewed confirmation for the catch-all pattern', async () => {
    vi.mocked(projectsApi.updateRuntimeSettings).mockResolvedValue({
      ...settings, interceptHosts: ['*'], captureRawTraffic: true, revision: 10,
    });
    render(<InterceptionSettings project={project} onUpdate={vi.fn()} />);
    const input = await screen.findByLabelText('Intercept host patterns');
    fireEvent.change(input, { target: { value: '*' } });

    expect(screen.getByRole('button', { name: 'Save interception settings' })).toBeDisabled();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Confirm intercept all hosts' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save interception settings' }));

    expect(projectsApi.updateRuntimeSettings).toHaveBeenCalledWith('prj_1', {
      interceptHosts: ['*'], captureRawTraffic: true, debugProvenanceHeaders: true,
      expectedRevision: 9, confirmInterceptAll: true,
    });
  });

  it('blocks save while guidance and settings snapshots disagree', async () => {
    vi.mocked(useInterceptionGuidance).mockReturnValue({
      guidance: { configuredPatterns: ['newer.test'], origins: [], unusedPatterns: [] },
      loading: false,
      refresh: refreshGuidance,
    });
    render(<InterceptionSettings project={project} onUpdate={vi.fn()} />);
    const input = await screen.findByLabelText('Intercept host patterns');
    fireEvent.change(input, { target: { value: 'dirty.test' } });

    expect(screen.getByText('Interception guidance is stale')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save interception settings' })).toBeDisabled();
    expect(projectsApi.updateRuntimeSettings).not.toHaveBeenCalled();
  });

  it('blocks save until read-only guidance owns the current settings snapshot', async () => {
    vi.mocked(useInterceptionGuidance).mockReturnValue({
      guidance: undefined,
      loading: true,
      refresh: refreshGuidance,
    });
    render(<InterceptionSettings project={project} onUpdate={vi.fn()} />);
    const input = await screen.findByLabelText('Intercept host patterns');
    fireEvent.change(input, { target: { value: 'dirty.test' } });

    expect(screen.getByRole('button', { name: 'Save interception settings' })).toBeDisabled();
    expect(projectsApi.updateRuntimeSettings).not.toHaveBeenCalled();
  });

  it('preserves reviewed settings choices after a revision conflict', async () => {
    vi.mocked(projectsApi.updateRuntimeSettings).mockRejectedValue(new ApiClientError(
      409, 'REVISION_CONFLICT', 'Settings changed', 'req_settings', undefined,
      { currentRevision: 10 },
    ));
    render(<InterceptionSettings project={project} onUpdate={vi.fn()} />);
    const hosts = await screen.findByLabelText('Intercept host patterns');
    fireEvent.change(hosts, { target: { value: 'api.example.test\nupload.example.test' } });

    await userEvent.click(screen.getByRole('button', { name: 'Save interception settings' }));

    expect(await screen.findByText('Server revision 10')).toBeVisible();
    expect(hosts).toHaveValue('api.example.test\nupload.example.test');
    expect(screen.getByRole('checkbox', { name: 'Debug provenance headers' })).toBeChecked();
    expect(projectsApi.getRuntimeSettings).toHaveBeenCalledTimes(1);
  });

  it('reconciles an unknown save through GET without repeating PUT', async () => {
    const canonical = {
      ...settings,
      captureRawTraffic: true,
      debugProvenanceHeaders: false,
      revision: 10,
    };
    vi.mocked(projectsApi.updateRuntimeSettings).mockRejectedValue(new Error('connection lost'));
    vi.mocked(projectsApi.getRuntimeSettings)
      .mockResolvedValueOnce(settings)
      .mockResolvedValueOnce(canonical);
    const onUpdate = vi.fn();
    render(<InterceptionSettings project={project} onUpdate={onUpdate} />);
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Debug provenance headers' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save interception settings' }));

    await waitFor(() => expect(projectsApi.getRuntimeSettings).toHaveBeenCalledTimes(2));
    expect(projectsApi.updateRuntimeSettings).toHaveBeenCalledTimes(1);
    expect(projectsApi.updateRuntimeSettings).toHaveBeenCalledWith('prj_1', {
      interceptHosts: ['api.example.test'],
      captureRawTraffic: true,
      debugProvenanceHeaders: false,
      expectedRevision: 9,
    });
    expect(onUpdate).toHaveBeenCalledOnce();
  });
});
