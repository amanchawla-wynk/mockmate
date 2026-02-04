/**
 * ProjectList component - displays projects in the sidebar
 */

import { useState } from 'react';
import { ConfirmDialog } from './ConfirmDialog';
import type { Project } from '../api/types';

interface ProjectListProps {
  projects: Project[];
  activeProjectId: string | undefined;
  onSelectProject: (id: string) => void;
  onNewProject: () => void;
  onDeleteProject: (id: string) => void;
  loading?: boolean;
}

export function ProjectList({
  projects,
  activeProjectId,
  onSelectProject,
  onNewProject,
  onDeleteProject,
  loading = false,
}: ProjectListProps) {
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [projectToDelete, setProjectToDelete] = useState<Project | null>(null);

  const handleDeleteClick = (project: Project) => {
    setProjectToDelete(project);
    setDeleteDialogOpen(true);
  };

  const confirmDelete = () => {
    if (projectToDelete) {
      onDeleteProject(projectToDelete.id);
      setDeleteDialogOpen(false);
      setProjectToDelete(null);
    }
  };

  if (loading) {
    return (
      <div className="p-4">
        <div className="animate-pulse">
          <div className="h-4 bg-gray-300 rounded w-3/4 mb-4"></div>
          <div className="h-8 bg-gray-200 rounded mb-2"></div>
          <div className="h-8 bg-gray-200 rounded mb-2"></div>
          <div className="h-8 bg-gray-200 rounded"></div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="p-4 border-b border-gray-200">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wider">
            Projects
          </h2>
          <button
            onClick={onNewProject}
            className="px-3 py-1 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors"
            aria-label="Create new project"
          >
            + New
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {projects.length === 0 ? (
          <div className="p-4 text-center text-gray-500 text-sm">
            No projects yet. Create one to get started.
          </div>
        ) : (
          <ul className="py-2">
            {projects.map((project) => {
              const isActive = project.id === activeProjectId;

              return (
                <li
                  key={project.id}
                  className={`
                    group relative mx-2 mb-1 rounded-lg transition-colors
                    ${isActive
                      ? 'bg-blue-50 border border-blue-200'
                      : 'hover:bg-gray-100 border border-transparent'
                    }
                  `}
                >
                  <button
                    onClick={() => onSelectProject(project.id)}
                    className="w-full text-left px-3 py-2 flex items-center justify-between"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <h3 className={`
                          text-sm font-medium truncate
                          ${isActive ? 'text-blue-900' : 'text-gray-900'}
                        `}>
                          {project.name}
                        </h3>
                        {isActive && (
                          <span className="flex-shrink-0 text-xs bg-blue-600 text-white px-2 py-0.5 rounded">
                            Active
                          </span>
                        )}
                      </div>
                      {project.description && (
                        <p className={`
                          text-xs mt-0.5 truncate
                          ${isActive ? 'text-blue-700' : 'text-gray-500'}
                        `}>
                          {project.description}
                        </p>
                      )}
                    </div>
                  </button>

                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteClick(project);
                    }}
                    className={`
                      absolute right-2 top-1/2 -translate-y-1/2
                      opacity-0 group-hover:opacity-100
                      p-1 text-red-600 hover:text-red-800 hover:bg-red-50 rounded
                      transition-opacity
                    `}
                    aria-label={`Delete ${project.name}`}
                  >
                    <svg
                      className="w-4 h-4"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                      />
                    </svg>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {projects.length > 0 && (
        <div className="p-3 border-t border-gray-200 text-xs text-gray-500">
          {projects.length} {projects.length === 1 ? 'project' : 'projects'}
        </div>
      )}

      {/* Delete Project Dialog */}
      <ConfirmDialog
        isOpen={deleteDialogOpen}
        title="Delete Project"
        message={projectToDelete ? `Delete project "${projectToDelete.name}"?\n\nThis will permanently delete:\n• All resources in this project\n• All scenarios for those resources\n• All project data\n\nThis action cannot be undone.` : ''}
        confirmLabel="Delete Project"
        variant="danger"
        onConfirm={confirmDelete}
        onCancel={() => {
          setDeleteDialogOpen(false);
          setProjectToDelete(null);
        }}
      />
    </div>
  );
}
