/**
 * Resource and Scenario management service
 * Handles CRUD operations for resources and scenarios
 */

import * as path from 'path';
import type {
  Resource,
  Scenario,
  CreateResourceRequest,
  UpdateResourceRequest,
  CreateScenarioRequest,
  UpdateScenarioRequest,
} from '../types';
import { generateId, generateResourceFilename } from '../utils/slugify';
import {
  getResourcesDirectory,
  readJsonFile,
  writeJsonFile,
  deleteFile,
  listFiles,
} from './storage';
import { getProject } from './projects';

/**
 * Create a new resource with default scenario
 */
export function createResource(
  projectId: string,
  request: CreateResourceRequest
): Resource {
  const { method, path: resourcePath, description } = request;

  // Validate project exists
  const project = getProject(projectId);

  // Validate required fields
  if (!method || !resourcePath) {
    throw new Error('Method and path are required');
  }

  // Validate path format
  if (!resourcePath.startsWith('/')) {
    throw new Error('Path must start with /');
  }

  // Generate resource
  const now = new Date().toISOString();
  const defaultScenario: Scenario = {
    name: 'default',
    statusCode: 200,
    body: {},
    headers: {},
    delay: 0,
  };

  const resource: Resource = {
    id: generateId('res'),
    method,
    path: resourcePath,
    description,
    scenarios: [defaultScenario],
    createdAt: now,
    updatedAt: now,
  };

  // Save resource to file
  const resourcesDir = getResourcesDirectory(project.slug);
  const filename = generateResourceFilename(method, resourcePath);
  const filePath = path.join(resourcesDir, filename);

  // Check if resource already exists
  if (require('fs').existsSync(filePath)) {
    throw new Error(`Resource ${method} ${resourcePath} already exists in this project`);
  }

  writeJsonFile(filePath, resource);

  return resource;
}

/**
 * List all resources for a project
 */
