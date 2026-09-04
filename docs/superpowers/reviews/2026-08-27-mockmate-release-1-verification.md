# MockMate Release 1 Verification

## Current Certificate

Release 1 verification passed against production commit `21dae7367c877fc52080735dfd75201c504e53d5` at `2026-08-27T20:38:47Z` UTC. Every gate below was run fresh from that exact HEAD before this documentation-only certificate update.

This certificate supersedes earlier Release 1 evidence because production code changed after the prior certificate. The PASS in this document certifies `21dae7367c877fc52080735dfd75201c504e53d5`, not an earlier production commit.

## Gate Summary

| Gate | Result | Fresh evidence |
|---|---|---|
| Complete server suite | PASS | 18/18 files and 397/397 tests |
| Complete dashboard suite | PASS | 10/10 files and 66/66 tests |
| Root tests | PASS | Command exited; 28 files and 463 tests across both real workspaces |
| Root lint | PASS | Dashboard and server ESLint completed with zero diagnostics |
| Root build | PASS | Direct dashboard Vite build, server prebuild dashboard Vite build, and server `tsc` completed |
| Release 2 scope boundary | PASS | Exact grep produced no output |
| Certificate path safety | PASS | Run-unique root observed; focused suite 46/46 |
| Diff check | PASS | `git diff --check` produced no output |

## Complete Server Suite

Exact command:

```bash
npm run test --workspace=packages/server -- --run
```

Exact command-level result:

```text
> @mockmate/server@0.1.0 test
> vitest run --run

Test Files  18 passed (18)
     Tests  397 passed (397)
  Duration  16.14s
```

The run included these path-safety cases:

```text
src/services/certs/generator.test.ts  (46 tests) 15135ms
src/test-support/test-storage.test.ts  (2 tests) 2ms
```

Result: PASS, exit 0.

## Complete Dashboard Suite

Exact command:

```bash
npm run test --workspace=packages/dashboard -- --run
```

Exact command-level result:

```text
> dashboard@0.0.0 test
> vitest run --run

Test Files  10 passed (10)
     Tests  66 passed (66)
  Duration  2.98s
```

Result: PASS, exit 0.

## Root Tests

Exact command:

```bash
npm test
```

Exact command-level result:

```text
> mockmate@0.1.0 test
> npm run test --workspaces

> dashboard@0.0.0 test
> vitest run

Test Files  10 passed (10)
     Tests  66 passed (66)
  Duration  2.88s

> @mockmate/server@0.1.0 test
> vitest run

Test Files  18 passed (18)
     Tests  397 passed (397)
  Duration  15.90s
```

Result: PASS, exit 0. The root command exited normally after 28 test files and 463 tests passed.

Repository scope remains two real workspaces: `packages/dashboard` and `packages/server`. This branch has no `tools/` directory and no `*.test.mjs` files, so no tool-test coverage is claimed.

## Root Lint

Exact command:

```bash
npm run lint
```

Exact output:

```text
> mockmate@0.1.0 lint
> npm run lint --workspaces

> dashboard@0.0.0 lint
> eslint .

> @mockmate/server@0.1.0 lint
> eslint src --ext .ts
```

Result: PASS, exit 0, with zero errors and zero warnings.

## Root Build

Exact command:

```bash
npm run build
```

Exact output:

```text
> mockmate@0.1.0 build
> npm run build:dashboard && npm run build:server

> mockmate@0.1.0 build:dashboard
> npm run build --workspace=packages/dashboard

> dashboard@0.0.0 build
> vite build

vite v7.3.6 building client environment for production...
transforming...
✓ 53 modules transformed.
rendering chunks...
computing gzip size...
dist/index.html                   0.46 kB │ gzip:  0.29 kB
dist/assets/index-B1jnPcc-.css   32.71 kB │ gzip:  6.79 kB
dist/assets/index-BLe-9Ky6.js   309.98 kB │ gzip: 86.43 kB
✓ built in 696ms

> mockmate@0.1.0 build:server
> npm run build --workspace=packages/server

> @mockmate/server@0.1.0 prebuild
> cd ../dashboard && npm run build && mkdir -p ../server/dist/public && cp -r dist/* ../server/dist/public/

> dashboard@0.0.0 build
> vite build

vite v7.3.6 building client environment for production...
transforming...
✓ 53 modules transformed.
rendering chunks...
computing gzip size...
dist/index.html                   0.46 kB │ gzip:  0.29 kB
dist/assets/index-B1jnPcc-.css   32.71 kB │ gzip:  6.79 kB
dist/assets/index-BLe-9Ky6.js   309.98 kB │ gzip: 86.43 kB
✓ built in 677ms

> @mockmate/server@0.1.0 build
> tsc
```

