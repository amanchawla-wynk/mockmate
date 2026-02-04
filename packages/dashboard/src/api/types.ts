/**
 * API type definitions matching backend types
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

export interface QueryParam {
  key: string;
  value: string;
  description?: string;
}

export interface EnvironmentVariable {
  key: string;
  value: string;
  description?: string;
}

export interface Scenario {
  name: string;
  statusCode: number;
  body: any;
  headers?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  requestBody?: any;
  queryParams?: QueryParam[];
  delay?: number;
}

export interface Resource {
  id: string;
  method: HttpMethod;
  path: string;
  description?: string;
  scenarios: Scenario[];
  passthrough?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Project {
  id: string;
  name: string;
  slug: string;
  description?: string;
  activeScenario: string;
  environmentVariables?: EnvironmentVariable[];
  baseUrl?: string;
  passthroughEnabled?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RequestLogEntry {
  id: string;
  timestamp: string;
  method: HttpMethod;
  path: string;
  resourceId?: string;
  scenario?: string;
  statusCode: number;
  duration: number;
  scenarioFromHeader?: boolean;
  proxied?: boolean;
}

export interface ServerStatus {
  status: string;
  activeProject: {
    id: string;
    name: string;
    activeScenario: string;
  } | null;
  timestamp: string;
}

// API Request/Response types
export interface CreateProjectRequest {
  name: string;
  description?: string;
  baseUrl?: string;
}

export interface UpdateProjectRequest {
  name?: string;
  description?: string;
  activeScenario?: string;
  baseUrl?: string;
  passthroughEnabled?: boolean;
}

export interface ImportCurlRequest {
  curl: string;
}

export interface ImportPostmanRequest {
  collection: any; // Postman collection JSON
}

export interface ImportResponse {
  message: string;
  resources: Resource[];
  collectionName?: string;
}

export interface ImportProjectResponse {
  message: string;
  project: Project;
  resources: Resource[];
}

export interface CreateResourceRequest {
  method: HttpMethod;
  path: string;
  description?: string;
}

export interface UpdateResourceRequest {
  method?: HttpMethod;
  path?: string;
  description?: string;
  passthrough?: boolean;
}

export interface CreateScenarioRequest {
  name: string;
  statusCode: number;
  body: any;
  headers?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  requestBody?: any;
  queryParams?: QueryParam[];
  delay?: number;
}

export interface UpdateScenarioRequest {
  statusCode?: number;
  body?: any;
  headers?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  requestBody?: any;
  queryParams?: QueryParam[];
  delay?: number;
}

export interface ListProjectsResponse {
  projects: Project[];
  activeProjectId?: string;
}
