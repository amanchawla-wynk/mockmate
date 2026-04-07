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
  fixture?: {
    path: string;
    format: 'http';
  };
  headers?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  requestBody?: any;
  queryParams?: QueryParam[];
  delay?: number;
}

export interface Resource {
  id: string;
  method: HttpMethod;
  host?: string;
  path: string;
  match?: {
    query?: Record<string, string>;
    headers?: Record<string, string>;
  };
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
  baseScenario?: string;
  captureRawTraffic?: boolean;
  environmentVariables?: EnvironmentVariable[];
  baseUrl?: string;
  passthroughEnabled?: boolean;
  interceptHosts?: string[];
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
  scenarioSource?: 'header' | 'active' | 'active_base' | 'base' | 'default';
  statusCode: number;
  duration: number;
  scenarioFromHeader?: boolean;
  proxied?: boolean;
  proxiedReason?: 'no_rule_match' | 'resource_passthrough' | 'project_passthrough';
  host?: string;
  requestHeaders?: Record<string, string>;
  requestQuery?: Record<string, string>;
  requestBody?: any;

  responseHeaders?: Record<string, string>;
  responseBody?: any;
  responseBodyTruncated?: boolean;
  responseSize?: number;

  responseFixture?: {
    path: string;
    size: number;
    truncated?: boolean;
    contentType?: string;
  };
}

export interface ServerStatus {
  status: string;
  activeProject: {
    id: string;
    name: string;
    activeScenario: string;
    baseScenario?: string;
  } | null;
  server?: {
    httpPort: number;
    httpsPort: number;
    proxyPort: number;
    localIPs: string[];
  };
  timestamp: string;
}

// API Request/Response types
export interface CreateProjectRequest {
  name: string;
  description?: string;
  baseUrl?: string;
  interceptHosts?: string[];
}

export interface UpdateProjectRequest {
  name?: string;
  description?: string;
  activeScenario?: string;
  baseScenario?: string;
  captureRawTraffic?: boolean;
  baseUrl?: string;
  passthroughEnabled?: boolean;
  interceptHosts?: string[];
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
  host?: string;
  path: string;
  description?: string;
  match?: {
    query?: Record<string, string>;
    headers?: Record<string, string>;
  };
}

export interface UpdateResourceRequest {
  method?: HttpMethod;
  host?: string;
  path?: string;
  description?: string;
  passthrough?: boolean;
  match?: {
    query?: Record<string, string>;
    headers?: Record<string, string>;
  };
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

export interface StaticFileEntry {
  /** Relative posix path, e.g. "videos/10_min_hls/master.m3u8" */
  path: string;
  /** Size in bytes */
  size: number;
  /** ISO-8601 modification time */
  mtime: string;
}
