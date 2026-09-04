# Post-Commit Recovery And Variant Tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Separate committed Variant mutations from failed canonical reloads and complete accessible Variant tabs behavior.

**Architecture:** `EndpointEditor` owns a small post-commit recovery state and one owner-checked canonical publication function. Mutation handlers close committed dialogs before calling the reload phase; recovery retries acquire fresh publication ownership and call only `endpointsApi.get()`. Variant tabs use one guarded selection function for pointer and keyboard activation.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, Tailwind CSS.

## Global Constraints

- Use strict TDD: observe every new regression fail before production edits.
- Full mutation lock covers Endpoint fields, Variant fields/body actions, Variant selection, and structural actions.
- Keep owner-safe Refresh and ordinary navigation/close available during recovery.
- Do not change server contracts, stage files, or create commits.
- Preserve genuine mutation-failure and 409 behavior.

---

### Task 1: Post-Commit Recovery Regressions

**Files:**
- Test: `packages/dashboard/src/components/EndpointEditor.test.tsx`

**Interfaces:**
- Consumes: existing mocked `variantsApi` and `endpointsApi`, editor publication callback fixtures.
- Produces: four failing behavioral tests covering create, fallback, delete, and Variant save after committed mutation plus failed GET.

- [ ] **Step 1: Add all committed-mutation regressions**

For each mutation, resolve the mutation and reject the immediate `endpointsApi.get()` with `new Error('Reload unavailable')`. Assert the explicit recovery message and `Refresh saved changes` action, full mutation lock, and committed dialog/draft state. Resolve Refresh with canonical detail and assert only GET was repeated:

```tsx
expect(screen.getByText('Change saved, refresh failed')).toBeVisible();
expect(screen.getByRole('button', { name: 'Refresh saved changes' })).toBeEnabled();
expect(variantsApi.create).toHaveBeenCalledOnce();
expect(endpointsApi.get).toHaveBeenCalledTimes(2);
```

- [ ] **Step 2: Cover stale publication ownership**

Start recovery Refresh with a deferred GET, change the parent publication owner, resolve the stale GET, and assert canonical detail was not published and recovery was not falsely cleared.

- [ ] **Step 3: Run the direct recovery tests and record RED**

Run:

```bash
npm test --workspace=packages/dashboard -- --run src/components/EndpointEditor.test.tsx
```

Expected: new recovery tests fail because reload rejection is still classified as mutation failure and dialogs/actions remain retryable.

### Task 2: Recovery State And Failure Boundaries

**Files:**
- Modify: `packages/dashboard/src/components/EndpointEditor.tsx`
- Modify: `packages/dashboard/src/components/VariantEditor.tsx`

**Interfaces:**
- Produces: `postCommitRecovery` state, owner-safe GET-only retry, and a parent Variant-save completion that absorbs reload failure after commit.

- [ ] **Step 1: Add one recovery state and canonical publication path**

Represent only information needed by retry:

```ts
const [postCommitRecovery, setPostCommitRecovery] = useState<{
  preferredVariantId?: string;
}>();
```

Use a canonical publication function that applies fields, selected Variant, and `onSaved` only after `completePublication(refreshed)` accepts the result.

- [ ] **Step 2: Split mutation and reload failure boundaries**

After create/delete succeeds, close its dialog before reload. After create/fallback/delete/save commit, call a reload helper whose catch sets post-commit recovery instead of mutation error. Preserve existing mutation catches unchanged.

- [ ] **Step 3: Add GET-only recovery Refresh**

Acquire `onEndpointSaveStarted()` when Refresh is clicked, call only `endpointsApi.get()`, and clear recovery only after accepted publication. Leave recovery active after rejection or GET failure.

- [ ] **Step 4: Apply full mutation lock without blocking close/navigation**

Disable mutation fieldsets and tabs when recovery exists, but move/override ordinary Close so it remains enabled. Render the recovery action outside disabled fieldsets.

- [ ] **Step 5: Keep Variant save committed**

Ensure `VariantEditor` catches only `variantsApi.update()` failures. Clear the submitted draft after update success and invoke parent completion without converting its reload handling into `saveError` or another update attempt.

- [ ] **Step 6: Run recovery tests to GREEN**

Run the Task 1 command and require all tests in `EndpointEditor.test.tsx` to pass.

### Task 3: Complete ARIA Tabs Semantics

**Files:**
- Test: `packages/dashboard/src/components/EndpointEditor.test.tsx`
- Modify: `packages/dashboard/src/components/EndpointEditor.tsx`

**Interfaces:**
- Produces: stable tab/panel relationships and guarded automatic keyboard activation.

- [ ] **Step 1: Add failing relationship and keyboard tests**

Assert selected-only roving focus and bidirectional relationship:

```tsx
expect(selectedTab).toHaveAttribute('tabindex', '0');
expect(otherTab).toHaveAttribute('tabindex', '-1');
expect(selectedTab).toHaveAttribute('aria-controls', panel.id);
expect(panel).toHaveAttribute('aria-labelledby', selectedTab.id);
```

Exercise ArrowLeft, ArrowRight, Home, and End including wrapping, focus, selection, dirty-guard deferral, and locked no-op behavior.

- [ ] **Step 2: Run tests and record RED**

Run the direct Endpoint editor suite and require the new assertions to fail against the incomplete tab implementation.

- [ ] **Step 3: Implement one guarded selection function**

Derive stable IDs from Endpoint and Variant IDs. Give selected tab `tabIndex={0}`, others `-1`; render one selected `tabpanel`. Route click and keyboard target selection through the same dirty guard, with focus inside the authorized action.

- [ ] **Step 4: Run the combined direct gate**

```bash
npm test --workspace=packages/dashboard -- --run \
  src/components/EndpointEditor.test.tsx \
  src/components/VariantEditor.test.tsx \
  src/components/NewVariantDialog.test.tsx \
  src/components/VariantDeleteDialog.test.tsx
```

Expected: all directly covering tests pass.

### Task 4: Verification And Report

**Files:**
- Modify: `.superpowers/sdd/final-fix-report.md`

**Interfaces:**
- Produces: fresh verification evidence and `## Re-review Fix 6`.

- [ ] **Step 1: Run the complete focused suite**

Run the established nine-file final-fix focused command and require zero failures.

- [ ] **Step 2: Run full and static gates**

```bash
npm run test --workspace=packages/dashboard -- --run
npx tsc --noEmit -p packages/dashboard/tsconfig.app.json
npm run lint --workspace=packages/dashboard
npm run build --workspace=packages/dashboard
git diff --check
```

- [ ] **Step 3: Append Fix 6 evidence and self-review**

Record exact RED/GREEN counts, recovery invariants, ARIA relationships, warnings, and blockers under `## Re-review Fix 6`.

- [ ] **Step 4: Update Graphify and confirm staging state**

Run `graphify update .`, `git diff --check`, and `git diff --cached --name-only`; require no staged paths.
