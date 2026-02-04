/**
 * Project management service
 * Handles CRUD operations for projects
 */

import * as path from 'path';
import type { Project, CreateProjectRequest, UpdateProjectRequest } from '../types';
import { slugify, generateId } from '../utils/slugify';
import {
  getStorageConfig,
  ensureProjectDirectory,
  getProjectDirectory,
  projectExists,
  listProjectDirectories,
  deleteProjectDirectory,
  readJsonFile,
  writeJsonFile,
  readConfig,
  writeConfig,
} from './storage';

/**
 * Create a new project
 * @throws Error if project with same name already exists
 */
export function createProject(request: CreateProjectRequest): Project {
  const { name, description, baseUrl } = request;

  // Validate name
  if (!name || name.trim().length === 0) {
    throw new Error('Project name is required');
  }

  // Generate slug and check for duplicates
  const slug = slugify(name);
  if (!slug) {
    throw new Error('Project name must contain valid characters');
  }

  // Check if project with same slug already exists
  if (projectExists(slug)) {
    throw new Error(`Project with name "${name}" already exists`);
  }

  // Generate project
  const now = new Date().toISOString();
  const project: Project = {
    id: generateId('proj'),
    name: name.trim(),
    slug,
    description: description?.trim(),
    activeScenario: 'default',
    baseUrl: baseUrl?.trim(),
    environmentVariables: [],
    createdAt: now,
    updatedAt: now,
  };

  // Create project directory
  ensureProjectDirectory(slug);

  // Save project metadata
  const projectDir = getProjectDirectory(slug);
  const projectFile = path.join(projectDir, 'project.json');
  writeJsonFile(projectFile, project);

  return project;
}

/**
 * List all projects
 */
export function listProjects(): Project[] {
  const slugs = listProjectDirectories();
  const projects: Project[] = [];

  for (const slug of slugs) {
    try {
      const project = getProjectBySlug(slug);
      projects.push(project);
    } catch (error) {
      // Skip invalid projects
      console.warn(`Failed to load project "${slug}":`, (error as Error).message);
    }
  }

  // Sort by creation date (newest first)
  return projects.sort((a, b) =>
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}

/**
 * Get project by ID
 * @throws Error if project not found
 */
export function getProject(id: string): Project {
  const projects = listProjects();
  const project = projects.find(p => p.id === id);

  if (!project) {
    throw new Error(`Project with ID "${id}" not found`);
  }

  return project;
}

/**
 * Get project by slug (internal helper)
 * @throws Error if project not found
 */
function getProjectBySlug(slug: string): Project {
  const projectDir = getProjectDirectory(slug);
  const projectFile = path.join(projectDir, 'project.json');

  return readJsonFile<Project>(projectFile);
}

/**
 * Update project
 * @throws Error if project not found
 */
export function updateProject(id: string, updates: UpdateProjectRequest): Project {
  const project = getProject(id);
  const projectDir = getProjectDirectory(project.slug);
  const projectFile = path.join(projectDir, 'project.json');

  // Apply updates
  const updatedProject: Project = {
    ...project,
    name: updates.name?.trim() ?? project.name,
    description: updates.description?.trim() ?? project.description,
    activeScenario: updates.activeScenario ?? project.activeScenario,
    baseUrl: updates.baseUrl?.trim() ?? project.baseUrl,
    environmentVariables: updates.environmentVariables ?? project.environmentVariables,
    updatedAt: new Date().toISOString(),
  };

  // If name changed, validate new slug doesn't conflict
  if (updates.name && updates.name !== project.name) {
    const newSlug = slugify(updates.name);
    if (!newSlug) {
      throw new Error('Project name must contain valid characters');
    }

    // Check if new slug conflicts with existing project
    if (newSlug !== project.slug && projectExists(newSlug)) {
      throw new Error(`Project with name "${updates.name}" already exists`);
    }

    // If slug changed, we need to rename the directory
    if (newSlug !== project.slug) {
      const config = getStorageConfig();
      const oldDir = getProjectDirectory(project.slug);
      const newDir = path.join(config.projectsDir, newSlug);

      // Rename directory
      const fs = require('fs');
      fs.renameSync(oldDir, newDir);

      // Update slug in project
      updatedProject.slug = newSlug;

      // Update active project in global config if this was active
      const globalConfig = readConfig();
      if (globalConfig.activeProjectId === project.id) {
        // Config doesn't store slug, just verify it's still the same project
      }
    }
  }

  // Save updated project
  const finalProjectFile = path.join(getProjectDirectory(updatedProject.slug), 'project.json');
  writeJsonFile(finalProjectFile, updatedProject);

  return updatedProject;
}

/**
 * Delete project and all its resources
 * @throws Error if project not found
 */
export function deleteProject(id: string): void {
  const project = getProject(id);

  // Clear from active project if it's currently active
  const config = readConfig();
  if (config.activeProjectId === id) {
    config.activeProjectId = undefined;
    writeConfig(config);
  }

  // Delete project directory and all contents
  deleteProjectDirectory(project.slug);
}

/**
 * Set the active project
 * @throws Error if project not found
 */
export function setActiveProject(id: string): void {
  // Verify project exists
  getProject(id);

  // Update global config
  const config = readConfig();
  config.activeProjectId = id;
  writeConfig(config);
}

/**
 * Get the currently active project
 * @returns Active project or null if none set
 */
export function getActiveProject(): Project | null {
  const config = readConfig();

  if (!config.activeProjectId) {
    return null;
  }

  try {
    return getProject(config.activeProjectId);
  } catch (error) {
    // Active project was deleted, clear it
    config.activeProjectId = undefined;
    writeConfig(config);
    return null;
  }
}
