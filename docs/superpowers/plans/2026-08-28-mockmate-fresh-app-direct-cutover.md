# MockMate Fresh-App Direct Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship MockMate as a fresh, schema-v3-only application whose server runtime, storage, admin APIs, and dashboard use Projects, Endpoints, Response Variants, App States, immutable Body Assets, and repository diagnostics without migration or compatibility code.

**Architecture:** Keep the existing TypeScript, Express, React, and Vite applications and the canonical repository completed in Tasks 1-6, but remove the obsolete Task 7 migration subsystem before adding dashboard foundations. Prepare canonical clients and worker-backed editors additively, then perform one atomic source-tree cutover in which production startup initializes an empty schema-v3 repository and every server/dashboard caller switches from Resource/Scenario persistence to `ProjectRepository`; follow that commit with isolated integration, performance, browser, and completion gates.

**Tech Stack:** TypeScript, Node.js filesystem/streams/crypto APIs, Express 4, Zod 4, React 19, Vite 7 Web Workers, Vitest, Supertest, Playwright 1.58.2, Chromium.

## Global Constraints

- Work only in `/Users/amanchawla/Documents/Projects/mockmate/.worktrees/mockmate-reliable-core`; the starting implementation HEAD is `e387d4b`.
- Tasks 1-6 are the accepted foundation. Preserve their canonical schemas, repository atomicity, compiled matcher, App State fallback, Body Asset streaming, static-file transactions, diagnostics, security, and response-stream ownership rules.
- Treat this release as a fresh application. Do not read, convert, select, rename, back up, restore, or delete legacy Resource/Scenario persistence.
- Do not create migration preview/apply commands, migration staging, pending cutover records, migration finalization, migration backup, migration rollback, source retirement, workspace reconciliation, dual runtime modes, or repository-backed legacy admin adapters.
- Every persisted canonical record and pointer remains strict `schemaVersion: 3`; a clean root starts with `workspace.json`, `projects/`, and `trash/`, with no active Project and workspace revision `0`.
- Production startup must construct and initialize the canonical repository before creating listeners. Unit and integration tests must inject a temporary root/repository and must never initialize or delete the developer's configured data root.
- Summary requests remain body-free. Endpoint details load only after selection, and Body Asset bytes load only when the body editor is explicitly opened.
- Draft identity is Project ID + Endpoint ID + Variant ID + base Variant revision + Body Asset ID. A conflict or upload failure preserves local text and any uploaded-but-unlinked Body Asset.
- Normal editable body upload remains capped at exactly 10 MiB. Body Assets remain immutable, SHA-256-addressed, binary-safe, lazily loaded, and streamed without `Buffer.concat` or a whole-body application copy.
- Keep stable IDs in paths and references; display names never participate in identity. Encode every dashboard ID path segment with `encodeURIComponent`.
- Preserve `undefined` as no change and explicit `null` as clear; persisted cleared optional fields are omitted.
- Preserve the structured admin error contract: `code`, `message`, optional `path`, optional `details`, optional `recovery`, and `requestId`. Revision conflicts are `409` with `details.currentRevision`; schema/JSON/integrity failures are `422`; no response exposes body content or secret filesystem paths.
- Preserve the existing light shell and current visual density. This plan does not implement the deferred state-first visual redesign.
- Defer device pairing/assignment, lossless bundles, proxy protocol rewrites, deterministic sequences, range/midstream fault behavior, HLS/DASH, WebSocket/SSE scenarios, DRM/license work, and import-adapter fidelity improvements.
- Use strict red-green-refactor. Add the stated failing test, run the exact RED command, make the minimum implementation pass, run the exact GREEN command, and create exactly one independently reviewable commit per task.
- Before each task, run `graphify query` with that task's question because `graphify-out/graph.json` exists. After source or documentation edits, run `graphify update .`; Graphify output is an index, not source of truth.
- Never stage `.superpowers/`, `graphify-out/`, an ignored root `package-lock.json`, generated output, temporary fixture data, or unrelated files. Stage only the exact paths named by the task's commit command after inspecting `git status --short` and `git diff -- <task paths>`.
- Do not reset or rewrite the six obsolete Task 7 commits (`e98afe4`, `8320d53`, `cc60c8d`, `14b5a22`, `91756a9`, `7817b46`). Preserve them in Git history and remove their files with the normal Task 1 commit.

---

### Task 1: Remove Migration Scope And Supersede The Old Plan

**Files:**
- Create: `packages/server/src/domain/fresh-app-scope.test.ts`
- Create: `docs/superpowers/plans/2026-08-27-mockmate-release-2-versioned-core.md`
- Modify: `packages/server/src/domain/model.ts:93-105`
- Modify: `packages/server/src/domain/schemas.ts:1-154`
- Modify: `packages/server/src/domain/schemas.test.ts`
- Modify: `packages/server/src/domain/validation.ts:42-69`
- Modify: `docs/superpowers/specs/2026-08-27-mockmate-reliable-core-design.md`
- Delete: `packages/server/src/migration/legacy-schemas.ts`
- Delete: `packages/server/src/migration/types.ts`
- Delete: `packages/server/src/migration/discover.ts`
- Delete: `packages/server/src/migration/convert.ts`
- Delete: `packages/server/src/migration/convert.test.ts`
- Delete: `packages/server/src/migration/__fixtures__/minimal-inline/project.json`
- Delete: `packages/server/src/migration/__fixtures__/minimal-inline/resources/minimal.json`
- Delete: `packages/server/src/migration/__fixtures__/full-inline/project.json`
- Delete: `packages/server/src/migration/__fixtures__/full-inline/resources/full.json`
- Delete: `packages/server/src/migration/__fixtures__/full-inline/static_files/poster.bin`
- Delete: `packages/server/src/migration/__fixtures__/fixture-backed-binary/project.json`
- Delete: `packages/server/src/migration/__fixtures__/fixture-backed-binary/resources/binary.json`
- Delete: `packages/server/src/migration/__fixtures__/fixture-backed-binary/fixtures/binary.http`
- Delete: `packages/server/src/migration/__fixtures__/shared-partial-states/project.json`
- Delete: `packages/server/src/migration/__fixtures__/shared-partial-states/resources/auth.json`
- Delete: `packages/server/src/migration/__fixtures__/shared-partial-states/resources/profile.json`
- Delete: `packages/server/src/migration/__fixtures__/ambiguous/project.json`
- Delete: `packages/server/src/migration/__fixtures__/ambiguous/resources/first.json`
- Delete: `packages/server/src/migration/__fixtures__/ambiguous/resources/second.json`
- Delete: `packages/server/src/migration/__fixtures__/corrupt/project.json`
- Delete: `packages/server/src/migration/__fixtures__/corrupt/resources/bad.json`
- Delete: `packages/server/src/migration/__fixtures__/unsafe-path/project.json`
- Delete: `packages/server/src/migration/__fixtures__/unsafe-path/resources/unsafe.json`

**Interfaces:**
- Consumes: the review-clean Task 1-6 repository at `e387d4b` and the approved fresh-app design.
- Produces: canonical domain exports with no `PendingMigrationCutover`, no `packages/server/src/migration/` tree, unsupported-version recovery that tells a fresh-app developer to reset the configured data directory, and durable documentation that marks the migration-era plan as non-executable.

- [ ] **Step 1: Query the graph and prove the accepted foundation is green**

Run:

```bash
graphify query "Which Task 7 migration files and PendingMigrationCutover references can be removed without changing the Task 1-6 repository, matcher, routes, or response writer?" --budget 2500
npm run test --workspace=packages/server -- --run src/domain/schemas.test.ts src/repository/atomic-write.test.ts src/repository/body-store.test.ts src/repository/referential-integrity.test.ts src/repository/project-repository.test.ts src/repository/compile-project.test.ts src/routes/admin/versioned-core.test.ts src/services/response-writer.test.ts
```

Expected: Graphify identifies `packages/server/src/migration/**` and `PendingMigrationCutover` as migration-only; all named Task 1-6 tests PASS before removal.

- [ ] **Step 2: Add the failing fresh-app scope test**

Create `packages/server/src/domain/fresh-app-scope.test.ts`:

```ts
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import * as model from './model';
import * as schemas from './schemas';
import { parsePersistedRecord } from './validation';
import { ProjectSchema } from './schemas';

const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

it('contains no migration subsystem or pending-cutover domain export', () => {
  expect(existsSync(path.join(srcRoot, 'migration'))).toBe(false);
  expect(model).not.toHaveProperty('PendingMigrationCutover');
  expect(schemas).not.toHaveProperty('PendingMigrationCutoverSchema');
});

it('gives fresh-install recovery for an unsupported schema version', () => {
  const result = parsePersistedRecord(ProjectSchema, {
    schemaVersion: 2,
    id: 'prj_old',
    name: 'Unsupported',
    revision: 0,
    createdAt: '2026-08-28T00:00:00.000Z',
    updatedAt: '2026-08-28T00:00:00.000Z',
  }, 'projects/prj_old/project.json');

  expect(result).toEqual({
    ok: false,
    findings: [expect.objectContaining({
      code: 'UNSUPPORTED_SCHEMA_VERSION',
      recovery: 'Reset the configured MockMate data directory and restart the fresh schema-v3 application.',
    })],
  });
  expect(JSON.stringify(result)).not.toMatch(/migrat|backup|rollback/i);
});

it('keeps production domain sources free of the migration-only symbol', () => {
  const sources = ['model.ts', 'schemas.ts', 'validation.ts']
    .map(file => readFileSync(path.join(srcRoot, 'domain', file), 'utf8'))
    .join('\n');
  expect(sources).not.toContain('PendingMigrationCutover');
});
```

- [ ] **Step 3: Run the scope test and verify RED**

Run: `npm run test --workspace=packages/server -- --run src/domain/fresh-app-scope.test.ts`

Expected: FAIL because `src/migration/` exists, both pending-cutover exports exist, and unsupported-version recovery still says to run a migration.

- [ ] **Step 4: Remove migration code and migration-only schema behavior**

Delete the complete `packages/server/src/migration/` tree listed above. Remove this interface from `domain/model.ts` and its import/schema from `domain/schemas.ts`:

```ts
export interface PendingMigrationCutover {
  schemaVersion: 3;
  phase: 'prepared' | 'ready';
  projectId: string;
  legacyDirectory: string;
  stagingDirectory: string;
  targetDirectory: string;
  sourceTreeSha256: string;
  targetTreeSha256: string;
  expectedWorkspaceActiveProjectId?: string;
  expectedWorkspaceRevision: number;
}
```

Remove `validPendingCutover`, `PendingMigrationCutoverSchema`, and the pending-cutover rows from `domain/schemas.test.ts`. Retain unsupported-version classification, but change its exact recovery to:

```ts
recovery: 'Reset the configured MockMate data directory and restart the fresh schema-v3 application.'
```

The tests for field-level validation must continue to assert that only the top-level `schemaVersion` receives `UNSUPPORTED_SCHEMA_VERSION`; no test or production message should recommend migration.

- [ ] **Step 5: Supersede migration assumptions in durable documentation**

Create `docs/superpowers/plans/2026-08-27-mockmate-release-2-versioned-core.md` as an archival marker rather than copying the obsolete executable plan:

```md
# MockMate Release 2 Versioned Core Plan (Superseded)

**Status:** Superseded on 2026-08-28 by `2026-08-28-mockmate-fresh-app-direct-cutover.md`.

The migration-era plan assumed persisted production Resource/Scenario data. MockMate has no production installations or user data, so its migration discovery, conversion, backup, rollback, pending-cutover, finalization, and compatibility-adapter tasks must not be implemented.

Tasks 1-6 remain the accepted canonical repository foundation. Use the fresh-app direct-cutover plan for all remaining work. The six historical Task 7 commits remain in Git history and their files are removed by a normal follow-up commit.
```

Update `docs/superpowers/specs/2026-08-27-mockmate-reliable-core-design.md` with these exact decisions:

```md
**Fresh-app scope update (2026-08-28):** The migration, backup, rollback, and dual-model requirements in this document are superseded by `2026-08-28-mockmate-fresh-app-cutover-design.md`. Tasks 1-6 remain authoritative; remaining delivery is schema-v3-only and provides no legacy-data compatibility.
```

Change the summary from “in-place migration” to “in-place domain and persistence replacement.” Remove the migration goal, `migration-backups/` layout line, the “Migration From The Current Model” procedure, migration tests, migration delivery item, and migration acceptance criterion. Replace the removed migration section with:

```md
## Fresh Schema-V3 Cutover

Production starts from an empty schema-v3 workspace and never discovers Resource/Scenario persistence. The server runtime, admin API, and dashboard switch to the canonical repository in one source-tree commit; no migration, backup, rollback, pending-cutover, or compatibility subsystem is shipped.
```

Replace the multi-file repository sentence with “Project creation and future bundle import build and validate a complete immutable generation before atomically replacing `current.json`; prior generations remain immutable repository history.” Change “repairs precede or accompany migration” to “repairs are part of the reliable-core foundation.” Change the final gate to “All repository, integration, dashboard, performance, test, lint, and build gates pass.” These edits leave no operative migration or rollback requirement elsewhere in the old design.

- [ ] **Step 6: Verify removal and the Task 1-6 baseline**

Run:

```bash
npm run test --workspace=packages/server -- --run src/domain/fresh-app-scope.test.ts src/domain/schemas.test.ts src/repository/atomic-write.test.ts src/repository/body-store.test.ts src/repository/referential-integrity.test.ts src/repository/project-repository.test.ts src/repository/compile-project.test.ts src/routes/admin/versioned-core.test.ts src/services/response-writer.test.ts
test ! -d packages/server/src/migration
git grep -n "PendingMigrationCutover\|PendingMigrationCutoverSchema" -- packages/server/src || true
```

