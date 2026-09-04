import { useState, type ReactNode } from 'react';
import { useProjects } from '../hooks/useProjects';
import type { Project } from '../api/types';
import { ProjectList, type ViewType } from './ProjectList';
import { ProjectModal } from './ProjectModal';

interface LayoutProps {
  activeView: ViewType;
  onSelectView(view: ViewType): void;
  onAttemptNavigation(action: () => void, affectsActiveProject?: boolean): void;
  children(activeProject: Project | undefined, refreshProjects: () => Promise<void>): ReactNode;
}

export default function Layout({ activeView, onSelectView, onAttemptNavigation, children }: LayoutProps) {
  const projects = useProjects();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const activeProjectId = projects.workspace?.activeProjectId;

  const selectProject = async (projectId: string) => {
    if (!projects.workspace || projectId === activeProjectId) return;
    await projects.setActive(projectId, projects.workspace.revision);
  };

  const deleteProject = async (projectId: string) => {
    const project = projects.projects.find(candidate => candidate.id === projectId);
    if (!project || !projects.workspace) return;
    if (activeProjectId === projectId) {
      await projects.setActive(null, projects.workspace.revision);
    }
    await projects.remove(projectId, project.revision);
  };

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-white font-sans text-gray-900">
      <header className="flex-shrink-0 border-b border-gray-300 bg-gray-100">
        <div className="flex items-center justify-between px-4 py-2">
          <div className="flex items-center gap-3">
            <div className="flex h-6 w-6 items-center justify-center rounded bg-gradient-to-br from-blue-500 to-indigo-600 text-xs font-bold text-white shadow-sm">M</div>
            <h1 className="text-sm font-semibold text-gray-800">MockMate</h1>
          </div>
          {projects.error ? <span className="text-xs text-red-700">{projects.error.message}</span> : null}
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-64 flex-shrink-0 flex-col border-r border-gray-300 bg-[#F3F3F3]">
          <ProjectList
            projects={projects.projects}
            activeProjectId={activeProjectId}
            onSelectProject={projectId => void selectProject(projectId)}
            onNewProject={() => setIsModalOpen(true)}
            onDeleteProject={projectId => void deleteProject(projectId)}
            loading={projects.loading}
            activeView={activeView}
            onSelectView={onSelectView}
            onAttemptNavigation={onAttemptNavigation}
          />
        </aside>
        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-white">
          {children(projects.activeProject, projects.refresh)}
        </main>
      </div>
      <ProjectModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onSubmit={async input => {
          const created = await projects.create(input);
          const workspace = projects.workspace;
          if (workspace) await projects.setActive(created.id, workspace.revision);
        }}
      />
    </div>
  );
}
