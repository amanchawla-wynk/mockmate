# MockMate Large-Body Experience Design

**Date:** 2026-08-28
**Status:** Approved direction, pending written-spec review
**Amends:** `2026-08-28-mockmate-fresh-app-cutover-design.md`
**Supersedes:** The native-textarea 10 MiB browser performance assumption in Fresh-App Task 7

## Context

MockMate handles large bodies in two related workflows:

- mock response bodies are opened, edited, validated, formatted, uploaded, and attached to Variants;
- traffic request and response bodies arrive continuously and users move rapidly among captured entries in the Proxyman-style inspector.

The existing Worker keeps JSON parsing and formatting off the browser main thread, but the body is still rendered through a controlled native `textarea`. Chromium testing showed that publishing a 10 MiB string into the visible text control creates a roughly 600-800 ms main-thread Long Task. The same result occurs with direct DOM assignment, React-controlled state, development builds, and production builds. Worker computation and message delivery complete in roughly 11-15 ms and are not the bottleneck.

Traffic has a separate limitation: the server retains only a 16 KiB preview. A virtualized browser component alone cannot display a complete large traffic body because those bytes no longer exist after capture.

The solution must address capture, retention, loading, viewing, editing, switching, and promotion as one system. It must preserve the current dashboard layout and must not slow proxied or direct application traffic.

## User Experience Decision

Mock bodies remain fully editable, including typing, selection, scrolling, search, copy, undo, validation, formatting, and save across the complete document.

The dashboard retains its current Proxyman-style layout:

- traffic list on the left;
- one selected request/response inspector;
- existing request and response tabs;
- existing mock Body Editor panel, controls, notices, colors, and spacing.

There are no visible editor tabs and no split workspace. Multiple body documents exist internally. Switching back to a previously viewed traffic or mock body restores its content, scroll, selection, validation, and draft state without another blank loading cycle.

Large binary traffic bodies use a bounded base64/hex preview plus exact streamed Download. They do not enter the text editor.

## Performance Contract

For a 10 MiB text or JSON body on the local Chromium gate:

- opening and making the virtualized editor interactive may take up to 400 ms;
- after the editor reports ready, each measured scroll, type, undo, full-document search, Worker validation, and format-publication phase must have no browser Long Task over 50 ms.

Opening is measured separately from steady-state interaction. The observer is reset only after the editor is ready; tasks are not otherwise filtered.

For traffic bodies up to 50 MiB, total first-load time is not hard-gated. The existing preview, traffic list, navigation, and unrelated dashboard controls must remain responsive while the full body loads. Reopening a body retained in the dashboard document cache must not issue another network request or show a full-panel loader.

## Architecture

### Traffic Body Cache

Add a Project-scoped ephemeral `TrafficBodyCache` under the configured MockMate data root.

- Maximum complete captured request or response body: 50 MiB inclusive.
- Maximum retained traffic-body bytes per Project: 1 GiB.
- Storage is content-addressed and deduplicated by SHA-256.
- Files are published only after complete streaming, size validation, digest calculation, sync, and atomic promotion.
- Cache state is ephemeral. Startup removes prior traffic-cache state through containment-checked cleanup; traffic logs remain non-persistent.

Each log stores request and response body descriptors rather than bytes or filesystem paths. A descriptor contains:

- side: request or response;
- media type and optional content encoding;
- observed source size;
- retained size and SHA-256 when complete;
- state: `available`, `truncated`, `evicted`, or `unavailable`;
- sanitized reason when full capture was unavailable.

The existing 16 KiB UTF-8/base64 preview remains part of log detail and is always the immediate display surface.

### Non-Blocking Capture

Full-body capture must not add unbounded memory or disk backpressure to application traffic.

- Request and response bytes continue toward their destination independently.
- A sidecar capture sink uses at most a 1 MiB in-memory queue.
- If disk cannot keep up, the queue saturates, the body exceeds 50 MiB, or a write fails, full capture is abandoned and its temporary file is removed.
- Preview and size accounting continue even when full capture is abandoned.
- Capture failure does not fail, pause, or materially delay the proxied/direct request.

The 50 MiB limit is exact. A source that produces one byte beyond it is `truncated`; the captured prefix is never represented as a complete body and cannot be promoted to a mock.

### References, Leases, And Eviction