Expected: all named tests PASS; `test ! -d` exits `0`; the grep prints no matches.

- [ ] **Step 7: Update Graphify and commit the reviewed removal**

Run: `graphify update .`

Expected: the graph drops Task 7 migration nodes and records documentation changes. Leave every `graphify-out/` change unstaged.

Inspect: `git status --short` and `git diff -- packages/server/src/domain packages/server/src/migration docs/superpowers/specs/2026-08-27-mockmate-reliable-core-design.md docs/superpowers/plans`

Commit:

```bash
git add packages/server/src/domain/model.ts packages/server/src/domain/schemas.ts packages/server/src/domain/schemas.test.ts packages/server/src/domain/validation.ts packages/server/src/domain/fresh-app-scope.test.ts
git add -u packages/server/src/migration
git add docs/superpowers/specs/2026-08-27-mockmate-reliable-core-design.md docs/superpowers/plans/2026-08-27-mockmate-release-2-versioned-core.md docs/superpowers/plans/2026-08-28-mockmate-fresh-app-direct-cutover.md
git commit -m "refactor: remove obsolete migration scope"
```

---

### Task 2: Add Canonical Dashboard Contracts And Abort-Safe Lazy Hooks

**Files:**
- Modify: `packages/dashboard/src/api/types.ts`
- Modify: `packages/dashboard/src/api/client.ts`
- Modify: `packages/dashboard/src/api/client.test.ts`
- Create: `packages/dashboard/src/hooks/useEndpoints.ts`
- Create: `packages/dashboard/src/hooks/useStates.ts`
- Create: `packages/dashboard/src/hooks/useBodyAsset.ts`
- Create: `packages/dashboard/src/hooks/useRepositoryDiagnostics.ts`
- Create: `packages/dashboard/src/hooks/useVersionedProjects.ts`
- Create: `packages/dashboard/src/hooks/versioned-core-hooks.test.tsx`

**Interfaces:**
- Consumes: canonical Task 4 server routes, dashboard `ApiClientError`, and the existing Testing Library/Vitest setup.
- Produces: additive `CanonicalProject`/Endpoint/Variant/App State/Body Asset/diagnostic contracts, `versionedProjectsApi`, `endpointsApi`, `variantsApi`, `statesApi`, `bodiesApi`, `diagnosticsApi`, and abort-safe summary/detail/body hooks. Legacy dashboard exports remain unchanged until Task 4's atomic cutover.

- [ ] **Step 1: Query the graph**

Run: `graphify query "How do dashboard api/client.ts, useProjects, useResources, and canonical server admin routes connect, and where can additive canonical hooks remain isolated until direct cutover?" --budget 2500`

Expected: the query identifies `api/types.ts`, `api/client.ts`, legacy hooks, and `routes/admin/{projects,endpoints,states,bodies,diagnostics}.ts` without requiring production server changes.

- [ ] **Step 2: Add failing client and hook tests**

Add these cases to `api/client.test.ts` and `hooks/versioned-core-hooks.test.tsx`:

```tsx
it('loads endpoint summaries without details or body requests', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(jsonResponse([endpointSummary]));
  const { result } = renderHook(() => useEndpoints('prj_1'));
  await waitFor(() => expect(result.current.endpoints).toEqual([endpointSummary]));
  expect(requests()).toEqual(['/api/admin/projects/prj_1/endpoints']);
});

it('aborts stale endpoint detail when selection changes', async () => {
  const pending = deferredFetches();
  vi.mocked(fetch).mockImplementation(pending.fetch);
  const { result } = renderHook(() => useEndpoints('prj_1'));
  act(() => result.current.selectEndpoint('ep_1'));
  act(() => result.current.selectEndpoint('ep_2'));
  expect(pending.signals[0].aborted).toBe(true);
  expect(pending.signals[1].aborted).toBe(false);
});

it('does not download a body until explicitly opened', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(binaryResponse('body', 'application/json'));
  const { result } = renderHook(() => useBodyAsset('prj_1'));
  expect(requests()).toEqual([]);
  await act(() => result.current.open('a'.repeat(64)));
  expect(requests()).toEqual([`/api/admin/projects/prj_1/bodies/${'a'.repeat(64)}`]);
});

it('uploads raw bytes without JSON wrapping', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(bodyAsset, { status: 201 }));
  const blob = new Blob(['{"a":1}'], { type: 'application/json' });
  const controller = new AbortController();
  await bodiesApi.upload('prj_1', blob, controller.signal);
  const [, init] = vi.mocked(fetch).mock.calls[0];
  expect(init?.body).toBe(blob);
  expect(init?.signal).toBe(controller.signal);
  expect(init?.headers).toMatchObject({ 'Content-Type': 'application/json' });
});

it('preserves conflict metadata on ApiClientError', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({
    code: 'REVISION_CONFLICT',
    message: 'Variant changed',
    details: { currentRevision: 4 },
    recovery: 'Reload or merge the server version.',
    requestId: 'req_1',
  }, { status: 409 }));
  await expect(variantsApi.update('prj_1', 'ep_1', 'var_1', 3, { name: 'Local' }))
    .rejects.toMatchObject({
      code: 'REVISION_CONFLICT',
      currentRevision: 4,
      recovery: 'Reload or merge the server version.',
      requestId: 'req_1',
    });
});

it('encodes every stable ID segment', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(emptyResponse(204));
  await variantsApi.delete('project/a', 'endpoint?b', 'variant#c', 2);
  expect(requests()[0]).toBe('/api/admin/projects/project%2Fa/endpoints/endpoint%3Fb/variants/variant%23c');
});

it('loads global and Project diagnostics independently', async () => {
  vi.mocked(fetch)
    .mockResolvedValueOnce(jsonResponse({ diagnostics: [corruptProject] }))
    .mockResolvedValueOnce(jsonResponse({ projectId: 'prj_1', diagnostics: [corruptEndpoint] }));
  const global = renderHook(() => useRepositoryDiagnostics());
  await waitFor(() => expect(global.result.current.diagnostics).toEqual([corruptProject]));
  global.unmount();
  const project = renderHook(() => useRepositoryDiagnostics('prj_1'));
  await waitFor(() => expect(project.result.current.diagnostics).toEqual([corruptEndpoint]));
  expect(requests()).toEqual(['/api/admin/diagnostics', '/api/admin/projects/prj_1/diagnostics']);
});
```

- [ ] **Step 3: Run dashboard contract tests and verify RED**

Run: `npm run test --workspace=packages/dashboard -- --run src/api/client.test.ts src/hooks/versioned-core-hooks.test.tsx`

Expected: FAIL because canonical types, clients, and hooks do not exist.

- [ ] **Step 4: Add exact canonical dashboard contracts**

Add these API-facing contracts to `api/types.ts`; their fields must match `packages/server/src/domain/model.ts` and `services/traffic-provenance.ts` exactly:

```ts
export type MatchExpression =
  | { operator: 'equals'; value: string }
  | { operator: 'glob'; value: string };

export interface CanonicalProject {
  schemaVersion: 3;
  id: string;
  name: string;
  description?: string;
  baseUrl?: string;
  activeStateId?: string;
  baseStateId?: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export type CanonicalProjectSummary = Pick<CanonicalProject, 'id' | 'name' | 'description' | 'revision' | 'updatedAt'>;
export interface WorkspaceState { schemaVersion: 3; activeProjectId?: string; revision: number }
export interface ProjectRuntimeSettings { schemaVersion: 3; projectId: string; passthroughEnabled: boolean; interceptHosts: string[]; captureRawTraffic: boolean; revision: number }
export interface ResponseVariant { id: string; endpointId: string; name: string; description?: string; status: number; responseHeaders: Record<string, string>; bodyAssetId?: string; delayMs?: number; revision: number }
export type ResponseVariantSummary = Pick<ResponseVariant, 'id' | 'name' | 'status' | 'delayMs' | 'revision'> & { hasBody: boolean };
export interface EndpointDetail { schemaVersion: 3; id: string; projectId: string; name: string; description?: string; matcher: { method: string; host?: string; path: string; query?: Record<string, MatchExpression>; headers?: Record<string, MatchExpression> }; defaultVariantId: string; variants: ResponseVariant[]; revision: number }
export type EndpointSummary = Omit<EndpointDetail, 'description' | 'matcher' | 'variants'> & { matcher: Pick<EndpointDetail['matcher'], 'method' | 'host' | 'path'>; variants: ResponseVariantSummary[] };
export interface AppState { schemaVersion: 3; id: string; projectId: string; name: string; description?: string; tags: string[]; expectedUi?: string; bindings: Record<string, string>; revision: number }
export interface AppStateSummary extends Pick<AppState, 'id' | 'projectId' | 'name' | 'tags' | 'revision'> { boundEndpointCount: number; totalEndpointCount: number; missingEndpointIds: string[] }
export interface BodyAsset { schemaVersion: 3; id: string; mediaType: string; size: number; encoding?: string; createdAt: string }
export interface RepositoryDiagnostic { severity: 'warning' | 'blocking'; code: string; file: string; path?: string; message: string; recovery: string; projectId?: string; requestId?: string }
export type ProjectPatch = Partial<Pick<CanonicalProject, 'name'>> & { description?: string | null; baseUrl?: string | null };
export type EndpointPatch = Partial<Pick<EndpointDetail, 'name' | 'matcher' | 'defaultVariantId'>> & { description?: string | null };
export type VariantPatch = Partial<Pick<ResponseVariant, 'name' | 'status' | 'responseHeaders'>> & { description?: string | null; bodyAssetId?: string | null; delayMs?: number | null };
export type AppStatePatch = Partial<Pick<AppState, 'name' | 'tags' | 'bindings'>> & { description?: string | null; expectedUi?: string | null };
export type RuntimeSettingsPatch = Partial<Omit<ProjectRuntimeSettings, 'schemaVersion' | 'projectId' | 'revision'>>;
export type CreateProjectInput = Pick<CanonicalProject, 'name'> & Pick<Partial<CanonicalProject>, 'description' | 'baseUrl'>;
export type CreateVariantInput = Omit<ResponseVariant, 'id' | 'endpointId' | 'revision'>;
export type CreateEndpointInput = Omit<EndpointDetail, 'schemaVersion' | 'id' | 'projectId' | 'revision' | 'variants' | 'defaultVariantId'> & { variants: CreateVariantInput[]; defaultVariantIndex: number };
export type CreateAppStateInput = Omit<AppState, 'schemaVersion' | 'id' | 'projectId' | 'revision'>;
export interface StateSelectionInput { activeStateId?: string | null; baseStateId?: string | null; allowFallback: boolean }
```

Extend `ApiClientError` with `readonly currentRevision?: number`, derived only when `details` is an object with a non-negative integer `currentRevision`.

- [ ] **Step 5: Implement exact canonical clients and abort-safe hooks**

Add these client signatures to `api/client.ts` while retaining the old clients until Task 4:

```ts
export const versionedProjectsApi: {
  list(signal?: AbortSignal): Promise<CanonicalProjectSummary[]>;
  get(projectId: string, signal?: AbortSignal): Promise<CanonicalProject>;
  create(input: CreateProjectInput): Promise<CanonicalProject>;
  update(projectId: string, expectedRevision: number, patch: ProjectPatch): Promise<CanonicalProject>;
  delete(projectId: string, expectedRevision: number): Promise<void>;
  getWorkspace(signal?: AbortSignal): Promise<WorkspaceState>;
  setActive(projectId: string | null, expectedRevision: number): Promise<WorkspaceState>;
  getRuntimeSettings(projectId: string, signal?: AbortSignal): Promise<ProjectRuntimeSettings>;
  updateRuntimeSettings(projectId: string, expectedRevision: number, patch: RuntimeSettingsPatch): Promise<ProjectRuntimeSettings>;
};
export const endpointsApi: {
  list(projectId: string, signal?: AbortSignal): Promise<EndpointSummary[]>;
  get(projectId: string, endpointId: string, signal?: AbortSignal): Promise<EndpointDetail>;
  create(projectId: string, input: CreateEndpointInput): Promise<EndpointDetail>;
  update(projectId: string, endpointId: string, expectedRevision: number, patch: EndpointPatch): Promise<EndpointDetail>;
  delete(projectId: string, endpointId: string, expectedRevision: number): Promise<void>;
};
export const variantsApi: {
  create(projectId: string, endpointId: string, expectedEndpointRevision: number, input: CreateVariantInput): Promise<ResponseVariant>;
  update(projectId: string, endpointId: string, variantId: string, expectedRevision: number, patch: VariantPatch): Promise<ResponseVariant>;
  delete(projectId: string, endpointId: string, variantId: string, expectedRevision: number): Promise<void>;
};
export const statesApi: {
  list(projectId: string, signal?: AbortSignal): Promise<AppStateSummary[]>;
  get(projectId: string, stateId: string, signal?: AbortSignal): Promise<AppState>;
  create(projectId: string, input: CreateAppStateInput): Promise<AppState>;
  update(projectId: string, stateId: string, expectedRevision: number, patch: AppStatePatch): Promise<AppState>;
  delete(projectId: string, stateId: string, expectedRevision: number): Promise<void>;
  setSelection(projectId: string, expectedProjectRevision: number, input: StateSelectionInput): Promise<CanonicalProject>;
};
export const bodiesApi: {
  download(projectId: string, assetId: string, signal?: AbortSignal): Promise<Response>;
  upload(projectId: string, body: Blob, signal?: AbortSignal): Promise<BodyAsset>;
};
export const diagnosticsApi: {
  listAll(signal?: AbortSignal): Promise<{ diagnostics: RepositoryDiagnostic[] }>;
  list(projectId: string, signal?: AbortSignal): Promise<{ projectId: string; diagnostics: RepositoryDiagnostic[] }>;
};
```

