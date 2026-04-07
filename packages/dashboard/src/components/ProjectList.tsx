import { useState, useRef, useEffect } from 'react';
import { ConfirmDialog } from './ConfirmDialog';
import type { Project } from '../api/types';

export type ViewType = 'traffic' | 'resources' | 'logs' | 'intercept' | 'files';

interface ProjectListProps {
  projects: Project[];
  activeProjectId: string | undefined;
  onSelectProject: (id: string) => void;
  onNewProject: () => void;
  onDeleteProject: (id: string) => void;
  loading?: boolean;
  activeView?: ViewType;
  onSelectView?: (view: ViewType) => void;
}

export function ProjectList({
  projects,
  activeProjectId,
  onSelectProject,
  onNewProject,
  onDeleteProject,
  loading = false,
  activeView = 'traffic',
  onSelectView,
}: ProjectListProps) {
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [projectToDelete, setProjectToDelete] = useState<Project | null>(null);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const activeProject = projects.find(p => p.id === activeProjectId);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsDropdownOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleDeleteClick = (project: Project) => {
    setProjectToDelete(project);
    setDeleteDialogOpen(true);
    setIsDropdownOpen(false);
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
    <div className="flex flex-col h-full bg-[#F3F3F3]">
      <div className="flex-1 overflow-y-auto py-3">
        {/* Working Session Section */}
        <div className="mb-6">
          <div className="px-3 mb-2">
            <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Working Session</h2>
          </div>
          <ul className="space-y-0.5 px-2">
            {[
              { id: 'traffic', label: 'Traffic', icon: 'M13 10V3L4 14h7v7l9-11h-7z' },
              { id: 'intercept', label: 'Proxy Intercept', icon: 'M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z' },
              { id: 'logs', label: 'Logs', icon: 'M4 6h16M4 10h16M4 14h16M4 18h16' },
            ].map(view => (
              <li key={view.id}>
                <button
                  onClick={() => onSelectView?.(view.id as ViewType)}
                  className={`
                    w-full text-left px-2 py-1.5 flex items-center gap-2 rounded-md transition-colors
                    ${activeView === view.id ? 'bg-blue-500 text-white' : 'text-gray-700 hover:bg-gray-200/60'}
                  `}
                >
                  <svg className={`w-4 h-4 ${activeView === view.id ? 'text-white' : 'text-gray-500'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={view.icon} />
                  </svg>
                  <span className="text-[13px] font-medium">{view.label}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>

        {/* Projects / Workspace Section */}
        <div>
          <div className="px-3 mb-2 flex items-center justify-between">
            <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Workspace</h2>
          </div>
          
          <div className="px-2 mb-2 relative" ref={dropdownRef}>
            <button
              onClick={() => setIsDropdownOpen(!isDropdownOpen)}
              className="w-full text-left px-3 py-1.5 bg-white border border-gray-300 rounded-md shadow-sm flex items-center justify-between hover:bg-gray-50 transition-colors"
            >
              <div className="flex items-center gap-2 min-w-0">
                <svg className="w-4 h-4 text-blue-500 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                  <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
                </svg>
                <span className="text-[13px] font-medium text-gray-900 truncate">
                  {activeProject ? activeProject.name : 'Select a Project...'}
                </span>
              </div>
              <svg className="w-4 h-4 text-gray-400 flex-shrink-0 ml-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            {isDropdownOpen && (
              <div className="absolute top-full left-2 right-2 mt-1 bg-white border border-gray-200 rounded-md shadow-lg z-20 overflow-hidden">
                <div className="max-h-48 overflow-y-auto py-1">
                  {projects.length === 0 ? (
                    <div className="px-3 py-2 text-xs text-gray-500 italic">No projects found</div>
                  ) : (
                    projects.map(project => (
                      <div key={project.id} className="group relative flex items-center justify-between px-3 py-1.5 hover:bg-gray-50">
                        <button
                          onClick={() => {
                            onSelectProject(project.id);
                            setIsDropdownOpen(false);
                          }}
                          className={`flex-1 text-left text-[13px] truncate pr-4 ${project.id === activeProjectId ? 'font-semibold text-blue-600' : 'text-gray-700'}`}
                        >
                          {project.name}
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteClick(project);
                          }}
                          className="absolute right-2 opacity-0 group-hover:opacity-100 p-1 text-gray-400 hover:text-red-600 transition-opacity"
                          title="Delete Project"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                        </button>
                      </div>
                    ))
                  )}
                </div>
                <div className="border-t border-gray-100 p-1">
                  <button
                    onClick={() => {
                      onNewProject();
                      setIsDropdownOpen(false);
                    }}
                    className="w-full text-left px-2 py-1.5 text-[13px] text-blue-600 hover:bg-blue-50 rounded font-medium flex items-center gap-1.5"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                    </svg>
                    New Project
                  </button>
                </div>
              </div>
            )}
          </div>

          {activeProjectId && (
            <ul className="space-y-0.5 px-2 mt-2">
              {[
                {
                  id: 'resources' as ViewType,
                  label: 'Rules',
                  icon: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z',
                },
                {
                  id: 'files' as ViewType,
                  label: 'Static Files',
                  icon: 'M7 4v16M17 4v16M3 8h4m10 0h4M3 12h18M3 16h4m10 0h4M4 20h16a1 1 0 001-1V5a1 1 0 00-1-1H4a1 1 0 00-1 1v14a1 1 0 001 1z',
                },
              ].map(view => (
                <li key={view.id}>
                  <button
                    onClick={() => onSelectView?.(view.id)}
                    className={`
                      w-full text-left px-2 py-1.5 flex items-center gap-2 rounded-md transition-colors
                      ${activeView === view.id ? 'bg-blue-500 text-white' : 'text-gray-700 hover:bg-gray-200/60'}
                    `}
                  >
                    <svg className={`w-4 h-4 ${activeView === view.id ? 'text-white' : 'text-gray-500'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={view.icon} />
                    </svg>
                    <span className="text-[13px] font-medium">{view.label}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="p-3 border-t border-gray-200 flex-shrink-0">
        <a
          href="/setup"
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-2 text-xs font-medium text-gray-600 hover:text-gray-900 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z" />
          </svg>
          Device Setup
        </a>
      </div>

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