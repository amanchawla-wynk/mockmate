import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { endpointsApi } from '../api/client';
import type { EndpointDetail, Project } from '../api/types';
import { EndpointEditor } from './EndpointEditor';

vi.mock('../api/client', () => ({
  bodiesApi: {}, variantsApi: {},
  endpointsApi: { setMode: vi.fn(), update: vi.fn() },
}));

const project: Project = {
  schemaVersion: 4, id: 'prj_1', name: 'Project', appStateMode: 'enabled',
  revision: 4, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
};
const endpoint: EndpointDetail = {
  schemaVersion: 4, id: 'ep_1', projectId: project.id, name: 'Users', description: 'Clear me',
  baseUrl: 'https://api.example.test', matcher: { method: 'GET', path: '/users' }, mode: 'mock', defaultVariantId: 'var_1',
  variants: [{ id: 'var_1', endpointId: 'ep_1', name: 'OK', status: 200, responseHeaders: {}, revision: 1 }],
  revision: 2,
};

describe('canonical revisioned update forms', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends null when an Endpoint description is deliberately cleared', async () => {
    const user = userEvent.setup();
    vi.mocked(endpointsApi.update).mockResolvedValue({ ...endpoint, description: undefined });
    render(<EndpointEditor projectId={project.id} endpoint={endpoint} onEndpointSaveStarted={() => vi.fn(() => true)} onSaved={vi.fn()} onDeleted={vi.fn()} onClose={vi.fn()} />);
    await user.clear(screen.getByLabelText('Endpoint description'));
    await user.click(screen.getByRole('button', { name: 'Save Endpoint' }));
    expect(endpointsApi.update).toHaveBeenCalledWith(project.id, endpoint.id, 2, expect.objectContaining({ description: null }));
  });
});