Use one `AbortController` per active list/detail/body request. Cleanup aborts in-flight work. A new Project ID or selected detail ID aborts the previous request before dispatching the next. Ignore `AbortError`; expose other errors without clearing the last successful result. `useBodyAsset(projectId)` starts with `{ asset: undefined, response: undefined, loading: false }` and makes no request until `open(assetId)`.

Expose these exact hook surfaces:

```ts
export interface UseEndpointsResult { endpoints: EndpointSummary[]; selectedEndpoint?: EndpointDetail; selectedEndpointId?: string; loading: boolean; detailLoading: boolean; error?: ApiClientError; selectEndpoint(id: string | undefined): void; refresh(): Promise<void> }
export function useEndpoints(projectId: string | undefined): UseEndpointsResult;
export interface UseStatesResult { states: AppStateSummary[]; selectedState?: AppState; selectedStateId?: string; loading: boolean; detailLoading: boolean; error?: ApiClientError; selectState(id: string | undefined): void; refresh(): Promise<void> }
export function useStates(projectId: string | undefined): UseStatesResult;
export interface UseBodyAssetResult { assetId?: string; response?: Response; loading: boolean; error?: ApiClientError; open(assetId: string): Promise<Response>; close(): void }
export function useBodyAsset(projectId: string | undefined): UseBodyAssetResult;
export function useRepositoryDiagnostics(projectId?: string): { diagnostics: RepositoryDiagnostic[]; loading: boolean; error?: ApiClientError; refresh(): Promise<void> };
export function useVersionedProjects(): { projects: CanonicalProjectSummary[]; workspace?: WorkspaceState; activeProject?: CanonicalProject; loading: boolean; error?: ApiClientError; refresh(): Promise<void>; create(input: CreateProjectInput): Promise<CanonicalProject>; update(projectId: string, expectedRevision: number, patch: ProjectPatch): Promise<CanonicalProject>; setActive(projectId: string | null, expectedRevision: number): Promise<WorkspaceState>; remove(projectId: string, expectedRevision: number): Promise<void> };
```

- [ ] **Step 6: Verify dashboard data boundaries**

Run:

```bash
npm run test --workspace=packages/dashboard -- --run src/api/client.test.ts src/hooks/versioned-core-hooks.test.tsx
npx tsc -p packages/dashboard/tsconfig.app.json --noEmit
```

Expected: both test files PASS; TypeScript exits `0`; list requests contain no body download and stale detail requests are aborted.

- [ ] **Step 7: Update Graphify and commit canonical dashboard foundations**

Run: `graphify update .`

Inspect: `git status --short` and `git diff -- packages/dashboard/src/api packages/dashboard/src/hooks`

Commit:

```bash
git add packages/dashboard/src/api/types.ts packages/dashboard/src/api/client.ts packages/dashboard/src/api/client.test.ts packages/dashboard/src/hooks/useEndpoints.ts packages/dashboard/src/hooks/useStates.ts packages/dashboard/src/hooks/useBodyAsset.ts packages/dashboard/src/hooks/useRepositoryDiagnostics.ts packages/dashboard/src/hooks/useVersionedProjects.ts packages/dashboard/src/hooks/versioned-core-hooks.test.tsx
git commit -m "feat: add canonical dashboard contracts"
```

---

### Task 3: Add Worker Validation And Revision-Aware Body Editors

**Files:**
- Create: `packages/dashboard/src/workers/json.worker.ts`
- Create: `packages/dashboard/src/workers/json-worker-client.ts`
- Create: `packages/dashboard/src/workers/json-worker-client.test.ts`
- Create: `packages/dashboard/src/state/bodyDrafts.ts`
- Create: `packages/dashboard/src/state/bodyDrafts.test.ts`
- Create: `packages/dashboard/src/components/BodyEditor.tsx`
- Create: `packages/dashboard/src/components/BodyEditor.test.tsx`
- Create: `packages/dashboard/src/components/VariantEditor.tsx`
- Create: `packages/dashboard/src/components/VariantEditor.test.tsx`

**Interfaces:**
- Consumes: Task 2 cancellation-aware `bodiesApi.download`/`bodiesApi.upload`, `variantsApi`, canonical Body Asset/Variant contracts, and `useUnsavedChangesGuard`.
- Produces: `JsonWorkerClient`, project/endpoint/variant/revision/asset-keyed `BodyDraft`, lazy `BodyEditor`, and conflict-safe `VariantEditor` with owned download/upload lifecycles that remain additive until Task 4.

- [ ] **Step 1: Query the graph**

Run: `graphify query "How do ScenarioEditor, JsonEditor, scenario drafts, useUnsavedChangesGuard, bodiesApi, and variantsApi constrain an isolated canonical BodyEditor and VariantEditor?" --budget 2500`

Expected: the query identifies legacy editor call sites that must remain untouched in this task and the existing unsaved-navigation API to reuse.

- [ ] **Step 2: Add failing worker, draft, and editor tests**

Create the four test files with these concrete cases:

```tsx
it('validates and formats through the worker protocol', async () => {
  const client = createJsonWorkerClient(fakeWorker);
  const validation = client.validate('{"a":1}');
  fakeWorker.respond({ id: fakeWorker.lastId(), ok: true });
  await expect(validation).resolves.toEqual({ ok: true });
  const formatting = client.format('{"a":1}');
  fakeWorker.respond({ id: fakeWorker.lastId(), ok: true, formatted: '{\n  "a": 1\n}' });
  await expect(formatting).resolves.toEqual({ ok: true, formatted: '{\n  "a": 1\n}' });
  expect(fakeWorker.messages.map(message => message.operation)).toEqual(['validate', 'format']);
});

it('rejects all pending worker promises on dispose', async () => {
  const client = createJsonWorkerClient(fakeWorker);
  const pending = client.validate('{}');
  client.dispose();
  await expect(pending).rejects.toThrow('JSON worker disposed');
  expect(fakeWorker.terminate).toHaveBeenCalledOnce();
});

it('keys drafts by Project, Endpoint, Variant, revision, and asset', () => {
  const base = { projectId: 'prj_1', endpointId: 'ep_1', variantId: 'var_1', baseVariantRevision: 3, assetId: 'a'.repeat(64) };
  const keys = [
    bodyDraftKey(base),
    bodyDraftKey({ ...base, projectId: 'prj_2' }),
    bodyDraftKey({ ...base, endpointId: 'ep_2' }),
    bodyDraftKey({ ...base, variantId: 'var_2' }),
    bodyDraftKey({ ...base, baseVariantRevision: 4 }),
    bodyDraftKey({ ...base, assetId: 'b'.repeat(64) }),
  ];
  expect(new Set(keys).size).toBe(keys.length);
});

it('blocks invalid JSON after a 300 ms debounce and formats only on command', async () => {
  vi.useFakeTimers();
  render(<BodyEditor initialText="{}" mediaType="application/json" workerClient={workerClient} onChange={vi.fn()} />);
  await userEvent.type(screen.getByLabelText('Response body'), '{bad');
  expect(workerClient.validate).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(300);
  expect(workerClient.validate).toHaveBeenCalledWith(expect.stringContaining('{bad'));
  workerClient.validation.resolve({ ok: false, message: 'Invalid JSON' });
  expect(await screen.findByText('Invalid JSON')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Save Body' })).toBeDisabled();
  expect(workerClient.format).not.toHaveBeenCalled();
});

it('loads the body lazily and preserves text after upload failure', async () => {
  render(<VariantEditor projectId="prj_1" endpoint={endpoint} variant={variant} onSaved={vi.fn()} />);
  expect(bodiesApi.download).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: 'Edit response body' }));
  expect(bodiesApi.download).toHaveBeenCalledWith('prj_1', variant.bodyAssetId, expect.any(AbortSignal));
  await userEvent.clear(await screen.findByLabelText('Response body'));
  await userEvent.type(screen.getByLabelText('Response body'), '{"local":true}');
  vi.mocked(bodiesApi.upload).mockRejectedValueOnce(new Error('offline'));
  await userEvent.click(screen.getByRole('button', { name: 'Save Body' }));
  expect(bodiesApi.upload).toHaveBeenCalledWith(
    'prj_1', expect.any(Blob), expect.any(AbortSignal),
  );
  expect(screen.getByLabelText('Response body')).toHaveValue('{"local":true}');
});

it('aborts an in-flight body upload on unmount', async () => {
  const upload = deferredUpload();
  vi.mocked(bodiesApi.upload).mockImplementation((_projectId, _body, signal) => {
    upload.signal = signal;
    return upload.promise;
  });
  const { unmount } = render(
    <VariantEditor projectId="prj_1" endpoint={endpoint} variant={variant} onSaved={vi.fn()} />,
  );
  await openBodyAndReplace('{"large":"local"}');
  await userEvent.click(screen.getByRole('button', { name: 'Save Body' }));
  expect(upload.signal).toEqual(expect.any(AbortSignal));
  unmount();
  expect(upload.signal?.aborted).toBe(true);
});

it('aborts upload on draft identity change without clearing text or a completed pending asset', async () => {
  const upload = deferredUpload();
  vi.mocked(bodiesApi.upload)
    .mockResolvedValueOnce(pendingAsset)
    .mockImplementationOnce((_projectId, _body, signal) => {
      upload.signal = signal;
      return upload.promise;
    });
  const { rerender } = render(
    <VariantEditor projectId="prj_1" endpoint={endpoint} variant={variant} onSaved={vi.fn()} />,
  );
  await openBodyAndReplace('{"first":"local"}');
  await userEvent.click(screen.getByRole('button', { name: 'Save Body' }));
  await userEvent.clear(screen.getByLabelText('Response body'));
  await userEvent.type(screen.getByLabelText('Response body'), '{"second":"local"}');
  await userEvent.click(screen.getByRole('button', { name: 'Save Body' }));
  rerender(
    <VariantEditor projectId="prj_1" endpoint={otherEndpoint} variant={otherVariant} onSaved={vi.fn()} />,
  );
  expect(upload.signal?.aborted).toBe(true);
  rerender(
    <VariantEditor projectId="prj_1" endpoint={endpoint} variant={variant} onSaved={vi.fn()} />,
  );
  expect(screen.getByLabelText('Response body')).toHaveValue('{"second":"local"}');
  expect(screen.getByText('Pending body uploaded')).toBeVisible();
});

it('omits bodyAssetId from metadata-only saves with or without an existing body', async () => {
  const { bodyAssetId: _bodyAssetId, ...bodylessVariant } = variant;
  for (const candidate of [variant, bodylessVariant]) {
    vi.mocked(variantsApi.update).mockResolvedValue(candidate);
    const { unmount } = render(
      <VariantEditor projectId="prj_1" endpoint={endpoint} variant={candidate} onSaved={vi.fn()} />,
    );
    const renamed = candidate.bodyAssetId ? 'Renamed with body' : 'Renamed bodyless';
    await userEvent.clear(screen.getByLabelText('Variant name'));
    await userEvent.type(screen.getByLabelText('Variant name'), renamed);
    await userEvent.click(screen.getByRole('button', { name: 'Save Variant' }));
    await waitFor(() => expect(variantsApi.update).toHaveBeenLastCalledWith(
      'prj_1', endpoint.id, candidate.id, candidate.revision, { name: renamed },
    ));
    const patch = vi.mocked(variantsApi.update).mock.calls.at(-1)?.[4];
    expect(patch).not.toHaveProperty('bodyAssetId');
    unmount();
  }
});

it('sends an explicit body detach only after the remove-body action', async () => {
  const { bodyAssetId: _bodyAssetId, ...detachedVariant } = variant;
  vi.mocked(variantsApi.update).mockResolvedValue(detachedVariant);
  render(<VariantEditor projectId="prj_1" endpoint={endpoint} variant={variant} onSaved={vi.fn()} />);
  await userEvent.click(screen.getByRole('button', { name: 'Remove response body' }));
  await userEvent.click(screen.getByRole('button', { name: 'Save Variant' }));
  await waitFor(() => expect(variantsApi.update).toHaveBeenCalledWith(
    'prj_1', endpoint.id, variant.id, variant.revision, { bodyAssetId: null },
  ));
});

it('preserves local text and a pending uploaded asset after revision conflict', async () => {
  vi.mocked(bodiesApi.upload).mockResolvedValue(pendingAsset);
  vi.mocked(variantsApi.update).mockRejectedValue(revisionConflict(4));
  render(<VariantEditor projectId="prj_1" endpoint={endpoint} variant={variant} onSaved={vi.fn()} />);
  await openBodyAndReplace('{"local":true}');
  await userEvent.click(screen.getByRole('button', { name: 'Save Body' }));
  await userEvent.click(screen.getByRole('button', { name: 'Save Variant' }));
  expect(screen.getByLabelText('Response body')).toHaveValue('{"local":true}');
  expect(screen.getByText('Pending body uploaded')).toBeVisible();
  expect(screen.getByText('Server revision 4')).toBeVisible();
});
```

- [ ] **Step 3: Run editor tests and verify RED**

Run: `npm run test --workspace=packages/dashboard -- --run src/workers/json-worker-client.test.ts src/state/bodyDrafts.test.ts src/components/BodyEditor.test.tsx src/components/VariantEditor.test.tsx`

