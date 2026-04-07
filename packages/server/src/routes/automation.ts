/**
 * Lightweight automation endpoints.
 *
 * These endpoints exist to make it easy for XCUITest / Espresso runners
 * to switch scenarios and fetch captured request payloads while keeping
 * the app networking unchanged (proxy interception).
 */

import { Router, type Request, type Response } from 'express';
import { getActiveProject, updateProject } from '../services/projects';
import { clearLogEntries, getLogEntries } from '../services/logger';

const router = Router();

function scenarioFromFlags(testName?: string, testState?: string): string {
  const name = (testName ?? '').trim();
  const state = (testState ?? '').trim();

  if (!name) return 'default';
  if (!state) return name;

  // Most test suites use "init" only as a reset signal.
  // Keep scenario name stable as the testName in that case.
  if (state.toLowerCase() == 'init') return name;

  return `${name}__${state}`;
}

/**
 * POST /setMockServerflags
 * Body: { testName?: string, testState?: string, baseScenario?: string }
 */
router.post('/setMockServerflags', (req: Request, res: Response) => {
  const project = getActiveProject();
  if (!project) {
    res.status(503).json({
      error: 'No active project',
      message: 'Please activate a project in MockMate dashboard first',
    });
    return;
  }

  const testName = typeof req.body?.testName === 'string' ? req.body.testName : undefined;
  const testState = typeof req.body?.testState === 'string' ? req.body.testState : undefined;
  const baseScenario = typeof req.body?.baseScenario === 'string' ? req.body.baseScenario : undefined;

  const scenario = scenarioFromFlags(testName, testState);

  // Typically, "init" indicates the start of a test flow — clear captured state.
  if ((testState ?? '').trim().toLowerCase() === 'init') {
    clearLogEntries();
  }

  // Only update activeScenario when testName is provided.
  // This allows callers to reset captured logs without clobbering the active scenario.
  const updates: Record<string, any> = {};
  if (typeof baseScenario === 'string' && baseScenario.trim()) {
    updates.baseScenario = baseScenario.trim();
  }
  if (typeof testName === 'string' && testName.trim()) {
    updates.activeScenario = scenario;
  }

  const updated = Object.keys(updates).length > 0
    ? updateProject(project.id, updates)
    : project;

  res.json({
    ok: true,
    activeProjectId: project.id,
    activeScenario: updated.activeScenario,
    baseScenario: updated.baseScenario,
  });
});

/**
 * GET /getMockServerData?dataType=contentSyncApi|downloadSyncApi
 * Returns the most recent captured request body for the corresponding API.
 */
router.get('/getMockServerData', (req: Request, res: Response) => {
  const dataType = typeof req.query.dataType === 'string' ? req.query.dataType : '';
  const logs = getLogEntries();

  const lookup: Record<string, { method: string; path: string }> = {
    contentSyncApi: { method: 'POST', path: '/v5/user/content/sync' },
    downloadSyncApi: { method: 'POST', path: '/v2/user/syncDownload/sync' },
  };

  const spec = lookup[dataType];
  if (!spec) {
    res.json({});
    return;
  }

  const entry = logs.find(l => l.method === spec.method && l.path === spec.path);
  res.json(entry?.requestBody ?? {});
});

/**
 * POST /api/upload
 * Accepts screenshots/attachments from test runners.
 */
router.post('/api/upload', (req: Request, res: Response) => {
  // For now we simply acknowledge the upload.
  // Persisting these can be added later (e.g., write to disk under MOCKMATE_DATA_DIR).
  res.json({ ok: true });
});

export default router;
