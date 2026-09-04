# Final Review Details Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Parse HTTP Connection token lists canonically and make Endpoint dirty cleanup conditional on operation-scoped publication acceptance.

**Architecture:** Add one dependency-free connection-token module shared by proxy request, resolved-response, and forwarded-response decisions. Return a synchronous boolean from Endpoint publication and propagate it through the save-start completion closure before editor mutation.

**Tech Stack:** TypeScript, Node.js TLS/Fetch/streams, React 19, Vitest, Testing Library.

## Global Constraints

- Work only in `/Users/amanchawla/Documents/Projects/mockmate/.worktrees/mockmate-reliable-core` from starting HEAD `02a36d3`.
- Use strict RED/GREEN and record the exact focused failures before production changes.
- Preserve HTTP/1.0 defaults, ordinary HTTP/1.1 keep-alive, serialized draining, close-once behavior, backpressure, bounded previews, cancellation, and listener cleanup.
- Preserve normal owned Endpoint cleanup/normalization, authoritative remount, changed/cleared selection rejection, and dirty Variant sibling ownership.
- Preserve all schema-v3 cutover, security, and no-legacy constraints.
- Create exactly one non-amended final commit. Do not stage `.superpowers/`, `graphify-out/`, lockfiles, `dist/`, generated output, scratch, or unrelated files. Do not merge, push, or create a PR.

---

### Task 1: Canonical Connection Tokens

**Files:**
- Create: `packages/server/src/services/http-connection.ts`
- Modify: `packages/server/src/services/proxy-handler.ts`
- Modify: `packages/server/src/services/proxy-server.ts`
- Modify: `packages/server/src/services/proxy-server.test.ts`

**Interfaces:**
- Consumes: case-insensitive header records from parsed requests, resolved mocks, and Fetch responses.
- Produces: `hasConnectionToken(headers, token): boolean` and forwarded `closeConnection?: boolean` metadata.

- [ ] **Step 1: Add raw failing tests**

Add tests that pipeline two requests and assert `Connection: x-hop, Close` closes after one body/upstream operation, mixed OWS/casing is accepted, and `disclose` remains keep-alive for a second request.

- [ ] **Step 2: Verify RED**

Run: `npm run test --workspace=packages/server -- --run src/services/proxy-server.test.ts`

Expected: mixed-token request/configured response cases process a second request or fail to close; forwarded close metadata is lost; substring control remains open.

- [ ] **Step 3: Implement the shared parser**

```ts
export function hasConnectionToken(headers: Record<string, string>, token: string): boolean {
  const expected = token.toLowerCase();
  return Object.entries(headers)
    .filter(([name]) => name.toLowerCase() === 'connection')
    .some(([, value]) => value.split(',').some(candidate => candidate.trim().toLowerCase() === expected));
}
```

Use the helper for HTTP/1.0 request keep-alive, HTTP/1.1 request close, final resolved mock close, and forwarded upstream close captured before hop-by-hop stripping.

- [ ] **Step 4: Verify GREEN**

Run: `npm run test --workspace=packages/server -- --run src/services/proxy-server.test.ts src/services/proxy-handler.test.ts src/services/response-writer.test.ts`

Expected: all focused tests pass with one close and no second body/upstream operation.

### Task 2: Publication-Owned Dirty Cleanup

**Files:**
- Modify: `packages/dashboard/src/hooks/useEndpoints.ts`
- Modify: `packages/dashboard/src/hooks/versioned-core-hooks.test.tsx`
- Modify: `packages/dashboard/src/components/EndpointEditor.tsx`
- Modify: `packages/dashboard/src/components/EndpointEditor.test.tsx`
- Modify: `packages/dashboard/src/components/UpdateForms.test.tsx`
- Modify: `packages/dashboard/src/App.tsx`
- Modify: `packages/dashboard/src/App.test.tsx`

**Interfaces:**
- Consumes: `EndpointPublicationToken` captured before an Endpoint API request.
- Produces: `publishEndpoint(publication, endpoint): boolean` and `onEndpointSaveStarted(): (endpoint) => boolean`.

- [ ] **Step 1: Add failing acceptance and re-entry tests**

Assert accepted hook publication returns `true`, changed/cleared publication returns `false`, and a deferred old save cannot clear beforeunload/navigation ownership after reopening the same Endpoint/revision and editing a new draft.

- [ ] **Step 2: Verify RED**

Run: `npm run test --workspace=packages/dashboard -- --run src/hooks/versioned-core-hooks.test.tsx src/components/EndpointEditor.test.tsx src/App.test.tsx src/hooks/useUnsavedChangesGuard.test.tsx`

Expected: publication returns `undefined`, and stale completion clears the identical current dirty key.

- [ ] **Step 3: Implement boolean acceptance**

Return `false` from every stale publication branch and `true` after accepted state publication. Invoke the completion callback before local success mutation and return immediately on rejection; only accepted completion clears the old key and applies authoritative normalized fields.

- [ ] **Step 4: Verify GREEN**

Run: `npm run test --workspace=packages/dashboard -- --run src/hooks/versioned-core-hooks.test.tsx src/components/EndpointEditor.test.tsx src/components/UpdateForms.test.tsx src/App.test.tsx src/hooks/useUnsavedChangesGuard.test.tsx src/components/VariantEditor.test.tsx`

Expected: all focused tests pass without React warnings.

### Task 3: Full Gates And Commit

**Files:**
- Modify but do not stage: `.superpowers/sdd/fresh-app-task-4-report.md`

**Interfaces:**
- Consumes: completed Tasks 1-2.
- Produces: fresh evidence, updated Graphify index, and one reviewable commit.

- [ ] **Step 1: Run complete verification**

Run both full package suites, both TypeScript checks, `npm run build`, exact production absence greps, `git diff --check`, and `graphify update .`.

- [ ] **Step 2: Record evidence and commit**

Append exact RED/GREEN/full-gate results and current status to `.superpowers/sdd/fresh-app-task-4-report.md`. Inspect status, diff, and recent log; stage only intended source/tests/design/plan; commit once without amending.