Expected: FAIL because the worker protocol, drafts, and canonical editors do not exist.

- [ ] **Step 4: Implement the worker protocol with a statically analyzable Vite URL**

Use these exact protocol and client contracts:

```ts
export type JsonWorkerRequest =
  | { id: number; operation: 'validate'; text: string }
  | { id: number; operation: 'format'; text: string };
export type JsonWorkerResponse =
  | { id: number; ok: true; formatted?: string }
  | { id: number; ok: false; message: string; position?: number };
export interface JsonWorkerClient {
  validate(text: string): Promise<JsonWorkerResponse>;
  format(text: string): Promise<JsonWorkerResponse>;
  dispose(): void;
}
export function createJsonWorkerClient(worker: Worker): JsonWorkerClient;
export function createBrowserJsonWorkerClient(): JsonWorkerClient {
  return createJsonWorkerClient(new Worker(new URL('./json.worker.ts', import.meta.url), { type: 'module' }));
}
```

`json.worker.ts` performs `JSON.parse` for validation and `JSON.stringify(JSON.parse(text), null, 2)` for formatting, catches only parse/format errors, and posts one response with the request ID. The React tree never calls `JSON.parse` or `JSON.stringify` on body text. `dispose()` removes listeners, terminates the worker, and rejects every pending request.

- [ ] **Step 5: Implement revision and asset-keyed drafts**

Use these exact contracts in `state/bodyDrafts.ts`:

```ts
export interface BodyDraftKey {
  projectId: string;
  endpointId: string;
  variantId: string;
  baseVariantRevision: number;
  assetId?: string;
}
export interface BodyDraft {
  key: BodyDraftKey;
  text: string;
  mediaType: string;
  validity: 'unknown' | 'valid' | 'invalid';
  validationMessage?: string;
  pendingAsset?: BodyAsset;
  serverVariant?: ResponseVariant; // Only when an actual server Variant is available.
  dirty: boolean;
}
export function bodyDraftKey(key: BodyDraftKey): string {
  return JSON.stringify([
    key.projectId,
    key.endpointId,
    key.variantId,
    key.baseVariantRevision,
    key.assetId ?? null,
  ]);
}
```

Store drafts in `Map<string, BodyDraft>`. Creating a draft clones the key and text. Updating one draft returns a new map and cannot mutate another key. Discard removes only the exact serialized key.

- [ ] **Step 6: Implement lazy `BodyEditor` and conflict-safe `VariantEditor`**

Use these component surfaces:

```ts
export interface BodyEditorProps {
  initialText: string;
  mediaType: string;
  workerClient: JsonWorkerClient;
  pendingAsset?: BodyAsset;
  uploadError?: string;
  onChange(text: string, mediaType: string, validity: BodyDraft['validity'], validationMessage?: string): void;
  onSaveBody(text: string, mediaType: string): Promise<void>;
}
export function BodyEditor(props: BodyEditorProps): JSX.Element;

export interface VariantEditorProps {
  projectId: string;
  endpoint: EndpointDetail;
  variant: ResponseVariant;
  onDirtyChange?(key: string, dirty: boolean): void;
  onSaved(endpointId: string, variant: ResponseVariant): void;
}
export function VariantEditor(props: VariantEditorProps): JSX.Element;
```

Opening the editor downloads only `variant.bodyAssetId`; a bodyless variant opens as empty text with `application/octet-stream`. `VariantEditor` owns separate download and upload `AbortController`s. Abort either operation on unmount or draft-key identity change; starting a replacement upload also aborts the prior upload. Debounce JSON validation by exactly 300 ms for `application/json` and media types ending in `+json`; non-JSON text is immediately valid. `Save Body` creates a `Blob` from the exact current text and media type, passes the upload controller signal to `bodiesApi.upload`, records the returned immutable asset without changing the Variant, and clears `detachBodyRequested`. An aborted or stale upload cannot clear local text, a previously completed pending asset, or detach intent. Only the currently owned upload may update upload state. The explicit `Remove response body` action clears any pending asset and sets `detachBodyRequested`; absence of a pending asset never implies detach.

Construct the Variant patch exactly as follows, so metadata-only saves and bodyless Variants without a new upload omit `bodyAssetId`, while only the deliberate remove-body action sends `null`:

```ts
const bodyPatch: Pick<VariantPatch, 'bodyAssetId'> = detachBodyRequested
  ? { bodyAssetId: null }
  : pendingAsset !== undefined
    ? { bodyAssetId: pendingAsset.id }
    : {};
const patch: VariantPatch = { ...metadataPatch, ...bodyPatch };
await variantsApi.update(projectId, endpoint.id, variant.id, variant.revision, patch);
```

`undefined` means no change and must never be added to the patch. Media type is stored in the keyed draft, and a media-type-only edit is dirty. On success, clear the old draft and call `onSaved`; on `409`, retain text/pending asset and expose the accurate `currentRevision`. Set `serverVariant` only when an actual server Variant is present in the API response; the current conflict response does not provide one. Integrate `onDirtyChange(bodyDraftKey(key), dirty)` so Task 4 can route Project, Endpoint, Variant, App State, and view changes through `useUnsavedChangesGuard`.

Do not edit `ScenarioEditor`, `JsonEditor`, `scenario-drafts.ts`, `App.tsx`, or legacy call sites in this task.

- [ ] **Step 7: Verify worker, draft, editor, and production-build behavior**

Run:

```bash
npm run test --workspace=packages/dashboard -- --run src/workers/json-worker-client.test.ts src/state/bodyDrafts.test.ts src/components/BodyEditor.test.tsx src/components/VariantEditor.test.tsx
npx tsc -p packages/dashboard/tsconfig.app.json --noEmit
npm run build --workspace=packages/dashboard
```

Expected: tests PASS; typecheck exits `0`; the additive, currently unreachable worker constructor compiles with its statically analyzable Vite URL and the build exits `0`. Task 3 does not require an emitted worker asset before the editor is imported by the production application.

- [ ] **Step 8: Update Graphify and commit safe body editing**

Run: `graphify update .`

Inspect: `git status --short` and `git diff -- packages/dashboard/src/workers packages/dashboard/src/state packages/dashboard/src/components/BodyEditor.tsx packages/dashboard/src/components/BodyEditor.test.tsx packages/dashboard/src/components/VariantEditor.tsx packages/dashboard/src/components/VariantEditor.test.tsx`

Commit:

```bash
git add packages/dashboard/src/workers/json.worker.ts packages/dashboard/src/workers/json-worker-client.ts packages/dashboard/src/workers/json-worker-client.test.ts packages/dashboard/src/state/bodyDrafts.ts packages/dashboard/src/state/bodyDrafts.test.ts packages/dashboard/src/components/BodyEditor.tsx packages/dashboard/src/components/BodyEditor.test.tsx packages/dashboard/src/components/VariantEditor.tsx packages/dashboard/src/components/VariantEditor.test.tsx
git commit -m "feat: add revision-safe body editing"
```

---

### Task 4: Cut Server And Dashboard Directly To Schema V3

**Files:**
- Create: `packages/server/src/runtime/create-runtime.ts`
- Create: `packages/server/src/runtime/create-runtime.test.ts`
- Create: `packages/server/src/routes/admin/traffic.ts`
- Create: `packages/server/src/routes/admin/imports.ts`
- Create: `packages/server/src/routes/admin/repository-integrations.test.ts`
- Create: `packages/server/src/test-support/proxy-test-client.ts`
- Create: `packages/server/src/repository/match-expression.ts`
- Create: `packages/server/src/repository/match-expression.test.ts`
- Modify: `packages/server/src/repository/compile-project.ts`
- Modify: `packages/server/src/repository/compile-project.test.ts`
- Modify: `packages/server/src/repository/project-repository.ts`
- Modify: `packages/server/src/repository/project-repository.test.ts`
- Modify: `packages/server/src/routes/admin.ts`
- Modify: `packages/server/src/routes/admin.test.ts`
- Modify: `packages/server/src/routes/automation.ts`
- Modify: `packages/server/src/routes/mock.ts`
- Modify: `packages/server/src/routes/static-files.ts`
- Modify: `packages/server/src/services/intercept.ts`
- Modify: `packages/server/src/services/logger.ts`
- Modify: `packages/server/src/services/logger.test.ts`
- Modify: `packages/server/src/services/logger.test-d.ts`
- Modify: `packages/server/src/services/proxy.ts`
- Modify: `packages/server/src/services/proxy-handler.ts`
- Modify: `packages/server/src/services/proxy-handler.test.ts`
- Modify: `packages/server/src/services/proxy-server.ts`
- Modify: `packages/server/src/services/storage.ts`
- Modify: `packages/server/src/services/storage.test.ts`
- Modify: `packages/server/src/types.ts`
- Modify: `packages/server/src/app.ts`
- Modify: `packages/server/src/app.test.ts`
- Modify: `packages/server/src/index.ts`
- Modify: `packages/server/src/scripts/import-xstream-automation.ts`
- Delete: `packages/server/src/scripts/migrate-auth-scenarios.ts`
- Delete: `packages/server/src/scripts/migrate-auth-scenarios-logic.ts`
- Delete: `packages/server/src/scripts/migrate-auth-scenarios-logic.test.ts`
- Delete: `packages/server/src/services/projects.ts`
- Delete: `packages/server/src/services/projects.test.ts`
- Delete: `packages/server/src/services/resources.ts`
- Delete: `packages/server/src/services/resources.test.ts`
- Delete: `packages/server/src/services/scenario-ids.ts`
- Delete: `packages/server/src/services/scenario-ids.test.ts`
- Delete: `packages/server/src/services/matcher.ts`
- Delete: `packages/server/src/services/matcher.test.ts`
- Delete: `packages/server/src/services/fixtures.ts`
- Delete: `packages/server/src/services/fixtures.test.ts`
- Delete: `packages/server/src/services/update-semantics.ts`
- Delete: `packages/server/src/services/update-semantics.test.ts`
- Delete: `packages/server/src/utils/slugify.ts`
- Delete: `packages/server/src/utils/slugify.test.ts`
- Create: `packages/dashboard/src/components/EndpointList.tsx`
- Create: `packages/dashboard/src/components/EndpointList.test.tsx`
- Create: `packages/dashboard/src/components/EndpointEditor.tsx`
- Create: `packages/dashboard/src/components/EndpointEditor.test.tsx`
- Create: `packages/dashboard/src/components/AppStateSwitcher.tsx`
- Create: `packages/dashboard/src/components/AppStateSwitcher.test.tsx`
- Create: `packages/dashboard/src/components/AppStateEditor.tsx`
- Create: `packages/dashboard/src/components/AppStateEditor.test.tsx`
- Create: `packages/dashboard/src/components/RepositoryDiagnostics.tsx`
- Create: `packages/dashboard/src/components/RepositoryDiagnostics.test.tsx`
- Modify: `packages/dashboard/src/App.tsx`
- Modify: `packages/dashboard/src/App.test.tsx`
- Modify: `packages/dashboard/src/components/Layout.tsx`
- Modify: `packages/dashboard/src/components/ProjectModal.tsx`
- Modify: `packages/dashboard/src/components/ProjectList.tsx`
- Modify: `packages/dashboard/src/components/ProjectList.test.tsx`
- Modify: `packages/dashboard/src/components/HeadersTable.test.tsx`
- Modify: `packages/dashboard/src/components/HookLintRepairs.test.tsx`
- Modify: `packages/dashboard/src/components/PassthroughSettings.tsx`
- Modify: `packages/dashboard/src/components/StaticFilesView.tsx`
- Modify: `packages/dashboard/src/components/TrafficView.tsx`
- Modify: `packages/dashboard/src/components/TrafficView.test.tsx`
- Modify: `packages/dashboard/src/components/LogsView.tsx`
- Modify: `packages/dashboard/src/components/UpdateForms.test.tsx`
- Modify: `packages/dashboard/src/hooks/useLogs.ts`
- Modify: `packages/dashboard/src/hooks/useLogs.test.tsx`
- Modify: `packages/dashboard/src/hooks/useProjects.ts`
- Modify: `packages/dashboard/src/hooks/versioned-core-hooks.test.tsx`
- Modify: `packages/dashboard/src/api/types.ts`
- Modify: `packages/dashboard/src/api/client.ts`
- Modify: `packages/dashboard/src/api/client.test.ts`
- Delete: `packages/dashboard/src/hooks/useVersionedProjects.ts`
- Delete: `packages/dashboard/src/hooks/useResources.ts`
- Delete: `packages/dashboard/src/components/ResourceList.tsx`
- Delete: `packages/dashboard/src/components/ResourceEditor.tsx`
- Delete: `packages/dashboard/src/components/ScenarioSwitcher.tsx`
- Delete: `packages/dashboard/src/components/BaseScenarioSwitcher.tsx`
- Delete: `packages/dashboard/src/components/ScenarioEditor.tsx`
- Delete: `packages/dashboard/src/components/ScenarioEditor.test.tsx`
- Delete: `packages/dashboard/src/components/JsonEditor.tsx`
- Delete: `packages/dashboard/src/components/scenario-drafts.ts`

**Interfaces:**
- Consumes: Tasks 1-3, canonical admin routes, `ProjectRepository`, compiled `ResolvedMock`, `writeResolvedResponse`, canonical traffic provenance, and Release 1 security/CORS boundaries.
- Produces: one canonical runtime factory, repository-only direct/proxy/automation/import/static/traffic paths, an empty first-start workspace, canonical dashboard UI and names, no `coreMode`, no legacy service/type/UI imports, and no intermediate compatibility API.

- [ ] **Step 1: Query the graph for every cutover caller**

