import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { setImmediate as waitForImmediate } from 'node:timers/promises';

import { test as base, type Page } from '@playwright/test';

import { startServers, type ServerRuntimeOwner } from '../../packages/server/dist/app.js';
import type { AppState, EndpointDetail, Project } from '../../packages/server/dist/domain/model.js';
import { TRAFFIC_LIMITS } from '../../packages/server/dist/domain/traffic.js';
import { normalizeHttpOrigin } from '../../packages/server/dist/domain/http-origin.js';
import {
  createProcessTrafficContext,
  createRuntime,
  type RuntimeContext,
} from '../../packages/server/dist/runtime/create-runtime.js';
import { currentTrafficAppState } from '../../packages/server/dist/services/traffic-evidence.js';
import {
  extendCleanupManifest,
  readCleanupManifest,
  writeOwnerCloseReport,
  type CleanupManifest,
  type CleanupOwnerCloseReport,
} from '../../packages/server/dist/test-support/cleanup-report.js';

const TEN_MIB = 10 * 1024 * 1024;
const FIFTY_MIB = 50 * 1024 * 1024;
const LARGE_ENDPOINT_NAME = 'Large JSON 10 MiB';

export interface TrafficBrowserFixture {
  baseUrl: string;
  projectId: string;
  tenMiBAssetId: string;
  trafficIds: { text: string[]; binary: string; fiftyMiB: string };
  workflow: {
    endpointId: string;
    variantId: string;
    endpointName: string;
    partialStateId: string;
    partialStateName: string;
    activeStateId: string;
  };
  admin<T>(route: string, init?: RequestInit): Promise<T>;
  setActiveProject(projectId: string | null): Promise<void>;
  cleanupManifest(): CleanupManifest;
  closeOwners(): Promise<CleanupOwnerCloseReport>;
}

interface WorkerEvidence {
  urls: string[];
  requests: Array<{ id: number; operation: string }>;
  responses: Array<{ id: number; ok: boolean }>;
  mainThreadLargeJsonParses: number;
}

declare global {
  interface Window {
    __mockmateWorkerEvidence?: WorkerEvidence;
    __mockmateLongTaskPhases?: Record<string, {
      observer: PerformanceObserver;
      durations: number[];
    }>;
  }
}

function containedRoot(): string {
  const configured = process.env.MOCKMATE_E2E_ROOT;
  if (!configured || !path.isAbsolute(configured) || !/^mockmate-e2e-/.test(path.basename(configured))) {
    throw new Error('Traffic fixture requires a launcher-owned MOCKMATE_E2E_ROOT');
  }
  return path.resolve(configured);
}

async function rootState(root: string, relativePath: string): Promise<'absent' | 'empty' | 'contained'> {
  try {
    const stat = await fs.promises.stat(path.join(root, relativePath));
    if (stat.isDirectory() && (await fs.promises.readdir(path.join(root, relativePath))).length === 0) {
      return 'empty';
    }
    return 'contained';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
    throw error;
  }
}

async function jsonRequest<T>(baseUrl: string, route: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${baseUrl}${route}`, {
    ...init,
    headers: {
      ...(init.body === undefined || init.body instanceof Uint8Array
        ? {}
        : { 'Content-Type': 'application/json' }),
      ...init.headers,
    },
  });
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${route} failed: ${response.status} ${await response.text()}`);
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}

function exactJsonBody(byteCount: number): Buffer {
  const suffix = '","needle":"mockmate-e2e-tail"}';
  const prefix = '{"value":"';
  const fill = byteCount - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
  if (fill < 0) throw new RangeError('JSON body size is too small');
  const body = Buffer.from(`${prefix}${'x'.repeat(fill)}${suffix}`);
  if (body.byteLength !== byteCount) throw new Error('Large JSON fixture size is not exact');
  return body;
}

async function uploadBody(baseUrl: string, projectId: string, bytes: Buffer, mediaType: string) {
  const response = await fetch(`${baseUrl}/api/admin/projects/${projectId}/bodies`, {
    method: 'POST',
    headers: { 'Content-Type': mediaType },
    body: Uint8Array.from(bytes),
  });
  if (!response.ok) throw new Error(`Body upload failed: ${response.status} ${await response.text()}`);
  return response.json() as Promise<{ id: string; size: number; mediaType: string }>;
}

