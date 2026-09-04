import { expect, type Page } from '@playwright/test';

import type { EndpointDetail, Project } from '../packages/server/dist/domain/model.js';
import {
  measureLongTaskPhase,
  openMockBody,
  test,
  type WorkerEvidence,
} from './support/traffic-fixture';

const TEN_MIB = 10 * 1024 * 1024;

async function editorText(page: Page): Promise<string> {
  return page.getByRole('textbox', { name: 'Response body' }).evaluate(element => element.textContent ?? '');
}

async function workerEvidence(page: Page): Promise<WorkerEvidence> {
  return page.evaluate(() => structuredClone(window.__mockmateWorkerEvidence!));
}

test.describe.configure({ mode: 'serial' });

test('shows canonical repository diagnostics without an active Project', async ({ page, trafficFixture }) => {
  await trafficFixture.setActiveProject(null);
  try {
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Repository diagnostics' })).toBeVisible();
    await expect(page.getByText('UNSUPPORTED_SCHEMA_VERSION')).toBeVisible();
    await expect(page.getByText(/reset the configured MockMate data directory/i)).toBeVisible();
    await expect(page.getByText(/migration|rollback|backup/i)).toHaveCount(0);
    await expect(page.getByText(/Create or select a Project/i)).toBeVisible();
  } finally {
    await trafficFixture.setActiveProject(trafficFixture.projectId);
  }
});

test('keeps body editing lazy, worker-owned, conflict-safe, and navigation-safe', async ({
  page,
  trafficFixture,
}) => {
  await page.reload();
  const bodyRequests: string[] = [];
  page.on('request', request => {
    if (/\/api\/admin\/projects\/[^/]+\/bodies\/[a-f0-9]{64}$/.test(new URL(request.url()).pathname)) {
      bodyRequests.push(request.url());
    }
  });

  await page.getByRole('tab', { name: 'Endpoints' }).click();
  await page.getByText(trafficFixture.workflow.endpointName, { exact: true }).first().click();
  await expect(page.getByRole('button', { name: 'Edit response body' })).toBeVisible();
  expect(bodyRequests).toHaveLength(0);
  await page.getByRole('button', { name: 'Edit response body' }).click();
  const editor = page.getByRole('textbox', { name: 'Response body' });
  await expect(editor).toBeVisible();
  await expect.poll(() => bodyRequests.length).toBe(1);

  await editor.fill('{ invalid');
  await expect(page.getByRole('button', { name: 'Save Body' })).toBeDisabled();
  const validBody = '{"workerProbe":"upload-and-attach"}';
  await editor.fill(validBody);
  await expect(page.getByRole('button', { name: 'Save Body' })).toBeEnabled();
  await page.getByRole('button', { name: 'Format JSON' }).click();
  await expect(page.getByRole('button', { name: 'Format JSON' })).toBeEnabled();
  await page.getByRole('button', { name: 'Save Body' }).click();
  await expect(page.getByText('Pending body uploaded')).toBeVisible();
  await page.getByRole('button', { name: 'Save Variant' }).click();
  await expect(page.getByText('Pending body uploaded')).toHaveCount(0);
  const attached = await trafficFixture.admin<EndpointDetail>(
    `/api/admin/projects/${trafficFixture.projectId}/endpoints/${trafficFixture.workflow.endpointId}`,
  );
  expect(attached.variants.find(value => value.id === trafficFixture.workflow.variantId)?.bodyAssetId)
    .toBeTruthy();

  await page.getByRole('button', { name: 'Edit response body' }).click();
  await expect(editor).toBeVisible();
  const stale = await trafficFixture.admin<EndpointDetail>(
    `/api/admin/projects/${trafficFixture.projectId}/endpoints/${trafficFixture.workflow.endpointId}`,
  );
  const staleVariant = stale.variants.find(value => value.id === trafficFixture.workflow.variantId)!;
  const canonicalVariant = await trafficFixture.admin<{ revision: number }>(
    `/api/admin/projects/${trafficFixture.projectId}/endpoints/${trafficFixture.workflow.endpointId}/variants/${trafficFixture.workflow.variantId}`,
    {
      method: 'PUT',
      body: JSON.stringify({
        expectedRevision: staleVariant.revision,
        patch: { description: 'Concurrent canonical update' },
      }),
    },
  );
  await editor.fill('{"workerProbe":"conflict-preserved"}');
  await editor.press('End');
  await editor.press(' ');
  await expect(page.getByRole('button', { name: 'Save Body' })).toBeEnabled();
  const textBeforeConflict = await editorText(page);
  await page.getByRole('button', { name: 'Save Body' }).click();
  await expect(page.getByText('Pending body uploaded')).toBeVisible();
  await page.getByRole('button', { name: 'Save Variant' }).click();
  await expect(page.getByText(`Server revision ${canonicalVariant.revision}`)).toBeVisible();
  await expect.poll(() => editorText(page)).toBe(textBeforeConflict);
  await expect(page.getByText('Pending body uploaded')).toBeVisible();
  await editor.press('ControlOrMeta+z');
  await expect.poll(() => editorText(page)).not.toBe(textBeforeConflict);
  await expect(page.getByText('Pending body uploaded')).toBeVisible();
  const afterConflict = await trafficFixture.admin<EndpointDetail>(
    `/api/admin/projects/${trafficFixture.projectId}/endpoints/${trafficFixture.workflow.endpointId}`,
  );
  expect(afterConflict.variants.find(value => value.id === trafficFixture.workflow.variantId)?.revision)
    .toBe(canonicalVariant.revision);

  await page.getByRole('tab', { name: 'Traffic' }).click();
  await expect(page.getByRole('dialog', { name: 'Unsaved changes' })).toBeVisible();
  await page.getByRole('button', { name: 'Stay' }).click();
  await expect(page.getByRole('textbox', { name: 'Response body' })).toBeVisible();
  await page.getByRole('tab', { name: 'App States' }).click();
  await expect(page.getByRole('dialog', { name: 'Unsaved changes' })).toBeVisible();
  await page.getByRole('button', { name: 'Discard' }).click();
  await expect(page.getByRole('heading', { name: 'Active App State' })).toBeVisible();

  const beforeActivation = await trafficFixture.admin<Project>(
    `/api/admin/projects/${trafficFixture.projectId}`,
  );
  expect(beforeActivation.activeStateId).toBe(trafficFixture.workflow.activeStateId);
  expect(beforeActivation.baseStateId).toBe(trafficFixture.workflow.baseStateId);
  await page.getByRole('button', { name: `Activate ${trafficFixture.workflow.partialStateName}` }).click();
  await expect(page.getByText('2 endpoints will fall back')).toBeVisible();
  await page.getByRole('button', { name: 'Activate with fallback' }).click();
  await expect.poll(async () => (
    await trafficFixture.admin<Project>(`/api/admin/projects/${trafficFixture.projectId}`)
  ).activeStateId).toBe(trafficFixture.workflow.partialStateId);
  const afterActivation = await trafficFixture.admin<Project>(
    `/api/admin/projects/${trafficFixture.projectId}`,
  );
  expect(afterActivation.baseStateId).toBe(trafficFixture.workflow.baseStateId);

  const evidence = await workerEvidence(page);
  expect(evidence.urls).toContainEqual(expect.stringMatching(/\/assets\/json\.worker-[^/]+\.js$/));
  const validation = evidence.requests.find(request => request.operation === 'validate');
  const format = evidence.requests.find(request => request.operation === 'format');
  expect(validation).toBeTruthy();
  expect(format).toBeTruthy();
  expect(evidence.responses).toContainEqual(expect.objectContaining({ id: validation!.id }));
  expect(evidence.responses).toContainEqual(expect.objectContaining({ id: format!.id, ok: true }));
  expect(evidence.mainThreadLargeJsonParses).toBe(0);
});