Run: `graphify query "Enumerate every production caller of services/projects, services/resources, services/matcher, services/fixtures, Resource, Scenario, activeScenario, coreMode, legacy admin routes, and dashboard Resource/Scenario components that must move in one direct cutover." --budget 5000`

Expected: the result includes startup/app, admin, mock, proxy, automation, imports, static files, logger/traffic, dashboard clients/hooks/components, and tests. Save the output for comparison while editing, but do not stage Graphify files.

- [ ] **Step 2: Add failing first-start and repository-only server tests**

Add these tests to `runtime/create-runtime.test.ts`, `repository/project-repository.test.ts`, and `routes/admin/repository-integrations.test.ts`:

```ts
it('initializes a clean root as an empty schema-v3 workspace', async () => {
  const rootDirectory = await temporaryRoot();
  const runtime = await createRuntime({ rootDirectory, isAdminRequestLocal: () => true });
  expect(runtime.repository.getWorkspaceState()).toEqual({ schemaVersion: 3, revision: 0 });
  expect(runtime.repository.listProjects()).toEqual([]);
  expect(JSON.parse(await fs.promises.readFile(path.join(rootDirectory, 'workspace.json'), 'utf8')))
    .toEqual({ schemaVersion: 3, revision: 0 });
  expect((await fs.promises.stat(path.join(rootDirectory, 'projects'))).isDirectory()).toBe(true);
  expect((await fs.promises.stat(path.join(rootDirectory, 'trash'))).isDirectory()).toBe(true);
});

it('restarts the fresh workspace without manufacturing a Project', async () => {
  const first = await createRuntime({ rootDirectory, isAdminRequestLocal: () => true });
  const second = await createRuntime({ rootDirectory, isAdminRequestLocal: () => true });
  expect(second.repository.getWorkspaceState()).toEqual(first.repository.getWorkspaceState());
  expect(second.repository.listProjects()).toEqual([]);
});

it('requires an initialized repository when constructing the app', () => {
  expect(() => createApp({ repository: undefined as never, isAdminRequestLocal: () => true }))
    .toThrow('MockMate requires an initialized ProjectRepository');
});

it('resolves direct traffic only through the active canonical Project', async () => {
  await seedProject(repository, { active: true, path: '/playback', body: Buffer.from('allowed') });
  const response = await request(createApp({ repository, isAdminRequestLocal: () => true })).get('/playback');
  expect(response.status).toBe(200);
  expect(response.text).toBe('allowed');
  await repository.setActiveProject(null, repository.getWorkspaceState().revision);
  const inactive = await request(createApp({ repository, isAdminRequestLocal: () => true })).get('/playback');
  expect(inactive.status).toBe(503);
  expect(inactive.body).toMatchObject({ code: 'NO_ACTIVE_PROJECT', requestId: expect.any(String) });
});

it('creates a Body Asset, Endpoint, and Variant from captured traffic', async () => {
  const created = await createMockFromTraffic(repository, capturedEntry);
  expect(created).toMatchObject({
    endpointId: expect.stringMatching(/^ep_/),
    variantId: expect.stringMatching(/^var_/),
    bodyAssetId: capturedSha256,
  });
  expect(JSON.stringify(repository.listEndpoints(projectId))).not.toContain(capturedBody.toString());
});

it.each([
  ['cURL', () => importCurlThroughRepository(repository, curlFixture)],
  ['Postman', () => importPostmanThroughRepository(repository, postmanFixture)],
])('writes %s imports through ProjectRepository', async (_name, runImport) => {
  await runImport();
  expect(repository.listEndpoints(projectId)).toHaveLength(1);
  expect(repository.listEndpoints(projectId)[0].variants[0].hasBody).toBe(true);
});

it('switches automation by stable App State ID', async () => {
  await request(app).put('/setMockServerflags').send({ projectId, stateId: 'state_paid' }).expect(204);
  expect(repository.getProject(projectId).activeStateId).toBe('state_paid');
});

it('serves canonical static bytes through repository paths', async () => {
  await repository.putStaticFile(projectId, 'posters/home.bin', Readable.from(Buffer.from([0, 255, 1, 254])), {
    mediaType: 'application/octet-stream', maxBytes: 1024,
  });
  const response = await request(app).get('/static_files/posters/home.bin').buffer(true);
  expect(Buffer.from(response.body)).toEqual(Buffer.from([0, 255, 1, 254]));
});
```

Also add a source-boundary test that walks `packages/server/src` and excludes `*.test.ts`/`test-support/**`, then asserts no production file imports `services/projects`, `services/resources`, `services/matcher`, `services/fixtures`, or `scenario-ids`, and no source contains `coreMode`, `PendingMigrationCutover`, or a case-insensitive match for `migration`, `backup`, `rollback`, or `compatib`.

- [ ] **Step 3: Add failing canonical dashboard cutover tests**

Create/update the component tests with these cases:

```tsx
it('lists Endpoint summaries without loading body content', async () => {
  render(<App />);
  await screen.findByText('Playback authorization');
  expect(screen.getByText('5 variants')).toBeVisible();
  expect(requestLog()).not.toContainEqual(expect.stringContaining('/bodies/'));
});

it('loads one Endpoint detail after selection', async () => {
  render(<EndpointList endpoints={[endpointSummary]} selectedEndpointId={undefined} onSelect={onSelect} onCreate={vi.fn()} />);
  await userEvent.click(screen.getByText('Playback authorization'));
  expect(onSelect).toHaveBeenCalledWith('ep_playback');
});

it('requires fallback acknowledgement before activating a partial App State', async () => {
  render(<AppStateSwitcher project={project} states={[partialState]} endpoints={[endpointSummary]} onActivated={vi.fn()} />);
  await userEvent.click(screen.getByRole('button', { name: 'Activate Expired session' }));
  expect(screen.getByText('2 endpoints will fall back')).toBeVisible();
  expect(statesApi.setSelection).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: 'Activate with fallback' }));
  expect(statesApi.setSelection).toHaveBeenCalledWith('prj_1', 7, { activeStateId: 'state_expired', allowFallback: true });
});

it('saves App State bindings by stable Endpoint and Variant IDs', async () => {
  render(<AppStateEditor state={state} endpoints={[endpointDetail]} onSaved={vi.fn()} onDirtyChange={vi.fn()} />);
  await userEvent.selectOptions(screen.getByLabelText('Playback authorization variant'), 'var_denied');
  await userEvent.click(screen.getByRole('button', { name: 'Save App State' }));
  expect(statesApi.update).toHaveBeenCalledWith('prj_1', 'state_1', 3, { bindings: { ep_playback: 'var_denied' } });
});

it('shows corruption recovery and diagnostic request IDs with no active Project', async () => {
  render(<RepositoryDiagnostics diagnostics={[{ ...corruptEndpoint, requestId: 'req_42' }]} />);
  expect(screen.getByText(corruptEndpoint.recovery)).toBeVisible();
  expect(screen.getByText('Request req_42')).toBeVisible();
});

it('creates, selects, updates settings, clears selection, and deletes by revision', async () => {
  render(<App />);
  await createProjectNamed('Streaming UI');
  expect(projectsApi.create).toHaveBeenCalledWith({ name: 'Streaming UI' });
  expect(projectsApi.setActive).toHaveBeenCalledWith('prj_1', 0);
  await enablePassthroughAndSave();
  expect(projectsApi.updateRuntimeSettings).toHaveBeenCalledWith('prj_1', 0, { passthroughEnabled: true });
  await deleteActiveProject();
  expect(projectsApi.setActive).toHaveBeenCalledWith(null, 1);
  expect(projectsApi.delete).toHaveBeenCalledWith('prj_1', project.revision);
});

it('guards dirty App State navigation with Stay and Discard', async () => {
  render(<App />);
  await screen.findByRole('tab', { name: 'App States' });
  await editExpectedUi('Error banner');
  await userEvent.click(screen.getByRole('tab', { name: 'Traffic' }));
  expect(screen.getByRole('dialog', { name: 'Unsaved changes' })).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: 'Stay' }));
  expect(screen.getByRole('tab', { name: 'App States' })).toHaveAttribute('aria-selected', 'true');
});

it('renders canonical traffic provenance', () => {
  render(<TrafficView logs={[fallbackTraffic]} selectedLog={fallbackTraffic} {...trafficProps} />);
  expect(screen.getByText('project_base_state')).toBeVisible();
  expect(screen.getByText('active_state_unbound')).toBeVisible();
  expect(screen.getByText('var_default')).toBeVisible();
});
```

- [ ] **Step 4: Run the direct-cutover tests and verify RED**

Run:

```bash
npm run test --workspace=packages/server -- --run src/runtime/create-runtime.test.ts src/routes/admin/repository-integrations.test.ts src/app.test.ts
npm run test --workspace=packages/dashboard -- --run src/components/EndpointList.test.tsx src/components/EndpointEditor.test.tsx src/components/AppStateSwitcher.test.tsx src/components/AppStateEditor.test.tsx src/components/RepositoryDiagnostics.test.tsx src/App.test.tsx src/components/TrafficView.test.tsx
```

Expected: server tests FAIL because production startup/runtime still use legacy services and no runtime factory exists; dashboard tests FAIL because the shell still renders Resources/Scenarios.

- [ ] **Step 5: Implement a test-injected canonical runtime and fresh first start**

Use these exact boundaries:

```ts
export interface CreateRuntimeOptions extends AdminSecurityOptions {
  rootDirectory: string;
  fileSystem?: FileSystem;
}
export interface RuntimeContext {
  rootDirectory: string;
  repository: ProjectRepository;
  app: Application;
}
export async function createRuntime(options: CreateRuntimeOptions): Promise<RuntimeContext>;

export interface AppOptions extends AdminSecurityOptions {
  repository: ProjectRepository;
}
export function createApp(options: AppOptions): Application;

export async function startServers(
  ports: ServerPorts,
  runtime: RuntimeContext,
): Promise<ServerInstances>;
```

`createRuntime` creates one `AtomicFileWriter`, one `BodyStore`, and one `ProjectRepository` rooted at `options.rootDirectory`, calls `repository.initialize()`, and passes only the initialized repository to `createApp`. `ProjectRepository.initialize()` must atomically write `{ schemaVersion: 3, revision: 0 }` when `workspace.json` is absent, then create `projects/` and `trash/`; restart reads the existing file and does not increment revision. An invalid existing workspace remains a blocking diagnostic and is never overwritten.

`index.ts` obtains `getStorageConfig().baseDir`, creates the runtime, and then calls `startServers`. `startServers` injects the repository into HTTP, HTTPS, and proxy paths. Delete `startServer`, all default `createApp()` behavior, and `coreMode`; no production caller can construct a legacy app or an app without a repository. Tests always call `createRuntime` with `mkdtemp` output or inject an initialized repository directly into `createApp`.

Retain `config.json` only for server ports and `certs/` only for Release 1 certificate lifecycle. Remove legacy active-project fields and every legacy project/resource filesystem helper from `services/storage.ts`; repository storage is exclusively `workspace.json`, `projects/`, and `trash/` under the configured root.

- [ ] **Step 6: Switch all server runtime and storage callers together**

Use factories that make repository ownership explicit:

```ts
export function createMockRequestHandler(repository: ProjectRepository): RequestHandler;
export function createAutomationRouter(repository: ProjectRepository): Router;
export function createStaticFilesRouter(repository: ProjectRepository): Router;
export function createTrafficRouter(repository: ProjectRepository): Router;
export function createImportsRouter(repository: ProjectRepository): Router;
export interface ProxyServerOptions { port: number; caCert: string; caKey: string; repository: ProjectRepository }
export interface CreatedMock { endpointId: string; variantId: string; bodyAssetId?: string }
export async function createMockFromTraffic(repository: ProjectRepository, entry: RequestLogEntry): Promise<CreatedMock>;
```

For every direct or intercepted request, read `repository.getWorkspaceState()` once. If `activeProjectId` is absent, return structured `503 NO_ACTIVE_PROJECT`. Otherwise read `Project` and `ProjectRuntimeSettings`, call `repository.resolve(activeProjectId, matchRequest)`, and pass the result plus the repository's `getBody`/`openBody` methods to `writeResolvedResponse`. Matching never reads files or bodies.

Proxy only when `settings.passthroughEnabled && project.baseUrl`. Interception uses only `settings.interceptHosts`; remove the old base-URL compatibility fallback. Inject the repository into `createProxyServer` and both plain HTTP and CONNECT/TLS handlers. Keep upstream proxy response behavior and Release 1 certificate tests unchanged.

Canonical request logs use `services/traffic-provenance.ts` fields: `selectedStateId`, `endpointId`, `variantId`, `resolutionSource`, `fallbackReasons`, optional `bodyAssetId`, status, duration, bounded previews, and sizes. Remove `resourceId`, `scenario`, `scenarioId`, `scenarioSource`, and `scenarioFromHeader` from server/dashboard runtime types. Keep project-scoped cursor pagination and bounded previews.

Traffic `Mock This` uploads captured response bytes with `repository.putBody`, creates/reuses an Endpoint by canonical matcher, creates a Variant by stable ID, and optionally updates an App State binding by revision. It does not write `.http` fixtures. cURL, Postman, and XStream automation imports create canonical Endpoints/Variants and Body Assets without expanding format fidelity. Delete the authentication scenario migration scripts.

Static admin and `/static_files/*` delivery use `listStaticFiles`, `putStaticFile`, `openStaticFile`, and `deleteStaticFile` with the active stable Project ID. Preserve raw upload middleware ordering before `express.json`, exact binary/JSON-looking/zero-byte behavior, metadata media type, path containment, and static transaction recovery.

