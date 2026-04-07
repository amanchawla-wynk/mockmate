/**
 * Main layout component with header and sidebar
 */

import { useState } from 'react';
import type { ReactNode } from 'react';
import { useProjects } from '../hooks/useProjects';
import { ProjectList, type ViewType } from './ProjectList';
import { ProjectModal } from './ProjectModal';

interface LayoutProps {
  activeView: ViewType;
  onSelectView: (view: ViewType) => void;
  children: (activeProjectId: string | undefined, deactivateProject: () => Promise<void>, activeProject: import('../api/types').Project | undefined, refreshProjects: () => Promise<void>) => ReactNode;
}

export default function Layout({ activeView, onSelectView, children }: LayoutProps) {
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
    <div className="h-screen overflow-hidden bg-white text-gray-900 flex flex-col font-sans">
      {/* Header */}
      <header className="bg-gray-100 border-b border-gray-300 sticky top-0 z-10 flex-shrink-0">
        <div className="px-4 py-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <div className="w-6 h-6 bg-gradient-to-br from-blue-500 to-indigo-600 rounded flex items-center justify-center shadow-sm">
                <span className="text-white font-bold text-xs">M</span>
              </div>
              <h1 className="text-sm font-semibold text-gray-800">MockMate</h1>
            </div>
            <div className="flex items-center space-x-4">
              {error && (
                <span className="text-xs text-red-600">Error: {error}</span>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* Main content */}
      <div className="flex flex-1 min-h-0">
        {/* Sidebar */}
        <aside className="w-64 border-r border-gray-300 flex-shrink-0 flex flex-col min-h-0 bg-[#F3F3F3]">
          <ProjectList
            projects={projects}
            activeProjectId={activeProjectId}
            onSelectProject={activateProject}
            onNewProject={() => setIsModalOpen(true)}
            onDeleteProject={deleteProject}
            loading={loading}
            activeView={activeView}
            onSelectView={onSelectView}
          />
        </aside>

        {/* Main content area */}
        <main className="flex-1 min-w-0 min-h-0 bg-white flex flex-col overflow-hidden">
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
