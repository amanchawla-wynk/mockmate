import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ProjectSummary } from '../api/types';
import { ProjectList } from './ProjectList';
import { ProjectModal } from './ProjectModal';

const projects: ProjectSummary[] = [
  { id: 'active', name: 'Active Project', revision: 2, updatedAt: '2026-01-01T00:00:00.000Z' },
  { id: 'inactive', name: 'Inactive Project', revision: 1, updatedAt: '2026-01-01T00:00:00.000Z' },
];

function setup() {
  const onDeleteProject = vi.fn();
  const onNewProject = vi.fn();
  const onAttemptNavigation = vi.fn((action: () => void, affectsMountedEditor = true) => {
    if (!affectsMountedEditor) action();
  });
  render(
    <ProjectList
      projects={projects}
      activeProjectId="active"
      onSelectProject={vi.fn()}
      onNewProject={onNewProject}
      onDeleteProject={onDeleteProject}
      activeView="endpoints"
      onSelectView={vi.fn()}
      onAttemptNavigation={onAttemptNavigation}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: /Active Project/ }));
  return { onDeleteProject, onNewProject, onAttemptNavigation };
}

function deleteAt(index: number) {
  fireEvent.click(screen.getAllByTitle('Delete Project')[index]);
  const buttons = screen.getAllByRole('button', { name: 'Delete Project' });
  fireEvent.click(buttons.at(-1)!);
}

describe('ProjectList deletion boundaries', () => {
  it('creates Projects without an origin field', () => {
    render(<ProjectModal isOpen onClose={vi.fn()} onSubmit={vi.fn()} />);

    expect(screen.getByLabelText('Project Name')).toBeVisible();
    expect(screen.queryByLabelText(/base url/i)).not.toBeInTheDocument();
  });

  it('deletes an inactive Project without consuming the active editor draft', () => {
    const result = setup();
    deleteAt(1);
    expect(result.onDeleteProject).toHaveBeenCalledWith('inactive');
    expect(result.onAttemptNavigation).toHaveBeenCalledWith(expect.any(Function), false);
  });

  it('guards deletion of the active Project', () => {
    const result = setup();
    deleteAt(0);
    expect(result.onDeleteProject).not.toHaveBeenCalled();
    const [action] = result.onAttemptNavigation.mock.calls[0];
    action();
    expect(result.onDeleteProject).toHaveBeenCalledWith('active');
  });

  it('guards creating and selecting a new Project', () => {
    const result = setup();
    fireEvent.click(screen.getByRole('button', { name: 'New Project' }));
    expect(result.onNewProject).not.toHaveBeenCalled();
    const [action] = result.onAttemptNavigation.mock.calls[0];
    action();
    expect(result.onNewProject).toHaveBeenCalledOnce();
  });
});