Reduce `routes/admin.ts` to canonical router composition. It mounts raw body and static upload routes before JSON parsing, then Projects/workspace, Endpoints/Variants, App States, diagnostics, traffic, imports, and settings. It exposes no Resource, Scenario, slug activation, scenario-name switch, or legacy payload route.

Before deleting the legacy matcher, move its canonical wildcard primitive into a repository-owned module:

```ts
// packages/server/src/repository/match-expression.ts
export function compileWildcardPattern(pattern: string, caseInsensitive = false): (actual: string) => boolean;
```

Move the existing wildcard escaping, `*` expansion, and case-sensitivity implementation without changing behavior. Move the direct wildcard unit cases from `services/matcher.test.ts` into `repository/match-expression.test.ts`, add a regression proving `compile-project.ts` resolves globs after `services/matcher.ts` is absent, and update `compile-project.ts` to import only from `./match-expression`. Delete the listed legacy services/tests only after all callers use the canonical factories and the compiler has no legacy import. Remove legacy interfaces from `types.ts`, leaving only server configuration and canonical/shared non-domain types that are still imported.

Delete `services/update-semantics.ts` after repository patches own all explicit-null behavior. Replace logger's legacy `generateId` dependency with `randomUUID`; then delete the unused slug/resource-filename utility and its tests. Rewrite `logger.test.ts` and its type assertions around canonical `RequestLogEntry` provenance.

The accepted static-file transaction must keep its crash recovery behavior while dropping terminology reserved for the removed migration/rollback scope. Rename `rollbackStaticTransaction` to `restoreStaticTransaction`, `finishStaticRollback` to `finishStaticRestore`, local `backup` variables to `previous`, and the private transaction child path from `backup` to `previous`. Update every repository test fixture/assertion from `backup`/`rollback` wording to `previous`/`restore`. No backward read path for the old private transaction child is required because this is a fresh application with no persisted production data.

- [ ] **Step 7: Switch the dashboard to canonical Projects, Endpoints, Variants, and App States**

Rename `CanonicalProject`/`CanonicalProjectSummary` to `Project`/`ProjectSummary`, rename `versionedProjectsApi` to `projectsApi`, move `useVersionedProjects` behavior into `useProjects`, and delete the temporary hook. Remove all Resource/Scenario types, clients, hooks, draft helpers, editors, and switches listed in the file section.

The canonical shell must provide these behaviors:

```ts
export type ViewType = 'traffic' | 'logs' | 'intercept' | 'endpoints' | 'states' | 'files';
export interface EndpointListProps { endpoints: EndpointSummary[]; selectedEndpointId?: string; loading?: boolean; onSelect(endpointId: string): void; onCreate(): void }
export interface EndpointEditorProps { projectId: string; endpoint?: EndpointDetail; onSaved(endpoint: EndpointDetail): void; onClose(): void }
export interface AppStateSwitcherProps { project: Project; states: AppStateSummary[]; endpoints: EndpointSummary[]; onActivated(project: Project): void }
export interface AppStateEditorProps { state: AppState; endpoints: EndpointDetail[]; onSaved(state: AppState): void; onDirtyChange?(key: string, dirty: boolean): void }
export interface RepositoryDiagnosticsProps { diagnostics: RepositoryDiagnostic[] }
```

`Endpoints` replaces `Rules` in labels and navigation. Lists show name, method/host/path, variant count, and revision without bytes. Selection fetches one detail. Variant editing uses Task 3 and opens a Body Asset lazily. App State editing uses endpoint/variant IDs, shows bound/total/missing coverage, and requires explicit acknowledgement before activating incomplete coverage. Diagnostics remain visible globally with no selected Project and show code, severity, file/path, recovery, and request ID.

Project create/select/update/delete uses `WorkspaceState` and record revisions. Select a newly created Project by ID. Clear active selection before deleting the active Project. Passthrough settings use `ProjectRuntimeSettings.revision`. Traffic and logs render canonical provenance while retaining cursor and preview behavior. Route Project, Endpoint, Variant, App State, and view navigation through the shared Stay/Discard and `beforeunload` guard.

Keep the existing visual shell; do not add device assignment, bundles, sequences, streaming-fault controls, HLS/DASH UI, or the later redesign.

Adapt `ProjectModal` to `CreateProjectInput`; manual creation sends only name, optional description, and optional base URL, while intercept hosts are edited afterward through revisioned runtime settings. Rewrite `HeadersTable.test.tsx` to exercise canonical Endpoint/Variant header roles, and rewrite `HookLintRepairs.test.tsx` around `useEndpoints`, `EndpointEditor`, Project changes, stale-request aborts, and static-file cleanup. Rewrite Task 2's `versioned-core-hooks.test.tsx` to import final `projectsApi`/`useProjects` names. The complete dashboard suite must contain no test import of a deleted legacy component or client.

- [ ] **Step 8: Verify the atomic source-tree cutover**

Run:

```bash
npm run test --workspace=packages/server -- --run
npm run test --workspace=packages/dashboard -- --run
npx tsc -p packages/server/tsconfig.json --noEmit
npx tsc -p packages/dashboard/tsconfig.app.json --noEmit
npm run build
git grep -n "services/projects\|services/resources\|services/matcher\|services/fixtures\|compatibilityScenarioId\|coreMode\|PendingMigrationCutover\|finalizePendingMigrationCutovers" -- packages/server/src ':!**/*.test.ts' || true
git grep -n "interface Resource\|interface Scenario\|resourcesApi\|scenariosApi\|useResources\|ResourceList\|ScenarioEditor\|activeScenario" -- packages/dashboard/src ':!**/*.test.ts' || true
git grep -n -i "migration\|backup\|rollback\|compatib" -- packages/server/src packages/dashboard/src ':!**/*.test.ts' || true
```

Expected: both complete unit suites PASS; both typechecks and production build exit `0`; Vite emits the Task 3 worker asset now that the canonical editor is imported by the production application; all three greps print no production matches. There is no committed intermediate state in which server and dashboard contracts disagree.

- [ ] **Step 9: Update Graphify and commit the direct cutover**

Run: `graphify update .`

Inspect: `git status --short`, `git diff --stat`, and the full diff for every Task 4 path. Confirm `.superpowers/`, `graphify-out/`, root `package-lock.json`, `dist/`, and unrelated files are not staged.

Commit:

```bash
git add packages/server/src/runtime/create-runtime.ts packages/server/src/runtime/create-runtime.test.ts packages/server/src/repository/match-expression.ts packages/server/src/repository/match-expression.test.ts packages/server/src/repository/compile-project.ts packages/server/src/repository/compile-project.test.ts packages/server/src/repository/project-repository.ts packages/server/src/repository/project-repository.test.ts packages/server/src/routes/admin.ts packages/server/src/routes/admin.test.ts packages/server/src/routes/admin/traffic.ts packages/server/src/routes/admin/imports.ts packages/server/src/routes/admin/repository-integrations.test.ts packages/server/src/routes/automation.ts packages/server/src/routes/mock.ts packages/server/src/routes/static-files.ts packages/server/src/services/intercept.ts packages/server/src/services/logger.ts packages/server/src/services/logger.test.ts packages/server/src/services/logger.test-d.ts packages/server/src/services/proxy.ts packages/server/src/services/proxy-handler.ts packages/server/src/services/proxy-handler.test.ts packages/server/src/services/proxy-server.ts packages/server/src/services/storage.ts packages/server/src/services/storage.test.ts packages/server/src/services/projects.ts packages/server/src/services/projects.test.ts packages/server/src/services/resources.ts packages/server/src/services/resources.test.ts packages/server/src/services/scenario-ids.ts packages/server/src/services/scenario-ids.test.ts packages/server/src/services/matcher.ts packages/server/src/services/matcher.test.ts packages/server/src/services/fixtures.ts packages/server/src/services/fixtures.test.ts packages/server/src/services/update-semantics.ts packages/server/src/services/update-semantics.test.ts packages/server/src/utils/slugify.ts packages/server/src/utils/slugify.test.ts packages/server/src/test-support/proxy-test-client.ts packages/server/src/types.ts packages/server/src/app.ts packages/server/src/app.test.ts packages/server/src/index.ts packages/server/src/scripts/import-xstream-automation.ts packages/server/src/scripts/migrate-auth-scenarios.ts packages/server/src/scripts/migrate-auth-scenarios-logic.ts packages/server/src/scripts/migrate-auth-scenarios-logic.test.ts
git add packages/dashboard/src/api/types.ts packages/dashboard/src/api/client.ts packages/dashboard/src/api/client.test.ts packages/dashboard/src/hooks/useEndpoints.ts packages/dashboard/src/hooks/useStates.ts packages/dashboard/src/hooks/useBodyAsset.ts packages/dashboard/src/hooks/useRepositoryDiagnostics.ts packages/dashboard/src/hooks/useProjects.ts packages/dashboard/src/hooks/useVersionedProjects.ts packages/dashboard/src/hooks/useResources.ts packages/dashboard/src/hooks/useLogs.ts packages/dashboard/src/hooks/useLogs.test.tsx packages/dashboard/src/hooks/versioned-core-hooks.test.tsx packages/dashboard/src/components/EndpointList.tsx packages/dashboard/src/components/EndpointList.test.tsx packages/dashboard/src/components/EndpointEditor.tsx packages/dashboard/src/components/EndpointEditor.test.tsx packages/dashboard/src/components/AppStateSwitcher.tsx packages/dashboard/src/components/AppStateSwitcher.test.tsx packages/dashboard/src/components/AppStateEditor.tsx packages/dashboard/src/components/AppStateEditor.test.tsx packages/dashboard/src/components/RepositoryDiagnostics.tsx packages/dashboard/src/components/RepositoryDiagnostics.test.tsx packages/dashboard/src/components/Layout.tsx packages/dashboard/src/components/ProjectModal.tsx packages/dashboard/src/components/ProjectList.tsx packages/dashboard/src/components/ProjectList.test.tsx packages/dashboard/src/components/HeadersTable.test.tsx packages/dashboard/src/components/HookLintRepairs.test.tsx packages/dashboard/src/components/PassthroughSettings.tsx packages/dashboard/src/components/StaticFilesView.tsx packages/dashboard/src/components/TrafficView.tsx packages/dashboard/src/components/TrafficView.test.tsx packages/dashboard/src/components/LogsView.tsx packages/dashboard/src/components/UpdateForms.test.tsx packages/dashboard/src/components/ResourceList.tsx packages/dashboard/src/components/ResourceEditor.tsx packages/dashboard/src/components/ScenarioSwitcher.tsx packages/dashboard/src/components/BaseScenarioSwitcher.tsx packages/dashboard/src/components/ScenarioEditor.tsx packages/dashboard/src/components/ScenarioEditor.test.tsx packages/dashboard/src/components/JsonEditor.tsx packages/dashboard/src/components/scenario-drafts.ts packages/dashboard/src/App.tsx packages/dashboard/src/App.test.tsx
git commit -m "feat: cut over directly to schema v3"
```

---

### Task 5: Add Fresh-App Server Integration Gates

**Files:**
- Create: `packages/server/src/integration/integration-harness.ts`
- Create: `packages/server/src/integration/versioned-core.integration.test.ts`
- Create: `packages/server/vitest.integration.config.ts`
- Modify: `packages/server/vitest.config.ts`
- Modify: `packages/server/package.json`
- Modify: `package.json`

**Interfaces:**
- Consumes: Task 4 `createRuntime`, canonical public HTTP APIs, proxy test client, repository failure injection, and Release 1 ACL/CORS/request-ID boundaries.
- Produces: isolated `IntegrationHarness`, clean-root first-start/restart/schema-v3-only coverage, and `npm run test:integration --workspace=packages/server`. There is no migration integration file or case.

- [ ] **Step 1: Query the graph**

Run: `graphify query "Which public canonical routes and runtime paths cover fresh first start, restart persistence, direct/proxy matching, state fallback, immutable bodies, static files, traffic-created mocks, ACL, CORS, request IDs, and sanitized failures?" --budget 3500`

Expected: the query maps every matrix row below to Task 4 public routes and runtime factories without migration nodes.

- [ ] **Step 2: Add isolated integration discovery and scripts**

Exclude `src/integration/**` and `src/performance/**` from base `vitest.config.ts`. Create:

```ts
// packages/server/vitest.integration.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./src/vitest.setup.ts'],
    include: ['src/integration/**/*.integration.test.ts'],
    exclude: ['node_modules/**', 'dist/**'],
    fileParallelism: false,
  },
});
```

Add server script `"test:integration": "vitest --config vitest.integration.config.ts --run"` and root script `"test:integration:server": "npm run test:integration --workspace=packages/server"`.

- [ ] **Step 3: Add a failing clean-root integration case first**

Create the harness file and the first test:

```ts
it('starts and restarts a clean schema-v3 root', async () => {
  const harness = await createIntegrationHarness();
  try {
    expect((await harness.request.get('/api/admin/projects')).body).toEqual([]);
    expect((await harness.request.get('/api/admin/workspace')).body)
      .toEqual({ schemaVersion: 3, revision: 0 });
    expect(await harness.readJson('workspace.json')).toEqual({ schemaVersion: 3, revision: 0 });
    expect(await harness.listRootEntries()).toEqual(expect.arrayContaining(['projects', 'trash', 'workspace.json']));
    await harness.restart();
    expect((await harness.request.get('/api/admin/projects')).body).toEqual([]);
    expect((await harness.request.get('/api/admin/workspace')).body)
      .toEqual({ schemaVersion: 3, revision: 0 });
  } finally {
    await harness.dispose();
  }
});
```