async function seedTraffic(
  runtime: RuntimeContext,
  projectId: string,
  pathName: string,
  byteCount: number,
  mediaType: string,
  byte = 0x78,
): Promise<string> {
  const appState = currentTrafficAppState(runtime.repository, projectId);
  const exchange = runtime.traffic.begin({
    projectId,
    requestId: randomUUID(),
    transport: 'https_mitm',
    allowlistPattern: 'traffic.example.test',
    origin: normalizeHttpOrigin('https://traffic.example.test'),
    method: 'GET',
    path: pathName,
    query: { ok: true, entries: [] },
    headers: [],
    appState,
  });
  exchange.setDecision({ decision: 'no_match_passthrough', appState });
  exchange.setResponse(200, [['Content-Type', mediaType], ['Content-Length', String(byteCount)]]);
  const chunk = Buffer.alloc(Math.min(64 * 1024, Math.max(byteCount, 1)), byte);
  const expectedHash = createHash('sha256');
  for (let offset = 0; offset < byteCount; offset += chunk.byteLength) {
    const observed = chunk.subarray(0, Math.min(chunk.byteLength, byteCount - offset));
    expectedHash.update(observed);
    exchange.observeResponse(observed);
    await waitForImmediate();
  }
  const detail = await exchange.finalize({ kind: 'response', status: 200, responseBytes: byteCount });
  const expectedSha256 = expectedHash.digest('hex');
  if (detail.response.body.state !== 'available'
    || detail.response.body.retainedSize !== byteCount
    || detail.response.body.sha256 !== expectedSha256) {
    throw new Error(`Traffic fixture ${pathName} was not retained exactly at ${byteCount} bytes: ${JSON.stringify({
      descriptor: detail.response.body,
      expectedSha256,
    })}`);
  }
  return exchange.trafficId;
}

