/**
 * Request matching service
 * Matches incoming HTTP requests to resources and resolves scenarios
 */

import type { Resource, Scenario, HttpMethod } from '../types';

/**
 * Path parameter extraction result
 */
export interface PathParams {
  [key: string]: string;
}

/**
 * Match result containing resource and extracted parameters
 */
export interface MatchResult {
  resource: Resource;
  params: PathParams;
}

/**
 * Response configuration built from scenario
 */
export interface ResponseConfig {
  statusCode: number;
  headers: Record<string, string>;
  body: any;
  delay: number;
  scenario: string;
}

/**
 * Convert a path pattern to a regular expression
 * Converts /api/users/:id to a regex that matches /api/users/123
 * @param path - Path pattern (e.g., "/api/users/:id")
 * @returns Regex pattern and list of parameter names
 */
export function pathToRegex(path: string): { regex: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];

  // Escape special regex characters except :
  let pattern = path.replace(/[.+*?^${}()|[\]\\]/g, '\\$&');

  // Replace :paramName with a capturing group
  pattern = pattern.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, paramName) => {
    paramNames.push(paramName);
    return '([^/]+)'; // Match any character except /
  });

  // Ensure exact match (start and end)
  pattern = `^${pattern}$`;

  return {
    regex: new RegExp(pattern),
    paramNames,
  };
}

/**
 * Extract path parameters from a matched URL
 * @param path - Request path (e.g., "/api/users/123")
 * @param pattern - Resource path pattern (e.g., "/api/users/:id")
 * @returns Extracted parameters object
 */
export function extractParams(path: string, pattern: string): PathParams {
  const { regex, paramNames } = pathToRegex(pattern);
  const match = path.match(regex);

  if (!match) {
    return {};
  }

  const params: PathParams = {};

  // match[0] is the full match, match[1..n] are the capturing groups
  for (let i = 0; i < paramNames.length; i++) {
    params[paramNames[i]] = match[i + 1];
  }

  return params;
}

/**
 * Match an incoming request to a resource
 * @param method - HTTP method (GET, POST, etc.)
 * @param path - Request path
 * @param resources - Available resources
 * @returns Match result or null if no match found
 */
export function matchRequest(
  method: HttpMethod,
  path: string,
  resources: Resource[]
): MatchResult | null {
  // Normalize path (remove trailing slash unless it's the root path)
  const normalizedPath = path === '/' ? '/' : path.replace(/\/$/, '');

  for (const resource of resources) {
    // Check if method matches
    if (resource.method !== method) {
      continue;
    }

    // Normalize resource path
    const normalizedResourcePath = resource.path === '/'
      ? '/'
      : resource.path.replace(/\/$/, '');

    // Try to match the path
    const { regex } = pathToRegex(normalizedResourcePath);

    if (regex.test(normalizedPath)) {
      // Extract parameters
      const params = extractParams(normalizedPath, normalizedResourcePath);

      return {
        resource,
        params,
      };
    }
  }

  return null;
}

/**
 * Resolve scenario from resource with fallback logic
 * Priority: specified scenario → default scenario → first scenario
 * @param resource - Resource containing scenarios
 * @param scenarioName - Requested scenario name (optional)
 * @returns Resolved scenario
 */
export function resolveScenario(
  resource: Resource,
  scenarioName?: string
): Scenario {
  // If no scenario specified, use default
  if (!scenarioName) {
    const defaultScenario = resource.scenarios.find(s => s.name === 'default');
    if (defaultScenario) {
      return defaultScenario;
    }

    // Fallback to first scenario if no default exists
    if (resource.scenarios.length > 0) {
      return resource.scenarios[0];
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

  // Try to find requested scenario
  const scenario = resource.scenarios.find(s => s.name === scenarioName);
  if (scenario) {
    return scenario;
  }

  // Fallback to default scenario if requested scenario not found
  const defaultScenario = resource.scenarios.find(s => s.name === 'default');
  if (defaultScenario) {
    return defaultScenario;
  }

  // Fallback to first scenario
  if (resource.scenarios.length > 0) {
    return resource.scenarios[0];
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

/**
 * Build response configuration from scenario
 * @param scenario - Scenario to build response from
 * @param params - Path parameters extracted from URL
 * @returns Response configuration
 */
export function buildResponse(
  scenario: Scenario,
  params: PathParams = {}
): ResponseConfig {
  // Create default headers and merge with response headers
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...scenario.responseHeaders,
  };

  // Apply path parameters to response body if needed
  // For now, we'll just return the body as-is
  // In the future, we could support templating with {{params.id}} syntax
  const body = scenario.body;

  return {
    statusCode: scenario.statusCode,
    headers,
    body,
    delay: scenario.delay ?? 0,
    scenario: scenario.name,
  };
}

/**
 * Main request handler that combines matching, scenario resolution, and response building
 * @param method - HTTP method
 * @param path - Request path
 * @param resources - Available resources
 * @param activeScenario - Active scenario name from project
 * @param headerScenario - Scenario specified in X-MockMate-Scenario header (optional)
 * @returns Response configuration or null if no match
 */
export function handleRequest(
  method: HttpMethod,
  path: string,
  resources: Resource[],
  activeScenario: string,
  headerScenario?: string
): ResponseConfig | null {
  // Match request to resource
  const match = matchRequest(method, path, resources);

  if (!match) {
    return null;
  }

  // Determine which scenario to use
  // Priority: header-specified → active scenario → default
  const scenarioName = headerScenario ?? activeScenario;

  console.log(`[Matcher] Selecting scenario for ${method} ${path}:`);
  console.log(`  - Header scenario: ${headerScenario || 'none'}`);
  console.log(`  - Active scenario: ${activeScenario}`);
  console.log(`  - Using scenario: ${scenarioName}`);
  console.log(`  - Available scenarios: ${match.resource.scenarios.map(s => s.name).join(', ')}`);

  // Resolve scenario with fallback logic
  const scenario = resolveScenario(match.resource, scenarioName);

  console.log(`  - Resolved to: ${scenario.name}`);

  // Build response
  return buildResponse(scenario, match.params);
}