Run: `npm run test:integration --workspace=packages/server`

Expected: FAIL because the integration harness has not been implemented.

- [ ] **Step 4: Implement the isolated harness**

Use this exact surface:

```ts
export interface IntegrationHarness {
  request: SuperTest<Test>;
  repository: ProjectRepository;
  rootDirectory: string;
  failNextRename(error?: Error): void;
  restart(): Promise<void>;
  proxy(): Promise<ProxyTestClient>;
  readJson(relativePath: string): Promise<unknown>;
  listRootEntries(): Promise<string[]>;
  dispose(): Promise<void>;
}
export async function createIntegrationHarness(): Promise<IntegrationHarness>;
export async function hashTree(root: string): Promise<Record<string, string>>;
```

Create one `mockmate-integration-*` directory under `os.tmpdir()`, a fail-once `FileSystem` proxy, and `createRuntime({ rootDirectory, fileSystem, isAdminRequestLocal: () => true })`. `restart()` creates a new runtime over the same root and replaces `request`/`repository`; it never touches `process.env.MOCKMATE_DATA_DIR`. `dispose()` refuses any basename not beginning `mockmate-integration-`, closes proxy clients, and recursively removes only that root.

- [ ] **Step 5: Add the complete cross-layer matrix**

Write one explicit `it(...)` per row in `versioned-core.integration.test.ts`:

| Test name | Setup and action | Required assertion |
|---|---|---|
| `starts and restarts a clean schema-v3 root` | Start empty root, GET Projects/workspace, restart | empty Projects, persisted `{schemaVersion:3,revision:0}`, `projects/` and `trash/` exist |
| `persists canonical selection and response across restart` | Create Project/body/Endpoint, select Project, restart, request mock | same active Project ID, revisions, selected generation, and exact response bytes |
| `rejects non-v3 canonical records without publishing them` | Write a selected generation whose Project has `schemaVersion: 2`, restart | Project absent; blocking `UNSUPPORTED_SCHEMA_VERSION`; bytes unchanged; no conversion output |
| `ignores legacy Resource Scenario storage` | Write a Resource/Scenario-shaped tree outside canonical `projects/<id>/current.json`, start and restart | no Project/Endpoint is loaded and tree hash is unchanged |
| `edits a captured response through an immutable asset` | Capture JSON, Mock This, upload edited bytes, update Variant pointer, request Endpoint | edited bytes served; original asset still readable and unchanged |
| `serves binary assets through direct and intercepted paths` | Upload `[0,255,1,254]`, link Variant, request direct and plain HTTP proxy paths | exact bytes, media type, and content length on both |
| `accepts exactly 10 MiB JSON and rejects one extra byte` | stream valid 10 MiB JSON, then 10 MiB+1 | first upload `201` and response hash matches; second `413 BODY_TOO_LARGE` |
| `keeps Endpoint summaries body-independent` | equal-count Endpoints reference 1-byte and 10 MiB assets | no body fields; serialized list lengths equal |
| `preserves disk memory and delivery on failed mutation` | inject rename failure during Endpoint update | generation hash, revision, and served bytes remain old |
| `surfaces corrupt persistence through global diagnostics` | select generation with broken reference and restart | `200` diagnostics with blocking code/file/path/recovery and no body bytes |
| `reports revision conflicts without overwriting` | update revision `3` with expected `2` | `409`, `details.currentRevision === 3`, disk/repository unchanged |
| `reports partial-state fallback provenance` | active App State unbound, base bound | response uses base Variant; traffic source `project_base_state`; reason `active_state_unbound` |
| `preserves canonical static media` | upload `posters/home.bin`, list, request `/static_files/posters/home.bin` | exact `[0,255,1,254]`, relative path, media type |
| `retains ACL CORS request IDs and sanitization` | remote admin request, unapproved Origin, injected `/secret/path body-secret` I/O error | ACL/CORS denied; failures have request ID; response contains neither secret |

For the schema-v3-only tests, compare `hashTree` before/after and assert these paths never appear: `migration-staging`, `migration-backups`, `pending-migrations`, `*.retired`, or `*.quarantine`.

- [ ] **Step 6: Run integration gates GREEN**

Run: `npm run test:integration --workspace=packages/server`

Expected: every named integration case PASS; no migration integration test is discovered; every harness root is removed after success or failure.

- [ ] **Step 7: Update Graphify and commit integration gates**

Run: `graphify update .`

Inspect: `git status --short` and `git diff -- packages/server/src/integration packages/server/vitest.integration.config.ts packages/server/vitest.config.ts packages/server/package.json package.json`

Commit:

```bash
git add packages/server/src/integration/integration-harness.ts packages/server/src/integration/versioned-core.integration.test.ts packages/server/vitest.integration.config.ts packages/server/vitest.config.ts packages/server/package.json package.json
git commit -m "test: add fresh app integration gates"
```

---

### Task 6: Add Server Performance Gates

**Files:**
- Create: `packages/server/src/performance/large-project-fixture.ts`
- Create: `packages/server/src/performance/versioned-core.performance.test.ts`
- Create: `packages/server/vitest.performance.config.ts`
- Modify: `packages/server/package.json`
- Modify: `package.json`

**Interfaces:**
- Consumes: compiled repository snapshots, `writeResolvedResponse`, Body Asset streams, and Task 5's temporary-root discipline.
- Produces: reproducible 500-Endpoint p95, body-independent summary, and 10 MiB bounded-stream gates through `npm run test:performance --workspace=packages/server`.

- [ ] **Step 1: Query the graph**

Run: `graphify query "Which repository listEndpoints, resolve, Body Asset, and response-writer boundaries must the large Project performance fixture measure without migration or dashboard work?" --budget 2200`

Expected: the query points to `ProjectRepository.listEndpoints`, `ProjectRepository.resolve`, `writeResolvedResponse`, and `openBody`.

- [ ] **Step 2: Add the deterministic fixture contract**

Create `large-project-fixture.ts` with:

```ts
export const LARGE_PROJECT_SHAPE = {
  endpoints: 500,
  variantsPerEndpoint: 5,
  distinctBodies: 20,
  bodyBytes: 10 * 1024 * 1024,
} as const;

export function percentile95(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1];
}

export async function measureThirtyWarmRuns(run: () => unknown | Promise<unknown>): Promise<number[]> {
  await run();
  const durations: number[] = [];
  for (let index = 0; index < 30; index += 1) {
    const started = performance.now();
    await run();
    durations.push(performance.now() - started);
  }
  return durations;
}

export interface LargeProjectHarness {
  repository: ProjectRepository;
  smallBodySummaries: EndpointSummary[];
  largeBodySummaries: EndpointSummary[];
  bodyAccess: { openReadStreamCalls: number; wholeBodyReadCalls: number };
  maximumObservedChunkBytes: number;
  consumeTenMiBResponseIntoCountingSink(): Promise<number>;
  dispose(): Promise<void>;
}
export function createLargeProject(shape: typeof LARGE_PROJECT_SHAPE): Promise<LargeProjectHarness>;
```

Generate 500 Endpoints with five Variants each under a worker-specific temporary root. Reuse twenty Body Asset digests cyclically rather than writing 2,500 copies. Bind all Endpoints in one App State and every second Endpoint in one partial state. Create equal-count projections referencing one-byte and 10 MiB assets.

- [ ] **Step 3: Add failing exact performance assertions**

Create:

```ts
it('meets repository and matcher p95 gates', async () => {
  const harness = await createLargeProject(LARGE_PROJECT_SHAPE);
  try {
    const request: MatchRequest = { method: 'GET', path: '/playback/authorize', host: 'api.test', query: {}, headers: {} };
    const summaryMs = await measureThirtyWarmRuns(() => harness.repository.listEndpoints('prj_large'));
    const matcherMs = await measureThirtyWarmRuns(() => harness.repository.resolve('prj_large', request));
    expect(percentile95(summaryMs)).toBeLessThanOrEqual(300);
    expect(percentile95(matcherMs)).toBeLessThanOrEqual(10);
  } finally {
    await harness.dispose();
  }
});

it('keeps summaries independent of body size and streams bounded chunks', async () => {
  const harness = await createLargeProject(LARGE_PROJECT_SHAPE);
  const concat = vi.spyOn(Buffer, 'concat');
  try {
    expect(JSON.stringify(harness.smallBodySummaries).length)
      .toBe(JSON.stringify(harness.largeBodySummaries).length);
    await expect(harness.consumeTenMiBResponseIntoCountingSink()).resolves.toBe(10 * 1024 * 1024);
    expect(harness.bodyAccess.openReadStreamCalls).toBe(1);
    expect(harness.bodyAccess.wholeBodyReadCalls).toBe(0);
    expect(concat).not.toHaveBeenCalled();
    expect(harness.maximumObservedChunkBytes).toBeLessThanOrEqual(64 * 1024);
  } finally {
    concat.mockRestore();
    await harness.dispose();
  }
});
```

Run: `npm run test --workspace=packages/server -- --run src/performance/versioned-core.performance.test.ts`

Expected: FAIL because the fixture and isolated performance configuration do not exist; after the base config exclusion lands, this command may report no discovered file, which is also RED.

- [ ] **Step 4: Add isolated performance discovery and implement probes**

Create standalone `vitest.performance.config.ts` with `globals: true`, Node environment, `setupFiles: ['./src/vitest.setup.ts']`, include `src/performance/**/*.performance.test.ts`, exclude `node_modules/**`/`dist/**`, `fileParallelism: false`, and `testTimeout: 120_000`. Add server script `"test:performance": "vitest --config vitest.performance.config.ts --run"` and root script `"test:performance:server": "npm run test:performance --workspace=packages/server"`.

The harness's body probe implements only `getBody` and `openBody`; `openBody` increments `openReadStreamCalls`, while a test-only whole-body accessor increments `wholeBodyReadCalls` and throws. `consumeTenMiBResponseIntoCountingSink` calls production `writeResolvedResponse` with a `Writable` that retains no chunks, only total bytes and maximum chunk length. Print measured p95 values and maximum chunk bytes before assertions so failures are actionable.

- [ ] **Step 5: Run server performance gates GREEN**

Run: `npm run test:performance --workspace=packages/server`

Expected: PASS with summary p95 `<= 300 ms`, matcher p95 `<= 10 ms`, one streamed body open, zero whole-body reads, no `Buffer.concat`, and maximum chunk `<= 64 KiB`. Temporary fixture data is removed in `finally`.

- [ ] **Step 6: Update Graphify and commit performance gates**

Run: `graphify update .`

Inspect: `git status --short` and `git diff -- packages/server/src/performance packages/server/vitest.performance.config.ts packages/server/package.json package.json`

Commit:

```bash
git add packages/server/src/performance/large-project-fixture.ts packages/server/src/performance/versioned-core.performance.test.ts packages/server/vitest.performance.config.ts packages/server/package.json package.json
git commit -m "test: gate schema v3 server performance"
```

---

### Task 7: Add Dashboard Browser And Long-Task Gates

**Files:**
- Create: `packages/dashboard/playwright.config.ts`
- Create: `packages/dashboard/e2e/global-teardown.ts`
- Create: `packages/dashboard/e2e/fixtures.ts`
- Create: `packages/dashboard/e2e/versioned-core.spec.ts`
- Create: `packages/dashboard/e2e/large-body.performance.spec.ts`
- Modify: `packages/dashboard/vitest.config.ts`
- Modify: `packages/dashboard/package.json`
- Modify: `package.json`

**Interfaces:**
- Consumes: Task 4 canonical UI, Task 5 public APIs, Task 3 worker/editor, and production startup with an isolated root.
- Produces: Chromium coverage for lazy editing, invalid JSON, conflicts, navigation guards, App State switching, diagnostics, and a 10 MiB `<= 50 ms` long-task gate.

- [ ] **Step 1: Query the graph and install the pinned browser dependency**

Run:

```bash
graphify query "Which canonical dashboard roles, labels, public API routes, and startup scripts should Playwright use for body editing, conflicts, App States, diagnostics, navigation guards, and large JSON?" --budget 3000
npm install --workspace=packages/dashboard --save-dev @playwright/test@1.58.2 --save-exact
npx playwright install chromium
```

Expected: dashboard `package.json` declares exact `"@playwright/test": "1.58.2"`; Chromium installs. The ignored root lockfile may change locally but remains unstaged.

- [ ] **Step 2: Configure isolated server and dashboard processes**

Create `playwright.config.ts`:

```ts
import { defineConfig, devices } from '@playwright/test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url));
const e2eDataDir = mkdtempSync(join(tmpdir(), 'mockmate-e2e-'));
process.env.MOCKMATE_E2E_DATA_DIR = e2eDataDir;

const invalidGeneration = join(e2eDataDir, 'projects', 'prj_invalid', 'generations', 'gen_invalid');
mkdirSync(join(invalidGeneration, 'endpoints'), { recursive: true });
mkdirSync(join(invalidGeneration, 'states'), { recursive: true });
writeFileSync(join(e2eDataDir, 'projects', 'prj_invalid', 'current.json'), JSON.stringify({
  schemaVersion: 3,
  generationId: 'gen_invalid',
}));
writeFileSync(join(invalidGeneration, 'project.json'), JSON.stringify({
  schemaVersion: 2,
  id: 'prj_invalid',
  name: 'Unsupported fixture',
  revision: 0,
  createdAt: '2026-08-28T00:00:00.000Z',
  updatedAt: '2026-08-28T00:00:00.000Z',
}));
writeFileSync(join(invalidGeneration, 'settings.json'), JSON.stringify({
  schemaVersion: 3,
  projectId: 'prj_invalid',
  passthroughEnabled: false,
  interceptHosts: [],
  captureRawTraffic: false,
  revision: 0,
}));

export default defineConfig({
  testDir: './e2e',
  globalTeardown: './e2e/global-teardown.ts',
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  use: { baseURL: 'http://127.0.0.1:5173' },
  webServer: [
    {
      command: 'npm run dev:server',
      cwd: workspaceRoot,
      url: 'http://127.0.0.1:3456/health',
      timeout: 120_000,
      reuseExistingServer: false,
      env: { MOCKMATE_DATA_DIR: e2eDataDir },
    },
    {
      command: 'npm run dev:dashboard -- --host 127.0.0.1',
      cwd: workspaceRoot,
      url: 'http://127.0.0.1:5173',
      timeout: 120_000,
      reuseExistingServer: false,
      env: { MOCKMATE_HTTP_PORT: '3456' },
    },
  ],
});
```