async function createTrafficBrowserFixture(workerIndex: number): Promise<TrafficBrowserFixture> {
  const parentRoot = containedRoot();
  const runtimeRelative = `runtime-${workerIndex}`;
  const runtimeRoot = path.join(parentRoot, runtimeRelative);
  const certificateDirectory = path.join(runtimeRoot, 'certificates');
  let manifest = await extendCleanupManifest(parentRoot, {
    listeners: [`http:${workerIndex}`, `https:${workerIndex}`, `proxy:${workerIndex}`],
    socketOwners: [`server-runtime:${workerIndex}`],
    roots: [
      { owner: 'runtime', relativePath: runtimeRelative, afterOwnerClose: 'contained-until-parent-removal' },
      { owner: 'certificates', relativePath: `${runtimeRelative}/certificates`, afterOwnerClose: 'contained-until-parent-removal' },
      { owner: 'traffic-cache', relativePath: `${runtimeRelative}/traffic-cache`, afterOwnerClose: 'absent-or-empty' },
      { owner: 'body-staging', relativePath: `${runtimeRelative}/traffic-cache/incoming`, afterOwnerClose: 'absent-or-empty' },
    ],
  });
  await fs.promises.mkdir(path.join(runtimeRoot, 'projects', 'prj_invalid'), { recursive: true });
  await fs.promises.writeFile(
    path.join(runtimeRoot, 'projects', 'prj_invalid', 'current.json'),
    `${JSON.stringify({ schemaVersion: 999, generationId: 'gen_invalid' })}\n`,
    { flag: 'wx' },
  );

  let runtime: RuntimeContext | undefined;
  let owner: ServerRuntimeOwner | undefined;
  let closePromise: Promise<CleanupOwnerCloseReport> | undefined;
  const closeOwners = (): Promise<CleanupOwnerCloseReport> => {
    closePromise ??= (async () => {
      if (owner) await owner.close();
      else if (runtime) await runtime.dispose();
      manifest = await readCleanupManifest(parentRoot);
      const report: CleanupOwnerCloseReport = {
        manifest,
        closedListeners: [...manifest.listeners],
        closedSocketOwners: [...manifest.socketOwners],
        rootsAfterOwnerClose: await Promise.all(manifest.roots.map(async root => ({
          owner: root.owner,
          relativePath: root.relativePath,
          state: await rootState(parentRoot, root.relativePath),
        }))),
      };
      await writeOwnerCloseReport(parentRoot, report);
      return report;
    })();
    return closePromise;
  };

  try {
    runtime = await createRuntime({
      rootDirectory: runtimeRoot,
      processTraffic: createProcessTrafficContext(TRAFFIC_LIMITS),
      isAdminRequestLocal: () => true,
    });
    owner = await startServers({
      runtime,
      requestedPorts: { http: 0, https: 0, proxy: 0 },
      certificateDirectory,
    });
    const baseUrl = `http://127.0.0.1:${owner.ports.http}`;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const health = await fetch(`${baseUrl}/health`).catch(() => undefined);
      if (health?.ok) break;
      await new Promise(resolve => setTimeout(resolve, 20));
      if (attempt === 49) throw new Error('MockMate production server did not become healthy');
    }

    const admin = <T>(route: string, init?: RequestInit) => jsonRequest<T>(baseUrl, route, init);
    const project = await admin<Project>('/api/admin/projects', {
      method: 'POST', body: JSON.stringify({ name: 'Chromium Acceptance' }),
    });
    const workspace = await admin<{ revision: number }>('/api/admin/workspace');
    await admin('/api/admin/workspace', {
      method: 'PUT',
      body: JSON.stringify({ expectedRevision: workspace.revision, activeProjectId: project.id }),
    });
    const settings = await admin<{ revision: number }>(`/api/admin/projects/${project.id}/runtime-settings`);
    await admin(`/api/admin/projects/${project.id}/runtime-settings`, {
      method: 'PUT',
      body: JSON.stringify({
        expectedRevision: settings.revision,
        interceptHosts: ['traffic.example.test'],
        captureRawTraffic: true,
        debugProvenanceHeaders: false,
      }),
    });

    const smallAsset = await uploadBody(baseUrl, project.id, Buffer.from('{"ok":true}'), 'application/json');
    const tenMiBAsset = await uploadBody(baseUrl, project.id, exactJsonBody(TEN_MIB), 'application/json');
    if (tenMiBAsset.size !== TEN_MIB) throw new Error('10 MiB Body Asset was not seeded exactly');
    const workflowEndpoint = await admin<EndpointDetail>(`/api/admin/projects/${project.id}/endpoints`, {
      method: 'POST',
      body: JSON.stringify({
        name: 'Playback authorization',
        baseUrl: 'https://api.example.test',
        mode: 'mock',
        matcher: { method: 'GET', path: '/playback' },
        variants: [{
          name: 'Authorized', status: 200, responseHeaders: {}, bodyAssetId: smallAsset.id, delayMs: 0,
        }],
        defaultVariantIndex: 0,
      }),
    });
    const largeEndpoint = await admin<EndpointDetail>(`/api/admin/projects/${project.id}/endpoints`, {
      method: 'POST',
      body: JSON.stringify({
        name: LARGE_ENDPOINT_NAME,
        baseUrl: 'https://large.example.test',
        mode: 'mock',
        matcher: { method: 'GET', path: '/large-json' },
        variants: [{
          name: 'Exact 10 MiB', status: 200, responseHeaders: {}, bodyAssetId: tenMiBAsset.id, delayMs: 0,
        }],
        defaultVariantIndex: 0,
      }),
    });
    const allBindings = {
      [workflowEndpoint.id]: workflowEndpoint.defaultVariantId!,
      [largeEndpoint.id]: largeEndpoint.defaultVariantId!,
    };
    const activeState = await admin<AppState>(`/api/admin/projects/${project.id}/states`, {
      method: 'POST', body: JSON.stringify({ name: 'Active State', tags: [], bindings: allBindings }),
    });
    const partialState = await admin<AppState>(`/api/admin/projects/${project.id}/states`, {
      method: 'POST', body: JSON.stringify({ name: 'Expired session', tags: [], bindings: {} }),
    });
    const currentProject = await admin<Project>(`/api/admin/projects/${project.id}`);
    await admin(`/api/admin/projects/${project.id}/state-selection`, {
      method: 'PUT',
      body: JSON.stringify({
        expectedRevision: currentProject.revision,
        activeStateId: activeState.id,
      }),
    });

    const textIds = [];
    textIds.push(await seedTraffic(runtime, project.id, '/large-switch-one', TEN_MIB, 'text/plain', 0x61));
    textIds.push(await seedTraffic(runtime, project.id, '/large-switch-two', TEN_MIB, 'text/plain', 0x62));
    textIds.push(await seedTraffic(runtime, project.id, '/large-switch-three', TEN_MIB, 'text/plain', 0x63));
    const fiftyMiB = await seedTraffic(runtime, project.id, '/exact-fifty-mib', FIFTY_MIB, 'text/plain', 0x66);
    const binary = await seedTraffic(runtime, project.id, '/binary-download', 2 * 1024 * 1024, 'application/octet-stream', 0);

    return {
      baseUrl,
      projectId: project.id,
      tenMiBAssetId: tenMiBAsset.id,
      trafficIds: { text: textIds, binary, fiftyMiB },
      workflow: {
        endpointId: workflowEndpoint.id,
        variantId: workflowEndpoint.variants[0]!.id,
        endpointName: workflowEndpoint.name,
        partialStateId: partialState.id,
        partialStateName: partialState.name,
        activeStateId: activeState.id,
      },
      admin,
      async setActiveProject(projectId) {
        const current = await admin<{ revision: number }>('/api/admin/workspace');
        await admin('/api/admin/workspace', {
          method: 'PUT', body: JSON.stringify({ expectedRevision: current.revision, activeProjectId: projectId }),
        });
      },
      cleanupManifest: () => manifest,
      closeOwners,
    };
  } catch (error) {
    await closeOwners().catch(() => undefined);
    throw error;
  }
}