test('measurement harness retains the final queued Long Task entry', async ({ page }) => {
  const measured = await measureLongTaskPhase(page, 'measurement-self-test', async () => {
    await page.evaluate(() => {
      const end = performance.now() + 75;
      while (performance.now() < end) {
        // Deliberately occupy the browser task through the end of this phase action.
      }
    });
  });
  expect(measured.phase).toBe('measurement-self-test');
  expect(measured.maximumMs).toBeGreaterThan(50);
});

test('10 MiB mock document is responsive after readiness', async ({ page }) => {
  const openDuration = await openMockBody(page, TEN_MIB);
  const editor = page.getByRole('textbox', { name: 'Response body' });
  await expect(editor).toBeVisible();
  expect(openDuration).toBeLessThanOrEqual(400);

  const phases = [
    ['scroll', async () => {
      await page.locator('.cm-scroller').evaluate(element => {
        element.scrollTop = element.scrollHeight;
        element.dispatchEvent(new Event('scroll'));
      });
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    }],
    ['type', async () => {
      await editor.press('ControlOrMeta+End');
      await editor.press(' ');
    }],
    ['undo', async () => {
      await editor.press('ControlOrMeta+z');
    }],
    ['full-document-search', async () => {
      await editor.press('ControlOrMeta+f');
      const search = page.locator('.cm-search input').first();
      await search.fill('mockmate-e2e-tail');
      await expect(search).toHaveValue('mockmate-e2e-tail');
      await search.press('Escape');
    }],
    ['worker-validation', async () => {
      const before = (await workerEvidence(page)).requests.filter(value => value.operation === 'validate').length;
      await editor.press('ControlOrMeta+End');
      await editor.press(' ');
      await expect.poll(async () => {
        const evidence = await workerEvidence(page);
        const requests = evidence.requests.filter(value => value.operation === 'validate');
        const latest = requests.at(-1);
        return requests.length > before
          && latest !== undefined
          && evidence.responses.some(response => response.id === latest.id);
      }).toBe(true);
      await expect(page.getByRole('button', { name: 'Save Body' })).toBeEnabled();
    }],
    ['format-publication', async () => {
      const before = (await workerEvidence(page)).requests.filter(value => value.operation === 'format').length;
      await page.getByRole('button', { name: 'Format JSON' }).click();
      await expect.poll(async () => {
        const evidence = await workerEvidence(page);
        const requests = evidence.requests.filter(value => value.operation === 'format');
        const latest = requests.at(-1);
        return requests.length > before
          && latest !== undefined
          && evidence.responses.some(response => response.id === latest.id && response.ok);
      }).toBe(true);
      await expect(page.getByRole('button', { name: 'Format JSON' })).toBeEnabled();
    }],
  ] as const;

  for (const [phase, action] of phases) {
    const result = await measureLongTaskPhase(page, phase, action);
    expect(result).toEqual({ phase, maximumMs: expect.any(Number) });
    expect(result.maximumMs).toBeLessThanOrEqual(50);
  }
});