Exclude `e2e/**` from dashboard Vitest. `global-teardown.ts` removes `MOCKMATE_E2E_DATA_DIR` only if its resolved parent is `tmpdir()` and basename starts `mockmate-e2e-`; otherwise it throws. Add dashboard scripts `"test:e2e": "playwright test e2e/versioned-core.spec.ts"` and `"test:performance": "playwright test e2e/large-body.performance.spec.ts"`. Root `test:integration` runs server integration then dashboard E2E; root `test:performance` runs server then dashboard performance.

- [ ] **Step 3: Add failing public-API browser workflows**

Use this fixture surface:

```ts
export interface BrowserFixture { projectId: string; endpointId: string; variantId: string; endpointName: string; partialStateName: string }
export async function seedVersionedProject(request: APIRequestContext): Promise<BrowserFixture>;
export function installBodyRequestRecorder(page: Page): string[];
export async function fillValidBodyAndSave(page: Page, text: string): Promise<void>;
export async function forceConflictAndExpectPreservedDraft(page: Page, fixture: BrowserFixture): Promise<void>;
export async function activatePartialStateWithAcknowledgement(page: Page, stateName: string): Promise<void>;
```

Seed only through `POST /api/admin/projects`, `PUT /api/admin/workspace`, raw Body upload, Endpoint create, and App State create. Add:

```ts
test.describe.configure({ mode: 'serial' });

test('shows global repository diagnostics with no active Project', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Repository diagnostics' })).toBeVisible();
  await expect(page.getByText('UNSUPPORTED_SCHEMA_VERSION')).toBeVisible();
  await expect(page.getByText(/reset the configured MockMate data directory/i)).toBeVisible();
  await expect(page.getByText(/migration|rollback|backup/i)).toHaveCount(0);
});

test('keeps body editing lazy, valid, conflict-safe, and navigation-safe', async ({ page }) => {
  const fixture = await seedVersionedProject(page.request);
  const bodyRequests = installBodyRequestRecorder(page);
  await page.goto('/');
  await page.getByRole('tab', { name: 'Endpoints' }).click();
  await page.getByText(fixture.endpointName).click();
  expect(bodyRequests).toHaveLength(0);
  await page.getByRole('button', { name: 'Edit response body' }).click();
  expect(bodyRequests).toHaveLength(1);
  await page.getByRole('textbox', { name: 'Response body' }).fill('{ invalid');
  await expect(page.getByRole('button', { name: 'Save Body' })).toBeDisabled();
  await fillValidBodyAndSave(page, '{"edited":true}');
  await forceConflictAndExpectPreservedDraft(page, fixture);
  await page.getByRole('tab', { name: 'Traffic' }).click();
  await expect(page.getByRole('dialog', { name: 'Unsaved changes' })).toBeVisible();
  await page.getByRole('button', { name: 'Stay' }).click();
  await activatePartialStateWithAcknowledgement(page, fixture.partialStateName);
});
```

The pre-start `playwright.config.ts` writes the complete invalid selected generation before Playwright launches the server. Keep the two tests serial and keep the diagnostics case first, so it observes revision `0` and no active Project before the workflow test creates and selects its valid Project. The server reports `prj_invalid` without loading or rewriting it.

Run: `npm run test:e2e --workspace=packages/dashboard`

Expected: FAIL before fixture/workflow implementation is complete; no existing non-isolated server may be reused.

- [ ] **Step 4: Implement browser fixtures and make workflows GREEN**

`seedVersionedProject` creates a Project, selects it using workspace revision, uploads `{"ok":true}`, creates `Playback authorization` at `/playback` with one Variant, and creates unbound `Expired session`. `fillValidBodyAndSave` waits for `Valid JSON`, clicks `Save Body`, observes `Pending body uploaded`, clicks `Save Variant`, and waits for the pending notice to disappear. `forceConflictAndExpectPreservedDraft` updates the Variant through `page.request`, edits/uploads a local body using the stale UI revision, and asserts local text, pending asset, and server revision remain visible. `activatePartialStateWithAcknowledgement` opens App States, requests activation, observes fallback coverage, and clicks `Activate with fallback`.

Run: `npm run test:e2e --workspace=packages/dashboard`

Expected: PASS in the Chromium project with isolated canonical storage and no legacy/migration setup.

- [ ] **Step 5: Add and run the 10 MiB long-task gate**

Create:

```ts
test('validates and formats 10 MiB JSON without a main-thread task over 50 ms', async ({ page }) => {
  await page.addInitScript(() => {
    const durations: number[] = [];
    Object.defineProperty(window, '__mockmateLongTasks', { value: durations, configurable: true });
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) durations.push(entry.duration);
    }).observe({ type: 'longtask', buffered: true });
  });
  const fixture = await seedVersionedProject(page.request);
  await page.goto('/');
  await page.getByRole('tab', { name: 'Endpoints' }).click();
  await page.getByText(fixture.endpointName).click();
  await page.getByRole('button', { name: 'Edit response body' }).click();
  const body = JSON.stringify({ value: 'x'.repeat(10 * 1024 * 1024 - 12) });
  await page.getByRole('textbox', { name: 'Response body' }).fill(body);
  await expect(page.getByText('Valid JSON')).toBeVisible();
  await page.getByRole('button', { name: 'Format JSON' }).click();
  await expect(page.getByText('Formatting complete')).toBeVisible();
  const longTasks = await page.evaluate(() =>
    (window as typeof window & { __mockmateLongTasks?: number[] }).__mockmateLongTasks ?? []
  );
  console.info(`maximum browser long task: ${Math.max(0, ...longTasks)} ms`);
  expect(Math.max(0, ...longTasks)).toBeLessThanOrEqual(50);
});
```

Run: `npm run test:performance --workspace=packages/dashboard`

Expected: PASS; validation and formatting complete through the worker and the printed maximum long task is `<= 50 ms`.

- [ ] **Step 6: Update Graphify and commit browser gates**

Run: `graphify update .`

Inspect: `git status --short` and `git diff -- packages/dashboard/playwright.config.ts packages/dashboard/e2e packages/dashboard/vitest.config.ts packages/dashboard/package.json package.json`

Commit:

```bash
git add packages/dashboard/playwright.config.ts packages/dashboard/e2e/global-teardown.ts packages/dashboard/e2e/fixtures.ts packages/dashboard/e2e/versioned-core.spec.ts packages/dashboard/e2e/large-body.performance.spec.ts packages/dashboard/vitest.config.ts packages/dashboard/package.json package.json
git commit -m "test: gate schema v3 dashboard flows"
```

---

### Task 8: Run Fresh-App Completion Gates

**Files:**
- Create: `docs/superpowers/reviews/2026-08-28-mockmate-fresh-app-direct-cutover-verification.md`

**Interfaces:**
- Consumes: Tasks 1-7 and the approved fresh-app design acceptance criteria.
- Produces: committed verification evidence for unit, integration, performance, browser, lint, typecheck, build, legacy-removal, migration-removal, body-independence, and deferred-scope gates, with no migration source/rollback hashes.

- [ ] **Step 1: Query the final graph and run all normal tests**

Run:

```bash
graphify query "Does every production server and dashboard path now use schema-v3 Projects, Endpoints, Variants, App States, Body Assets, and diagnostics without legacy or migration components?" --budget 4000
npm test
```

Expected: Graphify finds canonical repository/runtime/dashboard paths and no production migration community; `npm test` PASS for server, dashboard, and tooling unit tests.

- [ ] **Step 2: Run server and browser integration gates**

Run: `npm run test:integration`

Expected: PASS for server integration followed by Chromium E2E, including clean-root first start/restart, schema-v3-only rejection, lazy bodies, conflict preservation, navigation guard, diagnostics, and App State activation. Output contains no migration integration suite.

- [ ] **Step 3: Run server and dashboard performance gates**

Run: `npm run test:performance`

Expected: PASS for 500 Endpoints x five Variants, twenty distinct 10 MiB assets, summary p95 `<= 300 ms`, matcher p95 `<= 10 ms`, streamed chunks `<= 64 KiB`, no whole-body/`Buffer.concat` copy, and Chromium long tasks `<= 50 ms`.

- [ ] **Step 4: Run lint and TypeScript checks**

Run:

```bash
npm run lint
npx tsc -p packages/server/tsconfig.json --noEmit
npx tsc -p packages/dashboard/tsconfig.app.json --noEmit
```

Expected: lint and both typechecks exit `0` with no errors.

- [ ] **Step 5: Run the production build**

Run: `npm run build`

Expected: dashboard Vite build, worker asset emission, dashboard copy into server public output, and server TypeScript build all PASS.

- [ ] **Step 6: Prove legacy production APIs and body coupling are absent**

Run:

```bash
git grep -n "interface Resource\|interface Scenario\|listResources\|getResource\|addScenario\|updateScenario\|resourcesApi\|scenariosApi\|useResources\|ResourceList\|ResourceEditor\|ScenarioEditor\|ScenarioSwitcher\|activeScenario" -- packages/server/src packages/dashboard/src ':!**/*.test.ts' || true
git grep -n "readFileSync\|readdirSync" -- packages/server/src/repository/compile-project.ts packages/server/src/routes/mock.ts || true
git grep -n "body:[[:space:]]*unknown\|body:[[:space:]]*string\|body:[[:space:]]*Buffer" -- packages/server/src/domain packages/dashboard/src/api/types.ts || true
```

Expected: all three greps print no production matches. Canonical matcher/request paths perform no synchronous storage scan and summary/domain records do not inline body content.

- [ ] **Step 7: Prove migration, backup, rollback, pending-cutover, and compatibility production code is absent**

Run:

```bash
test ! -d packages/server/src/migration
test -z "$(git ls-files 'packages/server/src/migration/**')"
git grep -n -i "migration\|backup\|rollback\|pending.*cutover\|compatib\|coreMode" -- packages/server/src packages/dashboard/src ':!**/*.test.ts' || true
git grep -n "services/projects\|services/resources\|services/matcher\|services/fixtures\|scenario-ids" -- packages/server/src ':!**/*.test.ts' || true
```

Expected: both `test` commands exit `0`; both greps print no production matches. Static-file crash recovery uses `previous`/`restore` terminology and does not create an exception to this production-scope proof.

- [ ] **Step 8: Prove deferred features remain out of scope**

Run:

```bash
git grep -n "DeviceAssignment\|PairingToken\|MockMateBundle\|ResponseSequence\|MidstreamFault\|HlsManifest\|DashManifest\|WebSocketScenario\|SseScenario" -- packages/server/src packages/dashboard/src || true
```

Expected: no production implementations or UI behavior. Documentation references outside the searched production roots are not implementations.

- [ ] **Step 9: Record fresh evidence without migration hashes**

Create `docs/superpowers/reviews/2026-08-28-mockmate-fresh-app-direct-cutover-verification.md`. Use the title `# MockMate Fresh-App Direct Cutover Verification`, date `2026-08-28`, and the literal SHA printed by `git rev-parse HEAD`. Add a `Commands` table with one row for each command in Steps 1-5; each row records `PASS` plus the literal fresh file/test counts or build summary. The performance row records the literal summary p95, matcher p95, maximum stream chunk, and maximum browser long task.

Add a `Fresh Storage` section recording PASS for clean-root `{ "schemaVersion": 3, "revision": 0 }`, restart persistence, unpublished unsupported versions, and unchanged unread Resource/Scenario-shaped storage. Add a `Scope Greps` section containing the literal empty output result for each Step 6-8 grep. If any command does not pass, record `FAIL` and stop before this commit; never pre-write PASS without its fresh output.

Do not include migration source hashes, backup hashes, rollback hashes, source-retirement evidence, or migration commands. The only storage hashes permitted are canonical body/delivery assertions from integration/performance output.

- [ ] **Step 10: Update Graphify, inspect staged scope, and commit verification**

Run: `graphify update .`

Expected: the final graph reflects the verification document. Leave `graphify-out/` unstaged.

Inspect:

```bash
git status --short
git diff -- docs/superpowers/reviews/2026-08-28-mockmate-fresh-app-direct-cutover-verification.md
git diff --cached --name-only
```

Expected before staging: only the review document is a Task 8 source change, apart from ignored/generated Graphify or unrelated user files. Expected after staging: `git diff --cached --name-only` prints only the review path.

Commit:

```bash
git add docs/superpowers/reviews/2026-08-28-mockmate-fresh-app-direct-cutover-verification.md
git commit -m "docs: record fresh app cutover verification"
```

The fresh-app reliable core is complete only when every command above has fresh passing evidence, the direct-cutover source greps are empty, and the verification document contains no migration or rollback workflow evidence.
