/**
 * Main layout component with header and sidebar
 */

import { ReactNode, useState } from 'react';
import { useProjects } from '../hooks/useProjects';
import { ProjectList } from './ProjectList';
import { ProjectModal } from './ProjectModal';

interface LayoutProps {
  children: (activeProjectId: string | undefined, deactivateProject: () => Promise<void>, activeProject: import('../api/types').Project | undefined, refreshProjects: () => Promise<void>) => ReactNode;
}

export default function Layout({ children }: LayoutProps) {
  const {
    projects,
    activeProjectId,
    loading,
    error,
    refresh,
    createProject,
    activateProject,
    deactivateProject,
    deleteProject,
  } = useProjects();

  const [isModalOpen, setIsModalOpen] = useState(false);

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 sticky top-0 z-10">
        <div className="px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center">
                <span className="text-white font-bold text-sm">M</span>
              </div>
              <h1 className="text-xl font-bold text-gray-900">MockMate</h1>
            </div>
            <div className="flex items-center space-x-4">
              {error && (
                <span className="text-sm text-red-600">Error: {error}</span>
              )}
              <span className="text-sm text-gray-500">Local Mock API Server</span>
            </div>
          </div>
        </div>
      </header>

      {/* Main content */}
      <div className="flex">
        {/* Sidebar */}
        <aside className="w-64 bg-white border-r border-gray-200 min-h-[calc(100vh-73px)]">
          <ProjectList
            projects={projects}
            activeProjectId={activeProjectId}
            onSelectProject={activateProject}
            onNewProject={() => setIsModalOpen(true)}
            onDeleteProject={deleteProject}
            loading={loading}
          />
        </aside>

        {/* Main content area */}
        <main className="flex-1 p-6">
          {children(activeProjectId, deactivateProject, projects.find(p => p.id === activeProjectId), refresh)}
        </main>
      </div>

      {/* Project Modal */}
      <ProjectModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onSubmit={async (data) => {
          await createProject(data);
        }}
      />
    </div>
  );
}
