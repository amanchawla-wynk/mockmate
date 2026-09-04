import { expect, type Page, type Request } from '@playwright/test';

import { test } from './support/traffic-fixture';

const FIFTY_MIB = 50 * 1024 * 1024;

interface BodyRequestRecord {
  id: string;
  request: Request;
  started: number;
  settlement?: 'finished' | 'aborted' | 'failed';
}

function trafficId(request: Request): string | undefined {
  return /\/traffic\/([^/]+)\/bodies\/response$/.exec(new URL(request.url()).pathname)?.[1];
}

async function selectTraffic(page: Page, pathName: string): Promise<void> {
  await page.getByRole('button').filter({ hasText: pathName }).first().click();
}

test.describe.configure({ mode: 'serial' });

test('rapid large Traffic switching owns two loads, cancels the oldest, and reuses cache', async ({
  page,
  trafficFixture,
}) => {
  const records: BodyRequestRecord[] = [];
  let active = 0;
  let maximumActive = 0;
  await page.route(/\/traffic\/[^/]+\/bodies\/response(?:\?.*)?$/, async route => {
    const id = trafficId(route.request());
    if (id) {
      records.push({ id, request: route.request(), started: records.length });
      active += 1;
      maximumActive = Math.max(maximumActive, active);
    }
    await route.continue();
  });
  page.on('requestfinished', request => {
    const record = records.find(value => value.request === request);
    if (!record || record.settlement) return;
    record.settlement = 'finished';
    active -= 1;
  });
  page.on('requestfailed', request => {
    const record = records.find(value => value.request === request);
    if (!record || record.settlement) return;
    record.settlement = request.failure()?.errorText.includes('ERR_ABORTED') ? 'aborted' : 'failed';
    active -= 1;
  });

  await page.getByRole('tab', { name: 'Traffic' }).click();
  await expect(page.getByText('/large-switch-one', { exact: true })).toBeVisible();
  const paths = ['/large-switch-one', '/large-switch-two', '/large-switch-three'];
  await selectTraffic(page, paths[0]);
  await expect.poll(() => records.length).toBe(1);
  await selectTraffic(page, paths[1]);
  await expect.poll(() => records.length).toBe(2);
  const ownedBeforeThird = records.filter(record => !record.settlement).sort((a, b) => a.started - b.started);
  expect(ownedBeforeThird).toHaveLength(2);
  const oldestOwnedId = ownedBeforeThird[0]!.id;
  await selectTraffic(page, paths[2]);
  await expect.poll(() => records.length).toBe(3);
  await expect.poll(() => records.find(record => record.id === oldestOwnedId)?.settlement).toBe('aborted');
  expect(maximumActive).toBeLessThanOrEqual(2);
  await expect(page.getByRole('textbox', { name: 'Response exact body' })).toBeVisible();

  const cachedId = trafficFixture.trafficIds.text[2]!;
  const requestsBeforeRevisit = records.filter(record => record.id === cachedId).length;
  await selectTraffic(page, '/binary-download');
  await expect(page.getByText('Binary exact body is available as a download.')).toBeVisible();
  await page.evaluate(() => {
    const marker = { seen: false };
    Object.defineProperty(window, '__mockmateRevisitLoader', { value: marker, configurable: true });
    const observer = new MutationObserver(() => {
      if (document.querySelector('progress[aria-label="Response exact body progress"]')) marker.seen = true;
    });
    observer.observe(document.body, { childList: true, subtree: true });
    Object.defineProperty(marker, 'stop', { value: () => observer.disconnect() });
  });
  await selectTraffic(page, paths[2]);
  await expect(page.getByRole('textbox', { name: 'Response exact body' })).toBeVisible();
  const loaderSeen = await page.evaluate(() => {
    const marker = (window as typeof window & {
      __mockmateRevisitLoader?: { seen: boolean; stop(): void };
    }).__mockmateRevisitLoader!;
    marker.stop();
    return marker.seen;
  });
  expect(records.filter(record => record.id === cachedId)).toHaveLength(requestsBeforeRevisit);
  expect(loaderSeen).toBe(false);
  await expect(page.getByLabel('Response exact body progress')).toHaveCount(0);
});

test('exact 50 MiB Traffic progress remains responsive', async ({ page }) => {
  await page.getByRole('tab', { name: 'Traffic' }).click();
  await page.evaluate(() => {
    const probe = { values: [] as Array<{ value: number; max: number }>, frames: 0, running: true };
    Object.defineProperty(window, '__mockmateProgressProbe', { value: probe, configurable: true });
    const sample = () => {
      const progress = document.querySelector<HTMLProgressElement>(
        'progress[aria-label="Response exact body progress"]',
      );
      if (progress) probe.values.push({ value: progress.value, max: progress.max });
    };
    const observer = new MutationObserver(sample);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    const frame = () => {
      if (!probe.running) return;
      if (document.querySelector('progress[aria-label="Response exact body progress"]')) probe.frames += 1;
      sample();
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    Object.defineProperty(probe, 'stop', {
      value: () => { probe.running = false; observer.disconnect(); },
    });
  });
  await selectTraffic(page, '/exact-fifty-mib');
  const progress = page.getByLabel('Response exact body progress');
  await expect(progress).toBeVisible();
  await expect(progress).toHaveAttribute('max', String(FIFTY_MIB));
  await page.getByRole('button', { name: 'Live updates' }).click();
  await expect(page.getByRole('button', { name: 'Updates paused' })).toBeVisible();
  await expect.poll(async () => page.evaluate(() => (
    window as typeof window & { __mockmateProgressProbe?: { frames: number } }
  ).__mockmateProgressProbe!.frames)).toBeGreaterThanOrEqual(2);
  await expect(page.getByRole('textbox', { name: 'Response exact body' })).toBeVisible();
  const probe = await page.evaluate(() => {
    const owned = (window as typeof window & {
      __mockmateProgressProbe?: {
        values: Array<{ value: number; max: number }>;
        frames: number;
        stop(): void;
      };
    }).__mockmateProgressProbe!;
    owned.stop();
    return { values: owned.values, frames: owned.frames };
  });
  expect(probe.frames).toBeGreaterThanOrEqual(2);
  expect(probe.values.some(value => value.max === FIFTY_MIB)).toBe(true);
  expect(probe.values.some(value => value.value > 0 && value.value < FIFTY_MIB)).toBe(true);
});

test('binary Traffic exposes exact Download without constructing CodeMirror', async ({
  page,
  trafficFixture,
}) => {
  await page.getByRole('tab', { name: 'Traffic' }).click();
  await selectTraffic(page, '/binary-download');
  await expect(page.getByText('Binary exact body is available as a download.')).toBeVisible();
  const download = page.getByRole('link', { name: 'Download response body' });
  await expect(download).toHaveAttribute(
    'href',
    `/api/admin/projects/${trafficFixture.projectId}/traffic/${trafficFixture.trafficIds.binary}/bodies/response?download=1`,
  );
  await expect(page.locator('.cm-editor')).toHaveCount(0);
});
