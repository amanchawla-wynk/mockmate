/**
 * Mock API route handler
 * Catch-all handler for all mock API requests
 * Supports passthrough mode to proxy unmatched or bypassed requests to real server
 */

import type { Request, Response, NextFunction } from 'express';
import { getActiveProject } from '../services/projects';
import { listResources } from '../services/resources';
import { handleRequest } from '../services/matcher';
import { logRequest } from '../services/logger';
import { proxyRequest } from '../services/proxy';
import type { HttpMethod, Project } from '../types';

/**
 * Delay helper - waits for specified milliseconds
 */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Check if passthrough proxy is available for the given project
 */
function canProxy(project: Project): boolean {
  return !!(project.passthroughEnabled && project.baseUrl);
}

/**
 * Send a proxied response back to the client
 */
async function sendProxiedResponse(
  req: Request,
  res: Response,
  project: Project,
  startTime: number
): Promise<void> {
  const result = await proxyRequest(project.baseUrl!, req);
  const duration = Date.now() - startTime;

  logRequest(
    req.method as HttpMethod,
    req.path,
    result.statusCode,
    duration,
    undefined,
    undefined,
    false,
    true // proxied
  );

  res
    .status(result.statusCode)
    .set(result.headers)
    .send(result.body);
}

/**
 * Main mock request handler
 * Matches incoming requests to resources and returns mock responses
 * Falls back to proxying when passthrough mode is enabled
 */
export async function mockRequestHandler(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const startTime = Date.now();

  try {
    // Get active project
    const activeProject = getActiveProject();

    if (!activeProject) {
      // No active project, return 503 Service Unavailable
      const duration = Date.now() - startTime;
      logRequest(req.method as HttpMethod, req.path, 503, duration);

      res.status(503).json({
        error: 'No active project',
        message: 'Please create and activate a project first',
      });
      return;
    }

    // Load resources for the active project
    const resources = listResources(activeProject.id);

    // Get scenario from header (if specified)
    const headerScenario = req.headers['x-mockmate-scenario'] as string | undefined;

    // Match request to resource and build response
    const responseConfig = handleRequest(
      req.method as HttpMethod,
      req.path,
      resources,
      activeProject.activeScenario,
      headerScenario
    );

    if (!responseConfig) {
      // No matching resource found
      // If passthrough is enabled, proxy to real server
      if (canProxy(activeProject)) {
        await sendProxiedResponse(req, res, activeProject, startTime);
        return;
      }

      // No passthrough — return 404
      const duration = Date.now() - startTime;
      logRequest(req.method as HttpMethod, req.path, 404, duration);

      res.status(404).json({
        error: 'Not Found',
        message: `No mock resource found for ${req.method} ${req.path}`,
      });
      return;
    }

    // Resource matched — check if it's marked for passthrough
    if (responseConfig.passthrough && canProxy(activeProject)) {
      await sendProxiedResponse(req, res, activeProject, startTime);
      return;
    }

    // Apply delay if configured
    if (responseConfig.delay > 0) {
      await delay(responseConfig.delay);
    }

    // Log the request
    const duration = Date.now() - startTime;
    logRequest(
      req.method as HttpMethod,
      req.path,
      responseConfig.statusCode,
      duration,
      undefined, // We could track resource ID if needed
      responseConfig.scenario,
      !!headerScenario
    );

    // Send response
    res
      .status(responseConfig.statusCode)
      .set(responseConfig.headers)
      .json(responseConfig.body);

  } catch (error) {
    // Internal server error
    const duration = Date.now() - startTime;
    logRequest(req.method as HttpMethod, req.path, 500, duration);

    console.error('Mock request handler error:', error);

    res.status(500).json({
      error: 'Internal Server Error',
      message: (error as Error).message,
    });
  }
}
