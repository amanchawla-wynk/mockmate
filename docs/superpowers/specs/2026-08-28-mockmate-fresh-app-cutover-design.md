# MockMate Fresh-App Direct Cutover Design

**Date:** 2026-08-28
**Status:** Approved direction, pending written-spec review
**Supersedes:** Migration, backup, rollback, and dual-model cutover requirements in the 2026-08-27 reliable-core design and Release 2 plan

## Context

MockMate has not been used to create a production system or persisted user data. There are no external installations whose legacy `Resource`/`Scenario` files must remain readable. The reliable-core branch can therefore treat the next release as a fresh application rather than a backward-compatible upgrade.

Building legacy discovery, conversion, backup, rollback, pending-cutover reconciliation, and temporary compatibility adapters would protect data that does not exist. Those paths would add substantial filesystem and maintenance risk without user value.

## Decision

MockMate will ship as a schema-v3-only application:

- Remove Release 2 Task 7 migration discovery/conversion code, fixtures, and tests.
- Skip Release 2 Task 8 migration staging, backup, rollback, and CLI work.
- Remove migration-only domain types and schemas, including `PendingMigrationCutover`.
- Remove migration and rollback requirements from integration, completion, and documentation gates.
- Do not preserve or load legacy `Resource`/`Scenario` persistence.
- Start a fresh installation with an empty schema-v3 workspace and versioned Project repository.
- Replace the legacy runtime and dashboard directly rather than maintaining two active persistence models.

The existing TypeScript server and dashboard remain. This is a persistence and domain-model replacement, not an application rewrite.

## Revised Delivery Sequence

### 1. Remove migration scope

Reverse the six Task 7 implementation commits in one reviewed removal commit while preserving Git history. Remove any migration-only types introduced earlier. Update the durable design and implementation plan so later work cannot accidentally depend on migration records or paths.

No Task 8 implementation is created.

### 2. Build canonical dashboard foundations

Before changing the production runtime, add typed dashboard clients and abort-safe hooks for canonical Projects, Endpoints, Variants, App States, Body Assets, and repository diagnostics. Summary requests remain body-free; details and bodies load lazily.

These modules are additive and testable against the canonical APIs already available in explicit versioned mode.

### 3. Build safe body editing

Add worker-based JSON validation and formatting, revision-aware body drafts, immutable Body Asset upload, and Variant pointer updates. Draft identity includes Project, Endpoint, Variant, revision, and Body Asset identity so edits cannot cross boundaries.

Conflicts preserve local text and pending uploaded assets. Large JSON work stays off the browser main thread.

### 4. Perform one direct server/dashboard switch

Combine the original server-integration and dashboard-adaptation cutovers into one build-safe task:

- Production startup creates and initializes `ProjectRepository` and uses versioned app mode.
- Mock matching, response writing, proxying, automation, imports, static files, traffic capture, and Create Mock use canonical repository APIs only.
- The dashboard switches from Resources/Scenarios to Endpoints/Variants/App States using the prepared canonical clients, hooks, and editors.
- Legacy server services, routes, types, tests, and dashboard components are deleted in the same task.
- No migration finalizer, pending record, legacy adapter, backup, rollback, source retirement, or workspace reconciliation exists.

The switch is atomic at the source-tree level: every committed production caller uses the canonical model, and the dashboard and server agree on the same API surface.

## Fresh Storage Behavior

On first startup, MockMate initializes the schema-v3 storage root and an empty workspace:

```text
workspace.json
projects/
trash/
```

Projects created afterward use selected immutable generations, external Body Assets, static metadata, and atomic repository publication already implemented in Tasks 1-6.

Legacy project directories are outside the supported format and are not discovered, converted, selected, renamed, backed up, or removed. There is no compatibility promise for pre-release local data. A developer with stale local data resets the configured MockMate data directory.

## Runtime Data Flow

1. Startup initializes schema-v3 storage, Body Store, and `ProjectRepository`.
2. The repository validates persisted canonical Projects and exposes diagnostics without publishing invalid snapshots.
3. The canonical workspace identifies the active Project.
4. Incoming direct or proxied requests resolve only through the active compiled Project snapshot.
5. The response writer streams Body Asset bytes with canonical status, headers, delay, and App State provenance.
6. Admin and dashboard mutations write only through `ProjectRepository`, preserving compile-before-write and disk-before-memory ordering.
7. Traffic-created mocks create immutable Body Assets and canonical Endpoint/Variant records.

No step reads legacy Resource or Scenario persistence.

## Error Handling

- Missing active Project returns the canonical structured `NO_ACTIVE_PROJECT` contract.
- Invalid canonical storage remains visible through repository diagnostics and is not partially published.
- Revision conflicts preserve dashboard drafts and report the current server revision.
- Stream failures retain the Task 6 ownership and primary-error rules.
- Filesystem, validation, and unexpected errors remain sanitized and request-ID-bearing.
- There are no migration-specific error codes because there is no migration subsystem.

## Testing Strategy

### Unit and component tests

- Canonical clients, hooks, worker protocol, drafts, editors, App State controls, diagnostics, and repository-only server adapters.
- No migration fixtures, conversion tests, rollback tests, or pending-record schema tests.

### Direct-cutover tests

- Production startup selects versioned mode and initializes an empty schema-v3 workspace.
- Every production persistence/runtime call flows through `ProjectRepository`.
- No production import references legacy Project/Resource/Scenario services.
- Dashboard and server canonical contracts switch together without an incompatible intermediate commit.

### Integration and performance gates

- Public canonical CRUD, restart persistence, matching, App State fallback, immutable bodies, static files, proxy behavior, traffic-created mocks, ACL, CORS, request IDs, and sanitized failures.
- Deterministic large-Project matching and summary latency.
- Ten MiB streaming memory and browser long-task thresholds.
- Chromium coverage for editing, conflicts, App State switching, diagnostics, navigation guards, and large bodies.

### Completion gates

- Unit, integration, performance, browser, lint, typecheck, and production build all pass.
- Scope grep proves legacy production APIs and body coupling are gone.
- Scope grep proves migration, backup, rollback, pending-cutover, and compatibility-adapter production code is absent.
- Verification evidence contains no migration source or rollback hashes.

## Explicit Non-Goals

- Reading or converting legacy `Resource`/`Scenario` files.
- Migration preview, backup, rollback, or recovery tooling.
- Running legacy and canonical persistence models concurrently.
- Temporary repository-backed legacy admin adapters.
- Preserving pre-release local developer data.
- Any deferred device, bundle, sequence, streaming-fault, HLS, or DASH feature.

## Acceptance Criteria

- Task 7 production/test files are removed and Task 8 is deleted from scope.
- Migration-only model/schema symbols are absent.
- A clean data root starts successfully with an empty schema-v3 workspace.
- All server runtime and storage callers use canonical repository APIs.
- The dashboard uses canonical Projects, Endpoints, Variants, App States, Body Assets, and diagnostics.
- Legacy production services, APIs, types, and UI are absent.
- No migration or compatibility subsystem remains.
- All revised integration, performance, browser, quality, and completion gates pass.
