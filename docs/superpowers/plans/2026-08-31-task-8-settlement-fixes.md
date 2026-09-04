# Task 8 Settlement Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Task 8 callback settlement truthful and retry-safe, strengthen stale reconciliation coverage, and regenerate an exact eight-file review artifact.

**Architecture:** `ImportWizard` will own one project-keyed discriminated orchestration state. The hook remains responsible for import API state; component callbacks remain responsible for canonical read refresh, with retry invoking only `onCommitted(savedResult)`.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, npm workspaces.

## Global Constraints

- Use strict regression-first RED/GREEN for each finding.
- Never retry or duplicate `importApi.commit()` after confirmed success.
- Do not stage or commit any file.
- Keep the Task 8 artifact limited to the eight paths in `.superpowers/sdd/task-8-before/ABSENT_PATHS.txt`.

---

### Task 1: Confirmed-Success Settlement

**Files:**
- Modify: `packages/dashboard/src/components/import/ImportWizard.test.tsx`
- Modify: `packages/dashboard/src/components/import/ImportWizard.tsx`

- [ ] Add deferred resolution and rejection tests proving pending progress, Modal/control locking, success gating, no duplicate commit, honest failure copy, and callback-only retry.
- [ ] Run the focused component tests and capture the expected RED failures.
- [ ] Replace split orchestration state with a project-keyed discriminated union and render dedicated pending, succeeded, and canonical-refresh-failed states.
- [ ] Run the focused tests and capture GREEN.

### Task 2: Unknown Refresh Failure

**Files:**
- Modify: `packages/dashboard/src/components/import/ImportWizard.test.tsx`
- Modify: `packages/dashboard/src/components/import/ImportWizard.tsx`

- [ ] Add exact-copy coverage for rejected `onCommitOutcomeUnknown()` without a canonical-refresh-success claim.
- [ ] Run the test and capture RED.
- [ ] Publish component-owned unknown-outcome state with a distinct `refreshFailed` branch.
- [ ] Run the test and capture GREEN.

### Task 3: Stale Reconciliation Integration

**Files:**
- Modify: `packages/dashboard/src/hooks/useImportWizard.test.tsx`

- [ ] Strengthen the stale lifecycle test with retained source variables and modified legal choices.
- [ ] Run the strengthened assertion and capture RED before completing its fixture/expectations.
- [ ] Complete the integration fixture so it verifies the refresh request, pending stale ownership, reconciliation result, and successful stale clearing.
- [ ] Run the hook test and capture GREEN.

### Task 4: Verification And Artifacts

**Files:**
- Regenerate: `.superpowers/sdd/task-8-after/`
- Regenerate: `.superpowers/sdd/task-8-review.diff`
- Modify: `.superpowers/sdd/task-8-report.md`

- [ ] Run all focused tests, the full dashboard suite, build, typecheck, scoped lint, whitespace, Graphify, and no-staging checks.
- [ ] Remove non-task-owned Modal files from Task 8 before/after snapshots.
- [ ] Regenerate the eight-file after snapshot and recursive review diff from current source.
- [ ] Verify all eight source/snapshot pairs with `diff -q` and SHA-256 equality, verify exactly eight diff sections, and independently regenerate the diff.
- [ ] Append exact RED/GREEN and final verification evidence to the report.
