/**
 * Mock API route handler
 * Catch-all handler for all mock API requests
 */

import type { Request, Response, NextFunction } from 'express';
import { getActiveProject } from '../services/projects';
import { listResources } from '../services/resources';
import { handleRequest } from '../services/matcher';
import { logRequest } from '../services/logger';
import type { HttpMethod } from '../types';

/**
 * Delay helper - waits for specified milliseconds
 */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Main mock request handler
 * Matches incoming requests to resources and returns mock responses
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
      // No matching resource found, return 404
      const duration = Date.now() - startTime;
      logRequest(req.method as HttpMethod, req.path, 404, duration);

      res.status(404).json({
        error: 'Not Found',
        message: `No mock resource found for ${req.method} ${req.path}`,
      });
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