export function listResources(projectId: string): Resource[] {
  const project = getProject(projectId);
  const resourcesDir = getResourcesDirectory(project.slug);
  const files = listFiles(resourcesDir);

  const resources: Resource[] = [];

  for (const file of files) {
    if (!file.endsWith('.json')) {
      continue;
    }

    try {
      const filePath = path.join(resourcesDir, file);
      const resource = readJsonFile<Resource>(filePath);
      resources.push(resource);
    } catch (error) {
      console.warn(`Failed to load resource "${file}":`, (error as Error).message);
    }
  }

  // Sort by creation date (newest first)
  return resources.sort((a, b) =>
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}

/**
 * Get resource by ID
 */
export function getResource(projectId: string, resourceId: string): Resource {
  const resources = listResources(projectId);
  const resource = resources.find(r => r.id === resourceId);

  if (!resource) {
    throw new Error(`Resource with ID "${resourceId}" not found`);
  }

  return resource;
}

/**
 * Update resource
 */
export function updateResource(
  projectId: string,
  resourceId: string,
  updates: UpdateResourceRequest
): Resource {
  const project = getProject(projectId);
  const resource = getResource(projectId, resourceId);
  const resourcesDir = getResourcesDirectory(project.slug);

  // Calculate old and potentially new file paths
  const oldFilename = generateResourceFilename(resource.method, resource.path);
  const oldFilePath = path.join(resourcesDir, oldFilename);

  // Apply updates
  const updatedResource: Resource = {
    ...resource,
    method: updates.method ?? resource.method,
    path: updates.path ?? resource.path,
    description: updates.description ?? resource.description,
    updatedAt: new Date().toISOString(),
  };

  // Validate path if updated
  if (updates.path && !updates.path.startsWith('/')) {
    throw new Error('Path must start with /');
  }

  // If method or path changed, we need to rename the file
  if (updates.method || updates.path) {
    const newFilename = generateResourceFilename(
      updatedResource.method,
      updatedResource.path
    );
    const newFilePath = path.join(resourcesDir, newFilename);

    // Check if new filename conflicts with existing resource
    if (newFilename !== oldFilename && require('fs').existsSync(newFilePath)) {
      throw new Error(
        `Resource ${updatedResource.method} ${updatedResource.path} already exists`
      );
    }

    // Delete old file and write to new location
    deleteFile(oldFilePath);
    writeJsonFile(newFilePath, updatedResource);
  } else {
    // Just update the existing file
    writeJsonFile(oldFilePath, updatedResource);
  }

  return updatedResource;
}

/**
 * Delete resource
 */
export function deleteResource(projectId: string, resourceId: string): void {
  const project = getProject(projectId);
  const resource = getResource(projectId, resourceId);
  const resourcesDir = getResourcesDirectory(project.slug);

  const filename = generateResourceFilename(resource.method, resource.path);
  const filePath = path.join(resourcesDir, filename);

  deleteFile(filePath);
}

/**
 * Add scenario to resource
 */
export function addScenario(
  projectId: string,
  resourceId: string,
  request: CreateScenarioRequest
): Resource {
  const resource = getResource(projectId, resourceId);

  // Validate scenario name
  if (!request.name || request.name.trim().length === 0) {
    throw new Error('Scenario name is required');
  }

  // Check if scenario already exists
  if (resource.scenarios.some(s => s.name === request.name)) {
    throw new Error(`Scenario "${request.name}" already exists`);
  }

  // Create new scenario
  const newScenario: Scenario = {
    name: request.name.trim(),
    statusCode: request.statusCode ?? 200,
    body: request.body ?? {},
    headers: request.headers ?? {},
    delay: request.delay ?? 0,
  };

  // Add scenario to resource
  const updatedResource: Resource = {
    ...resource,
    scenarios: [...resource.scenarios, newScenario],
    updatedAt: new Date().toISOString(),
  };

  // Save updated resource
  const project = getProject(projectId);
  const resourcesDir = getResourcesDirectory(project.slug);
  const filename = generateResourceFilename(resource.method, resource.path);
  const filePath = path.join(resourcesDir, filename);

  writeJsonFile(filePath, updatedResource);

  return updatedResource;
}

/**
 * Update scenario
 */
export function updateScenario(
  projectId: string,
  resourceId: string,
  scenarioName: string,
  updates: UpdateScenarioRequest
): Resource {
  const resource = getResource(projectId, resourceId);

  // Find scenario
  const scenarioIndex = resource.scenarios.findIndex(s => s.name === scenarioName);
  if (scenarioIndex === -1) {
    throw new Error(`Scenario "${scenarioName}" not found`);
  }

  // Update scenario
  const updatedScenarios = [...resource.scenarios];
  updatedScenarios[scenarioIndex] = {
    ...updatedScenarios[scenarioIndex],
    statusCode: updates.statusCode ?? updatedScenarios[scenarioIndex].statusCode,
    body: updates.body ?? updatedScenarios[scenarioIndex].body,
    headers: updates.headers ?? updatedScenarios[scenarioIndex].headers,
    responseHeaders: updates.responseHeaders ?? updatedScenarios[scenarioIndex].responseHeaders,
    requestBody: updates.requestBody ?? updatedScenarios[scenarioIndex].requestBody,
    queryParams: updates.queryParams ?? updatedScenarios[scenarioIndex].queryParams,
    delay: updates.delay ?? updatedScenarios[scenarioIndex].delay,
  };

  const updatedResource: Resource = {
    ...resource,
    scenarios: updatedScenarios,
    updatedAt: new Date().toISOString(),
  };

  // Save updated resource
  const project = getProject(projectId);
  const resourcesDir = getResourcesDirectory(project.slug);
  const filename = generateResourceFilename(resource.method, resource.path);
  const filePath = path.join(resourcesDir, filename);

  writeJsonFile(filePath, updatedResource);

  return updatedResource;
}

/**
 * Delete scenario (protects "default" scenario)
 */
export function deleteScenario(
  projectId: string,
  resourceId: string,
  scenarioName: string
): Resource {
  // Protect default scenario
  if (scenarioName === 'default') {
    throw new Error('Cannot delete the "default" scenario');
  }

  const resource = getResource(projectId, resourceId);

  // Find scenario
  const scenarioIndex = resource.scenarios.findIndex(s => s.name === scenarioName);
  if (scenarioIndex === -1) {
    throw new Error(`Scenario "${scenarioName}" not found`);
  }

  // Remove scenario
  const updatedScenarios = resource.scenarios.filter(s => s.name !== scenarioName);

  const updatedResource: Resource = {
    ...resource,
    scenarios: updatedScenarios,
    updatedAt: new Date().toISOString(),
  };

  // Save updated resource
  const project = getProject(projectId);
  const resourcesDir = getResourcesDirectory(project.slug);
  const filename = generateResourceFilename(resource.method, resource.path);
  const filePath = path.join(resourcesDir, filename);

  writeJsonFile(filePath, updatedResource);

  return updatedResource;
}

/**
 * Duplicate scenario
 */
export function duplicateScenario(
  projectId: string,
  resourceId: string,
  scenarioName: string,
  newName: string
): Resource {
  const resource = getResource(projectId, resourceId);

  // Find source scenario
  const sourceScenario = resource.scenarios.find(s => s.name === scenarioName);
  if (!sourceScenario) {
    throw new Error(`Scenario "${scenarioName}" not found`);
  }

  // Check if new name already exists
  if (resource.scenarios.some(s => s.name === newName)) {
    throw new Error(`Scenario "${newName}" already exists`);
  }

  // Create duplicate
  const duplicatedScenario: Scenario = {
    ...sourceScenario,
    name: newName.trim(),
  };

  const updatedResource: Resource = {
    ...resource,
    scenarios: [...resource.scenarios, duplicatedScenario],
    updatedAt: new Date().toISOString(),
  };

  // Save updated resource
  const project = getProject(projectId);
  const resourcesDir = getResourcesDirectory(project.slug);
  const filename = generateResourceFilename(resource.method, resource.path);
  const filePath = path.join(resourcesDir, filename);

  writeJsonFile(filePath, updatedResource);

  return updatedResource;
}

/**
 * Get scenario from resource (with fallback to default)
 */
export function getScenario(
  resource: Resource,
  scenarioName: string
): Scenario {
  // Try to find requested scenario
  const scenario = resource.scenarios.find(s => s.name === scenarioName);
  if (scenario) {
    return scenario;
  }

  // Fallback to default
  const defaultScenario = resource.scenarios.find(s => s.name === 'default');
  if (defaultScenario) {
    return defaultScenario;
  }

  // Should never happen, but provide a safe fallback
  return {
    name: 'default',
    statusCode: 200,
    body: {},
    headers: {},
    delay: 0,
  };
}