Result: PASS, exit 0. Both dashboard builds and the server TypeScript build completed.

## Release 2 Scope Boundary

Exact command:

```bash
git grep -n "schemaVersion: 3\|BodyAsset\|activeStateId\|baseStateId\|CompiledProject" -- packages/server/src packages/dashboard/src
```

Exact output:

```text
(no output)
```

Result: PASS. None of the requested Release 2 terms appears in the production source trees.

## Run-Unique Certificate Path Safety

The focused certificate run used a newly created invocation-specific `TMPDIR`. Before launching Vitest, the diagnostic snapshotted matching worker roots inside that directory. It accepted only a certificate path whose worker root was absent from the snapshot and failed if no new path appeared.

Exact diagnostic command:

```bash
setopt local_options null_glob; host_tmp="$TMPDIR"; evidence_tmp=$(mktemp -d "${host_tmp%/}/mockmate-task11-cert-evidence.XXXXXX"); before_roots=( "$evidence_tmp"/mockmate-vitest-*(N/) ); print -r -- "RUN_UNIQUE_TMPDIR=$evidence_tmp"; print -r -- "PREEXISTING_MATCH_COUNT=${#before_roots[@]}"; for old_root in "${before_roots[@]}"; do print -r -- "PREEXISTING_MATCH=$old_root"; done; observed=""; TMPDIR="$evidence_tmp" npm run test --workspace=packages/server -- src/services/certs/generator.test.ts --run & test_pid=$!; while kill -0 "$test_pid" 2>/dev/null; do for cert_dir in "$evidence_tmp"/mockmate-vitest-*/home/.mockmate/certs(N/); do worker_root="${cert_dir%/home/.mockmate/certs}"; seen_before=false; for old_root in "${before_roots[@]}"; do if [[ "$worker_root" == "$old_root" ]]; then seen_before=true; break; fi; done; if [[ "$seen_before" == false && -z "$observed" ]]; then observed="$cert_dir"; print -r -- "NEW_CERTIFICATE_STORAGE_ROOT=$observed"; fi; done; sleep 0.05; done; wait "$test_pid"; test_status=$?; print -r -- "FOCUSED_TEST_EXIT_STATUS=$test_status"; if [[ -z "$observed" ]]; then print -r -- "ERROR=No newly appearing certificate storage root observed"; exit 2; fi; exit "$test_status"
```

Exact attribution evidence:

```text
RUN_UNIQUE_TMPDIR=/var/folders/71/6x5bh8g12t551kfqd44dm_mc0000gn/T/mockmate-task11-cert-evidence.tGcJzj
PREEXISTING_MATCH_COUNT=0
NEW_CERTIFICATE_STORAGE_ROOT=/var/folders/71/6x5bh8g12t551kfqd44dm_mc0000gn/T/mockmate-task11-cert-evidence.tGcJzj/mockmate-vitest-31551-1/home/.mockmate/certs
```

Exact focused result:

```text
> @mockmate/server@0.1.0 test
> vitest run src/services/certs/generator.test.ts --run

Test Files  1 passed (1)
     Tests  46 passed (46)
  Duration  16.41s
FOCUSED_TEST_EXIT_STATUS=0
```

The corresponding worker root was `/var/folders/71/6x5bh8g12t551kfqd44dm_mc0000gn/T/mockmate-task11-cert-evidence.tGcJzj/mockmate-vitest-31551-1`. The pre-run snapshot contained zero matches, and the accepted path appeared beneath the invocation-specific parent while the focused process was running. This makes the path uniquely attributable to this invocation.

The observed certificate directory is beneath the OS temporary directory and outside the real user home `/Users/amanchawla`. Test setup maps `HOME`, `USERPROFILE`, and `MOCKMATE_DATA_DIR` beneath the worker root before certificate modules load. Recursive test cleanup remains guarded by `assertSafeTestPath`, and the passing safety tests reject cleanup against the original home.

Certificate path-safety result: PASS. No fresh evidence indicated access to real user data.

## Diff Check

Exact command:

```bash
git diff --check
```

Exact output:

```text
(no output)
```

Result: PASS; no whitespace errors.

## Concerns

- Dashboard tests pass but React reports nested `<button>` elements in `App.test.tsx` and `ScenarioEditor.test.tsx`, identifying invalid HTML and a possible hydration error.
- Server tests pass but emit Vite's CJS Node API deprecation warning.
- Passing admin sanitization and rollback tests intentionally emit synthetic error stacks, injected destination-write failures, and an injected rollback `EPERM` diagnostic.
- The repository has no `tools/` directory or `*.test.mjs`; root test coverage is correctly limited to dashboard and server workspaces.