Traffic log retention and cache references move together.

- Content-addressed files maintain Project-scoped reference counts.
- An active stream or mock-promotion operation holds a lease.
- Oldest unleased log-body references are evicted first when the 1 GiB budget is exceeded.
- Eviction changes descriptors to `evicted` but leaves previews and traffic metadata usable.
- If all candidates are leased, the new body remains preview-only rather than blocking traffic.
- Clearing a Project's traffic releases its cache references.

No manual pinning UI is introduced. Permanent retention occurs only through successful promotion into the immutable Body Store.

### Traffic APIs And Mock Promotion

Log detail returns previews and body descriptors. Separate Project- and log-scoped routes stream an available request or response body with authoritative `Content-Type`, optional `Content-Encoding`, exact `Content-Length`, cancellation ownership, and request IDs. Filesystem paths are never exposed.

Binary Download uses the same raw stream with download disposition. Text viewing consumes the stream lazily through the dashboard document cache.

`Mock This` promotes an available exact response body as follows:

1. acquire a traffic-cache lease;
2. stream the cached bytes into the immutable Body Store;
3. atomically create or return the traffic-ID-owned Endpoint and Variant;
4. release the lease.

Promotion is idempotent by traffic ID. A failed Body Store or repository operation leaves the traffic cache and repository's published state unchanged. Truncated, evicted, or unavailable bodies return structured recovery guidance rather than creating a partial mock. A promoted Body Asset remains valid after traffic eviction or clear.

### Shared Dashboard Document Cache

Add a shared `BodyDocumentCache` used by mock editing and traffic text viewing.

Document identities are immutable:

- mock: Project, Endpoint, Variant, revision, and Body Asset identity;
- traffic: Project, log ID, request/response side, and captured digest.

The cache:

- deduplicates concurrent loads for the same identity;
- prioritizes the active selection;
- permits at most two concurrent full-body loads;
- cancels the oldest inactive load when a third distinct selection begins;
- retains at most 12 clean documents or 256 MiB of clean document data, whichever limit is reached first;
- evicts clean least-recently-used documents;
- never evicts the active document or dirty mock drafts;
- preserves selection, scroll position, undo state, validation generation, and pending Body Asset ownership;
- rejects stale success, error, and finalization by identity and generation.

An uncached traffic selection displays its 16 KiB preview immediately and reports background full-body loading within the body pane. The traffic list and other inspector tabs remain interactive. A cached revisit restores immediately without another body request.

### Virtualized Document Editor

Replace the native body `textarea` with a project-owned React adapter around CodeMirror 6's `EditorView` and immutable `Text` document.

- CodeMirror renders only the visible viewport plus its margin.
- The same adapter supports editable mock documents and read-only traffic documents.
- Search operates across the complete document, including content outside the rendered viewport.
- The adapter preserves accessible labeling, keyboard behavior, selection, clipboard, focus, and existing panel styling.
- Large-body mode begins above 1 MiB. It omits expensive syntax parsing and line wrapping while retaining full editing and search. The UI identifies large-body mode and explains that wrapping is disabled for responsiveness.
- Small bodies use the same component and may retain normal wrapping.

React owns editor metadata and status, not a controlled copy of the complete body string. The keyed draft stores CodeMirror's immutable document state. Full string materialization occurs only at explicit boundaries:

- debounced Worker validation;
- Worker formatting;
- Body Asset upload;
- explicit test/export operations.

Typing marks the keyed draft dirty immediately without flattening the complete document on every keystroke. Worker results remain generation-owned. Formatting replaces the document atomically when the CodeMirror update stays within the Long Task budget; if profiling shows a single publication exceeds 50 ms, the result is cooperatively prepared/applied in bounded tasks while the editor displays `Formatting` and suppresses intermediate validation callbacks.

## Error Handling

- Capture-cache failure never changes the proxied/direct response outcome.
- `truncated`, `evicted`, and `unavailable` are distinct user-visible states.
- Body stream routes enforce Project/log ownership and reject cross-Project access.
- Missing, evicted, or non-promotable bodies use structured request-ID-bearing `404`, `409`, or `410` contracts as appropriate.
- Stream cancellation closes handles and releases leases exactly once while preserving the primary error.
- Cache startup and cleanup reject symlinked, special, malformed, or escaped paths and never follow them.
- Dashboard body-load failure preserves the preview and offers Retry or Download without replacing another selection.
- Binary bodies never pass through text decoding or the CodeMirror editor.
- Dirty mock documents remain protected by existing navigation and `beforeunload` guards.
- Revision conflicts preserve document state, undo state, pending uploads, and current server revision.

