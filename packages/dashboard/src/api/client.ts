/**
 * API client for MockMate backend
 */

import type {
  Project,
  Resource,
  CreateProjectRequest,
  UpdateProjectRequest,
  CreateResourceRequest,
  UpdateResourceRequest,
  CreateScenarioRequest,
  UpdateScenarioRequest,
  RequestLogEntry,
  ServerStatus,
  ListProjectsResponse,
  ImportCurlRequest,
  ImportPostmanRequest,
  ImportResponse,
  ImportProjectResponse,
} from './types';

const API_BASE = '/api/admin';

class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new ApiError(response.status, error.error || 'Request failed');
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json();
}

// Projects
export const projectsApi = {
  list: () => fetchJson<ListProjectsResponse>(`${API_BASE}/projects`),

  create: (data: CreateProjectRequest) =>
    fetchJson<Project>(`${API_BASE}/projects`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  get: (id: string) => fetchJson<Project>(`${API_BASE}/projects/${id}`),

  update: (id: string, data: UpdateProjectRequest) =>
    fetchJson<Project>(`${API_BASE}/projects/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  delete: (id: string) =>
    fetchJson<void>(`${API_BASE}/projects/${id}`, {
      method: 'DELETE',
    }),

  activate: (id: string) =>
    fetchJson<Project>(`${API_BASE}/projects/${id}/activate`, {
      method: 'PUT',
    }),

  deactivate: () =>
    fetchJson<void>(`${API_BASE}/projects/active`, {
      method: 'DELETE',
    }),

  switchScenario: (id: string, scenario: string) =>
    fetchJson<Project>(`${API_BASE}/projects/${id}/scenario`, {
      method: 'PUT',
      body: JSON.stringify({ scenario }),
    }),
};

// Resources
export const resourcesApi = {
  list: (projectId: string) =>
    fetchJson<Resource[]>(`${API_BASE}/projects/${projectId}/resources`),

  create: (projectId: string, data: CreateResourceRequest) =>
    fetchJson<Resource>(`${API_BASE}/projects/${projectId}/resources`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  get: (projectId: string, resourceId: string) =>
    fetchJson<Resource>(`${API_BASE}/projects/${projectId}/resources/${resourceId}`),

  update: (projectId: string, resourceId: string, data: UpdateResourceRequest) =>
    fetchJson<Resource>(`${API_BASE}/projects/${projectId}/resources/${resourceId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  delete: (projectId: string, resourceId: string) =>
    fetchJson<void>(`${API_BASE}/projects/${projectId}/resources/${resourceId}`, {
      method: 'DELETE',
    }),
};

// Scenarios
export const scenariosApi = {
  add: (projectId: string, resourceId: string, data: CreateScenarioRequest) =>
    fetchJson<Resource>(`${API_BASE}/projects/${projectId}/resources/${resourceId}/scenarios`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  update: (
    projectId: string,
    resourceId: string,
    scenarioName: string,
    data: UpdateScenarioRequest
  ) =>
    fetchJson<Resource>(
      `${API_BASE}/projects/${projectId}/resources/${resourceId}/scenarios/${scenarioName}`,
      {
        method: 'PUT',
        body: JSON.stringify(data),
      }
    ),

  delete: (projectId: string, resourceId: string, scenarioName: string) =>
    fetchJson<Resource>(
      `${API_BASE}/projects/${projectId}/resources/${resourceId}/scenarios/${scenarioName}`,
      {
        method: 'DELETE',
      }
    ),

  duplicate: (projectId: string, resourceId: string, scenarioName: string, newName: string) =>
    fetchJson<Resource>(
      `${API_BASE}/projects/${projectId}/resources/${resourceId}/scenarios/${scenarioName}/duplicate`,
      {
        method: 'POST',
        body: JSON.stringify({ newName }),
      }
    ),
};

// Server
export const serverApi = {
  status: () => fetchJson<ServerStatus>(`${API_BASE}/status`),
  logs: () => fetchJson<RequestLogEntry[]>(`${API_BASE}/logs`),
  clearLogs: () => fetchJson<void>(`${API_BASE}/logs`, { method: 'DELETE' }),
};

// Import
export const importApi = {
  importCurl: (projectId: string, data: ImportCurlRequest) =>
    fetchJson<ImportResponse>(`${API_BASE}/projects/${projectId}/import/curl`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  importPostman: (projectId: string, data: ImportPostmanRequest) =>
    fetchJson<ImportResponse>(`${API_BASE}/projects/${projectId}/import/postman`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  importPostmanAsProject: (data: ImportPostmanRequest) =>
    fetchJson<ImportProjectResponse>(`${API_BASE}/import/postman-project`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
};

export { ApiError };
