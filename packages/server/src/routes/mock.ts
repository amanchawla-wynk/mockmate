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
import { writeHttpResponseFixture } from '../services/fixtures';

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

  const host = (req.headers.host || '').split(':')[0] || undefined;
  const requestHeaders = Object.fromEntries(
    Object.entries(req.headers)
      .filter(([, v]) => typeof v === 'string')
      .map(([k, v]) => [k.toLowerCase(), v as string])
  );
  const requestQuery = Object.fromEntries(
    Object.entries(req.query).map(([k, v]) => [
      k,
      Array.isArray(v) ? String(v[v.length - 1] ?? '') : String(v ?? ''),
    ])
  );
  const requestBody = (req.body !== undefined && Object.keys(req.body ?? {}).length > 0)
    ? req.body
    : undefined;

  const responseHeaders = Object.fromEntries(
    Object.entries(result.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)])
  );

  const fixture = project.captureRawTraffic
    ? writeHttpResponseFixture(
        project.slug,
        `fixtures/traffic/${new Date().toISOString().slice(0, 10)}/${Date.now()}_${Math.random().toString(16).slice(2, 8)}.http`,
        result.statusCode,
        responseHeaders,
        Buffer.isBuffer(result.body) ? result.body : Buffer.from(result.body ?? ''),
      )
    : null;

  // Only store response body when it's JSON/text and reasonably sized.
  let responseBody: any = undefined;
  let responseBodyTruncated = false;
  let responseSize: number | undefined = undefined;
  try {
    const bodyBuf = Buffer.isBuffer(result.body) ? result.body : Buffer.from(result.body ?? '');
    responseSize = bodyBuf.length;
    const contentType = String(responseHeaders['content-type'] ?? '').toLowerCase();
    const isText =
      contentType.includes('application/json') ||
      contentType.includes('+json') ||
      contentType.startsWith('text/');

    const MAX_CAPTURE_BYTES = 256 * 1024;
    responseBodyTruncated = bodyBuf.length > MAX_CAPTURE_BYTES;
    const slice = responseBodyTruncated ? bodyBuf.subarray(0, MAX_CAPTURE_BYTES) : bodyBuf;

    if (isText) {
      const text = slice.toString('utf-8');
      if (contentType.includes('application/json') || contentType.includes('+json')) {
        try {
          responseBody = JSON.parse(text);
        } catch {
          responseBody = text;
        }
      } else {
        responseBody = text;
      }
    } else {
      responseBody = {
        _binary: true,
        contentType: responseHeaders['content-type'] ?? 'application/octet-stream',
        size: bodyBuf.length,
      };
    }
  } catch {
    // ignore
  }

  logRequest(
    req.method as HttpMethod,
    req.path,
    result.statusCode,
    duration,
    undefined,
    undefined,
    false,
    true, // proxied
    {
      host,
      requestHeaders,
      requestQuery,
      requestBody,
      responseHeaders,
      responseBody,
      responseBodyTruncated,
      responseSize,
      responseFixture: fixture
        ? { path: fixture.relPath, size: fixture.size, truncated: fixture.truncated, contentType: fixture.contentType }
        : undefined,
      proxiedReason: 'project_passthrough',
    }
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

  const host = (req.headers.host || '').split(':')[0] || undefined;
  const requestHeaders = Object.fromEntries(
    Object.entries(req.headers)
      .filter(([, v]) => typeof v === 'string')
      .map(([k, v]) => [k.toLowerCase(), v as string])
  );
  const requestQuery = Object.fromEntries(
    Object.entries(req.query).map(([k, v]) => [
      k,
      Array.isArray(v) ? String(v[v.length - 1] ?? '') : String(v ?? ''),
    ])
  );
  const requestBody = (req.body !== undefined && Object.keys(req.body ?? {}).length > 0)
    ? req.body
    : undefined;

  try {
    // Get active project
    const activeProject = getActiveProject();

    if (!activeProject) {
      // No active project, return 503 Service Unavailable
      const duration = Date.now() - startTime;
      logRequest(req.method as HttpMethod, req.path, 503, duration, undefined, undefined, false, false, {
        host,
        requestHeaders,
        requestQuery,
        requestBody,
        responseHeaders: { 'content-type': 'application/json' },
        responseBody: { error: 'No active project', message: 'Please create and activate a project first' },
        responseBodyTruncated: false,
      });

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
      req.originalUrl,
      resources,
      activeProject.activeScenario,
      activeProject.baseScenario,
      headerScenario,
      {
        host: (req.headers.host || '').split(':')[0],
        headers: Object.fromEntries(
          Object.entries(req.headers)
            .filter(([, v]) => typeof v === 'string')
            .map(([k, v]) => [k, v as string])
        ),
      },
      activeProject.slug,
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
      logRequest(req.method as HttpMethod, req.path, 404, duration, undefined, undefined, false, false, {
        host,
        requestHeaders,
        requestQuery,
        requestBody,
        responseHeaders: { 'content-type': 'application/json' },
        responseBody: { error: 'Not Found', message: `No mock resource found for ${req.method} ${req.path}` },
        responseBodyTruncated: false,
      });

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
      responseConfig.resourceId,
      responseConfig.scenario,
      !!headerScenario,
      false,
      {
        host,
        requestHeaders,
        requestQuery,
        requestBody,
        scenarioSource: responseConfig.scenarioSource,
        responseHeaders: Object.fromEntries(
          Object.entries(responseConfig.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)])
        ),
        responseBody: responseConfig.rawBody
          ? {
              _fixture: true,
              format: 'http',
            }
          : responseConfig.body,
        responseBodyTruncated: false,
      }
    );

    // Send response
    if (responseConfig.rawBody) {
      res.status(responseConfig.statusCode).set(responseConfig.headers).send(responseConfig.rawBody);
    } else {
      res.status(responseConfig.statusCode).set(responseConfig.headers).json(responseConfig.body);
    }

  } catch (error) {
    // Internal server error
    const duration = Date.now() - startTime;
    logRequest(req.method as HttpMethod, req.path, 500, duration, undefined, undefined, false, false, {
      host,
      requestHeaders,
      requestQuery,
      requestBody,
      responseHeaders: { 'content-type': 'application/json' },
      responseBody: { error: 'Internal Server Error', message: (error as Error).message },
      responseBodyTruncated: false,
    });

    console.error('Mock request handler error:', error);

    res.status(500).json({
      error: 'Internal Server Error',
      message: (error as Error).message,
    });
  }
}
