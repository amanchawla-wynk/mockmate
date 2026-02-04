/**
 * Core type definitions for MockMate
 */

/**
 * HTTP methods supported by MockMate
 */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

/**
 * Query parameter definition
 */
export interface QueryParam {
  /** Parameter key */
  key: string;
  /** Parameter value */
  value: string;
  /** Optional description */
  description?: string;
}

/**
 * Scenario defines a specific response configuration for a resource
 */
export interface Scenario {
  /** Unique name for the scenario (e.g., "default", "empty", "error") */
  name: string;
  /** HTTP status code to return (e.g., 200, 404, 500) */
  statusCode: number;
  /** Response body as JSON object */
  body: any;
  /** Custom headers to include in response */
  headers?: Record<string, string>;
  /** Response headers (renamed for clarity) */
  responseHeaders?: Record<string, string>;
  /** Request body (for documentation/testing purposes) */
  requestBody?: any;
  /** Query parameters for this scenario */
  queryParams?: QueryParam[];
  /** Delay in milliseconds before sending response */
  delay?: number;
  /** Optional request matcher for conditional responses */
  requestMatcher?: {
    /** JSON path or field to match */
    path?: string;
    /** Expected value or regex pattern */
    value?: any;
  };
}

/**
 * Resource represents a mock API endpoint
 */
export interface Resource {
  /** Unique identifier */
  id: string;
  /** HTTP method (GET, POST, etc.) */
  method: HttpMethod;
  /** URL path with optional parameters (e.g., "/api/users/:id") */
  path: string;
  /** Optional description */
  description?: string;
  /** Available scenarios for this resource */
  scenarios: Scenario[];
  /** Whether to bypass mock and proxy to real server for this resource */
  passthrough?: boolean;
  /** Timestamp when created */
  createdAt: string;
  /** Timestamp when last updated */
  updatedAt: string;
}

/**
 * Environment variable definition
 */
export interface EnvironmentVariable {
  /** Variable key */
  key: string;
  /** Variable value */
  value: string;
  /** Optional description */
  description?: string;
}

/**
 * Project groups related resources together
 */
export interface Project {
  /** Unique identifier */
  id: string;
  /** Project name */
  name: string;
  /** URL-safe slug derived from name */
  slug: string;
  /** Optional description */
  description?: string;
  /** Currently active scenario name (applies to all resources) */
  activeScenario: string;
  /** Environment variables for this project */
  environmentVariables?: EnvironmentVariable[];
  /** Base URL of the real API server (used for passthrough/proxy mode) */
  baseUrl?: string;
  /** Whether passthrough mode is enabled (forward unmatched requests to baseUrl) */
  passthroughEnabled?: boolean;
  /** Timestamp when created */
  createdAt: string;
  /** Timestamp when last updated */
  updatedAt: string;
}

/**
 * Global configuration stored in ~/.mockmate/config.json
 */
export interface GlobalConfig {
  /** Currently active project ID */
  activeProjectId?: string;
  /** Server configuration */
  server?: {
    /** HTTP port (default: 3456) */
    httpPort?: number;
    /** HTTPS port (default: 3457) */
    httpsPort?: number;
    /** HTTP proxy port (default: 8888) */
    proxyPort?: number;
  };
}

/**
 * Request log entry for real-time monitoring
 */
export interface RequestLogEntry {
  /** Unique log entry ID */
  id: string;
  /** Timestamp of the request */
  timestamp: string;
  /** HTTP method */
  method: HttpMethod;
  /** Request path */
  path: string;
  /** Matched resource ID (if any) */
  resourceId?: string;
  /** Scenario used for response */
  scenario?: string;
  /** Response status code */
  statusCode: number;
  /** Response time in milliseconds */
  duration: number;
  /** Whether scenario was specified via header */
  scenarioFromHeader?: boolean;
  /** Whether response was proxied from real server */
  proxied?: boolean;
}

/**
 * Storage paths and configuration
 */
export interface StorageConfig {
  /** Base directory for all MockMate data */
  baseDir: string;
  /** Projects directory */
  projectsDir: string;
  /** Certificates directory (Phase 2) */
  certsDir: string;
  /** Global config file path */
  configFile: string;
}

/**
 * API request/response types
 */

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
  environmentVariables?: EnvironmentVariable[];
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