async function installWorkerEvidence(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const evidence: WorkerEvidence = {
      urls: [], requests: [], responses: [], mainThreadLargeJsonParses: 0,
    };
    Object.defineProperty(window, '__mockmateWorkerEvidence', { value: evidence, configurable: false });
    const NativeWorker = window.Worker;
    const WrappedWorker = new Proxy(NativeWorker, {
      construct(target, args) {
        const worker = Reflect.construct(target, args) as Worker;
        evidence.urls.push(String(args[0]));
        const nativePostMessage = worker.postMessage.bind(worker);
        worker.postMessage = ((message: unknown, options?: StructuredSerializeOptions | Transferable[]) => {
          if (message && typeof message === 'object') {
            const request = message as { id?: unknown; operation?: unknown };
            if (typeof request.id === 'number' && typeof request.operation === 'string') {
              evidence.requests.push({ id: request.id, operation: request.operation });
            }
          }
          return nativePostMessage(message, options as StructuredSerializeOptions);
        }) as Worker['postMessage'];
        worker.addEventListener('message', event => {
          const response = event.data as { id?: unknown; ok?: unknown };
          if (typeof response?.id === 'number' && typeof response.ok === 'boolean') {
            evidence.responses.push({ id: response.id, ok: response.ok });
          }
        });
        return worker;
      },
    });
    Object.defineProperty(window, 'Worker', { value: WrappedWorker, configurable: false });
    const nativeParse = JSON.parse;
    JSON.parse = ((text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown) => {
      if (text.length > 1024 * 1024) evidence.mainThreadLargeJsonParses += 1;
      return nativeParse(text, reviver);
    }) as typeof JSON.parse;
  });
}

type TrafficWorkerFixtures = {
  trafficFixture: TrafficBrowserFixture;
};

export const test = base.extend<{}, TrafficWorkerFixtures>({
  trafficFixture: [async ({}, use, workerInfo) => {
    const fixture = await createTrafficBrowserFixture(workerInfo.workerIndex);
    try {
      await use(fixture);
    } finally {
      await fixture.closeOwners();
    }
  }, { scope: 'worker' }],
  page: async ({ page, trafficFixture }, use) => {
    await installWorkerEvidence(page);
    await page.goto(trafficFixture.baseUrl);
    await use(page);
  },
});

export async function openMockBody(page: Page, byteCount: number): Promise<number> {
  if (byteCount !== TEN_MIB) throw new Error('The production opening gate requires the exact 10 MiB fixture');
  await page.getByRole('tab', { name: 'Endpoints' }).click();
  await page.getByText(LARGE_ENDPOINT_NAME, { exact: true }).first().click();
  const edit = page.getByRole('button', { name: 'Edit response body' });
  await edit.waitFor();
  const mark = `mock-body-open-${Date.now()}-${Math.random()}`;
  await page.evaluate(name => performance.mark(name), mark);
  await edit.click();
  const editor = page.getByRole('textbox', { name: 'Response body' });
  await editor.waitFor({ state: 'visible' });
  await editor.focus();
  await page.waitForFunction(() => (
    document.readyState === 'complete'
      && document.activeElement?.getAttribute('aria-label') === 'Response body'
      && document.activeElement?.getAttribute('contenteditable') === 'true'
  ));
  return page.evaluate(name => performance.now() - performance.getEntriesByName(name, 'mark').at(-1)!.startTime, mark);
}

export async function measureLongTaskPhase(
  page: Page,
  phase: string,
  action: () => Promise<void>,
): Promise<{ phase: string; maximumMs: number }> {
  await page.evaluate(name => {
    const durations: number[] = [];
    const observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) durations.push(entry.duration);
    });
    observer.observe({ type: 'longtask' });
    observer.takeRecords();
    window.__mockmateLongTaskPhases ??= {};
    window.__mockmateLongTaskPhases[name] = { observer, durations };
  }, phase);
  let actionError: unknown;
  try {
    await action();
  } catch (error) {
    actionError = error;
  }
  const maximumMs = await page.evaluate(async name => {
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const owned = window.__mockmateLongTaskPhases?.[name];
    if (!owned) throw new Error(`Missing Long Task observer for ${name}`);
    for (const entry of owned.observer.takeRecords()) owned.durations.push(entry.duration);
    owned.observer.disconnect();
    delete window.__mockmateLongTaskPhases![name];
    return Math.max(0, ...owned.durations);
  }, phase);
  if (actionError !== undefined) throw actionError;
  return { phase, maximumMs };
}

export type { WorkerEvidence };
