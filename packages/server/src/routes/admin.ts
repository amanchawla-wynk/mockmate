/**
 * Admin API routes
 * Provides REST API for managing projects, resources, and scenarios
 */

import { Router, type Request, type Response } from 'express';
import {
  createProject,
  listProjects,
  getProject,
  updateProject,
  deleteProject,
  setActiveProject,
  getActiveProject,
} from '../services/projects';
import {
  createResource,
  listResources,
  getResource,
  updateResource,
  deleteResource,
  addScenario,
  updateScenario,
  deleteScenario,
  duplicateScenario,
} from '../services/resources';
import { getLogEntries, clearLogEntries } from '../services/logger';
import { parseCurl, parseMultipleCurls } from '../utils/curl-parser';
import { parsePostmanCollection } from '../utils/postman-parser';

const router = Router();

// ============================================================================
// Project Routes
// ============================================================================

/**
 * GET /api/admin/projects
 * List all projects
 */
router.get('/projects', (req: Request, res: Response) => {
  try {
    const projects = listProjects();
    const activeProject = getActiveProject();

    res.json({
      projects,
      activeProjectId: activeProject?.id,
    });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * POST /api/admin/projects
 * Create a new project
 */
router.post('/projects', (req: Request, res: Response) => {
  try {
    const project = createProject(req.body);
    res.status(201).json(project);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

/**
 * GET /api/admin/projects/:id
 * Get a specific project
 */
router.get('/projects/:id', (req: Request, res: Response) => {
  try {
    const project = getProject(req.params.id);
    res.json(project);
  } catch (error) {
    res.status(404).json({ error: (error as Error).message });
  }
});

/**
 * PUT /api/admin/projects/:id
 * Update a project
 */
router.put('/projects/:id', (req: Request, res: Response) => {
  try {
    const project = updateProject(req.params.id, req.body);
    res.json(project);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

/**
 * DELETE /api/admin/projects/:id
 * Delete a project
 */
router.delete('/projects/:id', (req: Request, res: Response) => {
  try {
    deleteProject(req.params.id);
    res.status(204).send();
  } catch (error) {
    res.status(404).json({ error: (error as Error).message });
  }
});

/**
 * PUT /api/admin/projects/:id/activate
 * Set a project as active
 */
router.put('/projects/:id/activate', (req: Request, res: Response) => {
  try {
    setActiveProject(req.params.id);
    const project = getProject(req.params.id);
    res.json(project);
  } catch (error) {
    res.status(404).json({ error: (error as Error).message });
  }
});

/**
 * DELETE /api/admin/projects/active
 * Deactivate the currently active project
 */
router.delete('/projects/active', (req: Request, res: Response) => {
  try {
    const { readConfig, writeConfig } = require('../services/storage');
    const config = readConfig();
    config.activeProjectId = undefined;
    writeConfig(config);
    res.status(204).send();
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * PUT /api/admin/projects/:id/scenario
 * Switch active scenario for a project
 */
router.put('/projects/:id/scenario', (req: Request, res: Response) => {
  try {
    const { scenario } = req.body;

    if (!scenario) {
      res.status(400).json({ error: 'Scenario name is required' });
      return;
    }

    const project = updateProject(req.params.id, { activeScenario: scenario });
    res.json(project);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

// ============================================================================
// Resource Routes
// ============================================================================

/**
 * GET /api/admin/projects/:projectId/resources
 * List all resources for a project
 */
router.get('/projects/:projectId/resources', (req: Request, res: Response) => {
  try {
    const resources = listResources(req.params.projectId);
    res.json(resources);
  } catch (error) {
    res.status(404).json({ error: (error as Error).message });
  }
});

/**
 * POST /api/admin/projects/:projectId/resources
 * Create a new resource
 */
router.post('/projects/:projectId/resources', (req: Request, res: Response) => {
  try {
    const resource = createResource(req.params.projectId, req.body);
    res.status(201).json(resource);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

/**
 * GET /api/admin/projects/:projectId/resources/:resourceId
 * Get a specific resource
 */
router.get('/projects/:projectId/resources/:resourceId', (req: Request, res: Response) => {
  try {
    const resource = getResource(req.params.projectId, req.params.resourceId);
    res.json(resource);
  } catch (error) {
    res.status(404).json({ error: (error as Error).message });
  }
});

/**
 * PUT /api/admin/projects/:projectId/resources/:resourceId
 * Update a resource
 */
router.put('/projects/:projectId/resources/:resourceId', (req: Request, res: Response) => {
  try {
    const resource = updateResource(
      req.params.projectId,
      req.params.resourceId,
      req.body
    );
    res.json(resource);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

/**
 * DELETE /api/admin/projects/:projectId/resources/:resourceId
 * Delete a resource
 */
router.delete('/projects/:projectId/resources/:resourceId', (req: Request, res: Response) => {
  try {
    deleteResource(req.params.projectId, req.params.resourceId);
    res.status(204).send();
  } catch (error) {
    res.status(404).json({ error: (error as Error).message });
  }
});

// ============================================================================
// Scenario Routes
// ============================================================================

/**
 * POST /api/admin/projects/:pid/resources/:rid/scenarios
 * Add a new scenario to a resource
 */
router.post(
  '/projects/:pid/resources/:rid/scenarios',
  (req: Request, res: Response) => {
    try {
      const resource = addScenario(req.params.pid, req.params.rid, req.body);
      res.status(201).json(resource);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  }
);

/**
 * PUT /api/admin/projects/:pid/resources/:rid/scenarios/:name
 * Update a scenario
 */
router.put(
  '/projects/:pid/resources/:rid/scenarios/:name',
  (req: Request, res: Response) => {
    try {
      const resource = updateScenario(
        req.params.pid,
        req.params.rid,
        req.params.name,
        req.body
      );
      res.json(resource);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  }
);

/**
 * DELETE /api/admin/projects/:pid/resources/:rid/scenarios/:name
 * Delete a scenario
 */
router.delete(
  '/projects/:pid/resources/:rid/scenarios/:name',
  (req: Request, res: Response) => {
    try {
      const resource = deleteScenario(
        req.params.pid,
        req.params.rid,
        req.params.name
      );
      res.json(resource);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  }
);

/**
 * POST /api/admin/projects/:pid/resources/:rid/scenarios/:name/duplicate
 * Duplicate a scenario
 */
router.post(
  '/projects/:pid/resources/:rid/scenarios/:name/duplicate',
  (req: Request, res: Response) => {
    try {
      const { newName } = req.body;

      if (!newName) {
        res.status(400).json({ error: 'New scenario name is required' });
        return;
      }

      const resource = duplicateScenario(
        req.params.pid,
        req.params.rid,
        req.params.name,
        newName
      );
      res.status(201).json(resource);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  }
);

// ============================================================================
// Server Routes
// ============================================================================

/**
 * GET /api/admin/status
 * Get server status
 */
router.get('/status', (req: Request, res: Response) => {
  try {
    const activeProject = getActiveProject();

    res.json({
      status: 'running',
      activeProject: activeProject
        ? {
            id: activeProject.id,
            name: activeProject.name,
            activeScenario: activeProject.activeScenario,
          }
        : null,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * GET /api/admin/logs
 * Get request logs
 */
router.get('/logs', (req: Request, res: Response) => {
  try {
    const logs = getLogEntries();
    res.json(logs);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * DELETE /api/admin/logs
 * Clear request logs
 */
router.delete('/logs', (req: Request, res: Response) => {
  try {
    clearLogEntries();
    res.status(204).send();
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// ============================================================================
// Import Routes
// ============================================================================

/**
 * POST /api/admin/projects/:pid/import/curl
 * Import resources from cURL commands
 */
router.post('/projects/:pid/import/curl', (req: Request, res: Response) => {
  try {
    console.log('[cURL Import] Received request for project:', req.params.pid);
    const { curl } = req.body;
    console.log('[cURL Import] Request body:', { curl: curl?.substring(0, 100) + '...' });

    if (!curl || typeof curl !== 'string') {
      console.error('[cURL Import] Validation failed: cURL command missing or not string');
      res.status(400).json({ error: 'cURL command(s) required' });
      return;
    }

    // Try to parse multiple cURL commands
    let parsedCurls;
    try {
      console.log('[cURL Import] Attempting to parse cURL command(s)...');
      parsedCurls = parseMultipleCurls(curl);
      console.log('[cURL Import] Successfully parsed', parsedCurls.length, 'command(s)');
    } catch (error) {
      console.error('[cURL Import] Parse error:', error);
      res.status(400).json({ error: `Failed to parse cURL: ${(error as Error).message}` });
      return;
    }

    // Create resources from parsed cURL commands
    const createdResources = [];
    for (const parsed of parsedCurls) {
      try {
        const resource = createResource(req.params.pid, {
          method: parsed.method,
          path: parsed.path,
        });

        // Update the default scenario with the parsed request data
        if (resource.scenarios.length > 0) {
          const updatedResource = updateScenario(
            req.params.pid,
            resource.id,
            'default',
            {
              statusCode: 200,
              body: {}, // Empty response body - user defines this
              headers: parsed.headers, // Request headers (for documentation)
              requestBody: parsed.requestBody, // Request body from cURL
              queryParams: parsed.queryParams,
              responseHeaders: {}, // Empty response headers - user will define
            }
          );
          createdResources.push(updatedResource);
        } else {
          createdResources.push(resource);
        }
      } catch (error) {
        // If resource creation fails, continue with others
        console.error(`Failed to create resource from cURL:`, error);
      }
    }

    console.log('[cURL Import] Successfully created', createdResources.length, 'resource(s)');
    res.status(201).json({
      message: `Created ${createdResources.length} resource(s) from ${parsedCurls.length} cURL command(s)`,
      resources: createdResources,
    });
  } catch (error) {
    console.error('[cURL Import] Unexpected error:', error);
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * POST /api/admin/projects/:pid/import/postman
 * Import resources from Postman collection
 */
router.post('/projects/:pid/import/postman', (req: Request, res: Response) => {
  try {
    const { collection } = req.body;

    if (!collection) {
      res.status(400).json({ error: 'Postman collection required' });
      return;
    }

    // Parse the Postman collection
    let parsed;
    try {
      parsed = parsePostmanCollection(collection);
    } catch (error) {
      res.status(400).json({ error: `Failed to parse Postman collection: ${(error as Error).message}` });
      return;
    }

    // Create resources from parsed requests
    const createdResources = [];
    for (const request of parsed.requests) {
      try {
        const resource = createResource(req.params.pid, {
          method: request.method,
          path: request.path,
          description: request.description,
        });

        // Update the default scenario with parsed request data
        if (resource.scenarios.length > 0) {
          const updatedResource = updateScenario(
            req.params.pid,
            resource.id,
            'default',
            {
              statusCode: 200,
              body: {}, // Empty response body - user defines this
              headers: request.headers || {}, // Request headers (for documentation)
              requestBody: request.requestBody, // Request body from Postman
              queryParams: request.queryParams || [],
              responseHeaders: { 'Content-Type': 'application/json' }, // Default response header
            }
          );
          createdResources.push(updatedResource);
        } else {
          createdResources.push(resource);
        }
      } catch (error) {
        // If resource creation fails, continue with others
        console.error(`Failed to create resource from Postman request:`, error);
      }
    }

    res.status(201).json({
      message: `Created ${createdResources.length} resource(s) from ${parsed.requests.length} request(s)`,
      collectionName: parsed.name,
      resources: createdResources,
    });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * POST /api/admin/import/postman-project
 * Create a new project from Postman collection
 */
router.post('/import/postman-project', (req: Request, res: Response) => {
  try {
    const { collection } = req.body;

    if (!collection) {
      res.status(400).json({ error: 'Postman collection required' });
      return;
    }

    // Parse the Postman collection
    let parsed;
    try {
      parsed = parsePostmanCollection(collection);
    } catch (error) {
      res.status(400).json({ error: `Failed to parse Postman collection: ${(error as Error).message}` });
      return;
    }

    // Create a new project
    const project = createProject({
      name: parsed.name,
      description: parsed.description,
    });

    // Create resources from parsed requests
    const createdResources = [];
    for (const request of parsed.requests) {
      try {
        const resource = createResource(project.id, {
          method: request.method,
          path: request.path,
          description: request.description,
        });

        // Update the default scenario with parsed request data
        if (resource.scenarios.length > 0) {
          const updatedResource = updateScenario(
            project.id,
            resource.id,
            'default',
            {
              statusCode: 200,
              body: {}, // Empty response body - user defines this
              headers: request.headers || {}, // Request headers (for documentation)
              requestBody: request.requestBody, // Request body from Postman
              queryParams: request.queryParams || [],
              responseHeaders: { 'Content-Type': 'application/json' }, // Default response header
            }
          );
          createdResources.push(updatedResource);
        } else {
          createdResources.push(resource);
        }
      } catch (error) {
        // If resource creation fails, continue with others
        console.error(`Failed to create resource from Postman request:`, error);
      }
    }

    res.status(201).json({
      message: `Created project "${project.name}" with ${createdResources.length} resource(s)`,
      project,
      resources: createdResources,
    });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

export default router;