## Testing Strategy

### Server Unit Tests

Cover:

- exact bytes and zero bytes;
- 50 MiB inclusive and one-byte-over truncation;
- digest deduplication and reference counting;
- 1 GiB Project budget through reduced injectable test limits;
- lease-safe oldest-first eviction;
- clear and startup cleanup;
- symlink/special-file/path containment;
- queue saturation and disk-write failure without proxy backpressure;
- temporary-file cleanup and primary-error preservation;
- raw stream headers, cancellation, and request IDs.

### Server Integration Tests

Cover:

- streamed request and response capture;
- preview availability during/full-capture failure;
- scoped request/response downloads and cross-Project rejection;
- exact binary and text bytes;
- cancellation and lease release;
- exact mock promotion and traffic-ID idempotence;
- promoted mock survival after traffic clear;
- structured truncation, eviction, and unavailable errors;
- no migration or legacy persistence.

### Dashboard Unit And Component Tests

Cover:

- 12-document and 256 MiB clean LRU limits;
- dirty/current pinning;
- two-load concurrency and oldest inactive cancellation;
- request deduplication;
- stale completion/error/finalizer ownership;
- immediate preview and retry behavior;
- selection/scroll/undo restoration;
- editable and read-only CodeMirror modes;
- large-mode wrapping/parser policy;
- keyed draft, validation, formatting, upload, conflict, and navigation semantics;
- binary preview and Download without editor construction.

### Chromium Gates

Retain the canonical diagnostics, lazy body, invalid JSON, upload/attachment, real revision conflict, navigation guard, and App State fallback workflows.

Add:

- a 10 MiB mock body that becomes interactive within 400 ms;
- post-ready phase-isolated scroll, typing, undo, full-document search, Worker validation, and format publication with no Long Task over 50 ms;
- proof that the production JSON Worker handled validation and formatting;
- rapid switching among several large traffic entries while previews remain immediate and unrelated UI remains responsive;
- no more than two concurrent full-body requests;
- a cached revisit with no new request or full-panel loader and restored position;
- binary preview plus exact streamed Download without a text editor.

For 50 MiB traffic, measure responsiveness and progress rather than total load duration.

## Delivery Sequence Amendment

The unfinished Fresh-App Task 7 is split into reviewed implementation units:

1. traffic-body cache, descriptors, streaming routes, and exact mock promotion;
2. shared dashboard document cache and CodeMirror adapter;
3. mock Body Editor migration to immutable virtualized documents;
4. Proxyman-style traffic inspector integration with text viewing and binary Download;
5. revised Chromium workflow, rapid-switch, and 400 ms/50 ms performance gates;
6. existing Fresh-App completion certification.

The current uncommitted Playwright configuration and canonical workflow work may be retained and adapted, but the failed native-textarea Long Task assertion is historical evidence, not the final gate.

## Non-Goals

- Visible editor tabs or split-pane body workspaces.
- Full inline binary editing.
- Permanent retention of all traffic bodies.
- A manual traffic-cache pinning interface.
- Syntax parsing or highlighting that compromises large-body responsiveness.
- Migration, backup, rollback, compatibility adapters, or legacy persistence.
- Remote/distributed traffic-body storage.

## Acceptance Criteria

- Full traffic text bodies up to 50 MiB are available lazily while the 16 KiB preview remains immediate.
- Traffic-body storage is bounded to 1 GiB per Project and cannot block application traffic.
- Truncated or evicted traffic never becomes a partial mock.
- Promoted mocks use exact immutable Body Asset bytes and survive traffic eviction.
- The current Proxyman-style dashboard layout remains intact.
- Rapid switching restores cached body state without repeated loaders or requests.
- Mock bodies remain fully editable through an accessible virtualized editor.
- A 10 MiB editor opens within 400 ms and all measured steady-state phases avoid Long Tasks over 50 ms.
- Large binary traffic uses preview plus exact Download.
- Unit, integration, Chromium, lint, typecheck, production build, cleanup, and fresh-app absence gates all pass.
