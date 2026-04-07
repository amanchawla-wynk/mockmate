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
import { generateId } from '../utils/slugify';
import {
  getResourcesDirectory,
  readJsonFile,
  writeJsonFile,
  deleteFile,
  listFiles,
} from './storage';
import { getProject } from './projects';

function normalizeHost(host?: string): string | undefined {
  const h = (host ?? '').trim().toLowerCase();
  return h.length > 0 ? h : undefined;
}

function normalizeMatch(match?: { query?: Record<string, string>; headers?: Record<string, string> }):
  { query?: Record<string, string>; headers?: Record<string, string> } | undefined {
  if (!match) return undefined;
  const query: Record<string, string> = {};
  const headers: Record<string, string> = {};

  if (match.query) {
    for (const [k, v] of Object.entries(match.query)) {
      const key = (k ?? '').trim();
      const val = (v ?? '').trim();
      if (key && val) query[key] = val;
    }
  }
  if (match.headers) {
    for (const [k, v] of Object.entries(match.headers)) {
      const key = (k ?? '').trim().toLowerCase();
      const val = (v ?? '').trim();
      if (key && val) headers[key] = val;
    }
  }

  const result: { query?: Record<string, string>; headers?: Record<string, string> } = {};
  if (Object.keys(query).length > 0) result.query = query;
  if (Object.keys(headers).length > 0) result.headers = headers;
  return Object.keys(result).length > 0 ? result : undefined;
}

function shallowEqualRecord(a?: Record<string, string>, b?: Record<string, string>): boolean {
  const aKeys = Object.keys(a ?? {});
  const bKeys = Object.keys(b ?? {});
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if ((a ?? {})[k] !== (b ?? {})[k]) return false;
  }
  return true;
}

function shallowEqualMatch(
  a?: { query?: Record<string, string>; headers?: Record<string, string> },
  b?: { query?: Record<string, string>; headers?: Record<string, string> },
): boolean {
  return shallowEqualRecord(a?.query, b?.query) && shallowEqualRecord(a?.headers, b?.headers);
}

function findResourceFilePath(projectSlug: string, resourceId: string): string {
  const resourcesDir = getResourcesDirectory(projectSlug);
  const files = listFiles(resourcesDir).filter(f => f.endsWith('.json'));

  for (const file of files) {
    const filePath = path.join(resourcesDir, file);
    try {
      const resource = readJsonFile<Resource>(filePath);
      if (resource.id === resourceId) {
        return filePath;
      }
    } catch {
      // ignore invalid resource files
    }
  }

  throw new Error(`Resource file for ID "${resourceId}" not found`);
}

/**
 * Create a new resource with default scenario
 */
export function createResource(
  projectId: string,
  request: CreateResourceRequest
): Resource {
  const { method, host, path: resourcePath, description, match } = request;

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

  const normalizedHost = normalizeHost(host);
  const normalizedMatch = normalizeMatch(match);

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
    host: normalizedHost,
    path: resourcePath,
    match: normalizedMatch,
    description,
    scenarios: [defaultScenario],
    createdAt: now,
    updatedAt: now,
  };

  // Save resource to file
  const resourcesDir = getResourcesDirectory(project.slug);

  // Check if an identical rule already exists (same method/host/path/match)
  const existing = listResources(projectId).find(r =>
    r.method === method &&
    normalizeHost(r.host) === normalizedHost &&
    r.path === resourcePath &&
    shallowEqualMatch(normalizeMatch(r.match), normalizedMatch)
  );
  if (existing) {
    throw new Error(`Resource rule already exists for ${method} ${normalizedHost ? normalizedHost + ' ' : ''}${resourcePath}`);
  }

  const filePath = path.join(resourcesDir, `${resource.id}.json`);
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
  const filePath = findResourceFilePath(project.slug, resourceId);

  // Apply updates
  const updatedResource: Resource = {
    ...resource,
    method: updates.method ?? resource.method,
    host: updates.host !== undefined ? normalizeHost(updates.host) : resource.host,
    path: updates.path ?? resource.path,
    description: updates.description ?? resource.description,
    passthrough: updates.passthrough ?? resource.passthrough,
    match: updates.match !== undefined ? normalizeMatch(updates.match) : resource.match,
    updatedAt: new Date().toISOString(),
  };

  // Validate path if updated
  if (updates.path && !updates.path.startsWith('/')) {
    throw new Error('Path must start with /');
  }

  // Prevent conflicting identical rules
  const updatedHost = normalizeHost(updatedResource.host);
  const updatedMatch = normalizeMatch(updatedResource.match);
  const conflict = listResources(projectId).find(r =>
    r.id !== resourceId &&
    r.method === updatedResource.method &&
    normalizeHost(r.host) === updatedHost &&
    r.path === updatedResource.path &&
    shallowEqualMatch(normalizeMatch(r.match), updatedMatch)
  );
  if (conflict) {
    throw new Error(`Resource ${updatedResource.method} ${updatedHost ? updatedHost + ' ' : ''}${updatedResource.path} already exists`);
  }

  // Just update the existing file (resource files are keyed by id)
  writeJsonFile(filePath, updatedResource);

  return updatedResource;
}

/**
 * Delete resource
 */
export function deleteResource(projectId: string, resourceId: string): void {
  const project = getProject(projectId);
  const filePath = findResourceFilePath(project.slug, resourceId);
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
    fixture: request.fixture,
    headers: request.headers ?? {},
    responseHeaders: request.responseHeaders,
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
  const filePath = findResourceFilePath(project.slug, resourceId);
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
    fixture: updates.fixture ?? updatedScenarios[scenarioIndex].fixture,
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
  const filePath = findResourceFilePath(project.slug, resourceId);
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
  const filePath = findResourceFilePath(project.slug, resourceId);
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
  const filePath = findResourceFilePath(project.slug, resourceId);
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
