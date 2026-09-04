# MockMate Agent Instructions

## Lean Development Workflow

- Do not invoke skills for small, fully specified changes or informational
  questions. Use a skill only when the user requests it or the task is
  genuinely ambiguous, complex, or high risk.
- For focused work, inspect the relevant files, make the smallest correct
  patch, and run focused verification.
- Run targeted tests while developing. Reserve full workspace tests and builds
  for substantial changes, risky cross-package work, or pre-merge verification.
- Use subagents only for independent parallel work, broad unfamiliar searches,
  or high-risk reviews. Do not duplicate their work in the main session.
- Use Context7 for unfamiliar or version-sensitive library APIs, migrations,
  and documentation-specific debugging. Prefer existing repository patterns for
  routine framework usage.
- Use Playwright only for browser-specific debugging or a final smoke test of
  user-facing frontend changes. It is disabled in the global OpenCode config by
  default and can be enabled for those sessions.
- Batch independent reads and searches in parallel. Keep `glob`, `grep`,
  targeted `read`, `apply_patch`, focused tests, and final diff inspection as
  the default reliability baseline.

## Graphify

This project uses a generated knowledge graph in `graphify-out/`. The graph is
an index of the source tree, not a source of truth.

This setup targets Graphify 0.8.13 from the `graphifyy` package. On a new
machine, run `uv tool install 'graphifyy==0.8.13'` and
`graphify install --platform opencode`.

- When the user types `/graphify`, invoke the `graphify` skill before doing
  anything else.
- Use `graphify query` for broad architecture questions or unfamiliar
  cross-module relationships when direct code search is insufficient. Use
  `graphify path` and `graphify explain` only when their focused graph views add
  value.
- Read `graphify-out/GRAPH_REPORT.md` only for broad architecture context or
  when query/path/explain do not return enough information.
- Dirty generated graph files are expected and are not a reason to skip the
  graph. Only skip it when the task concerns stale graph output or the user asks
  not to use it.
- The OpenCode plugin marks `graphify-out/.needs_update` after edits instead of
  synchronously refreshing the graph after every patch. Run `graphify update .`
  once at the end of a substantial task when graph freshness is useful, or when
  the user explicitly requests it.

## Skills

Project-local skills are installed in `.agents/skills/` and pinned by
`skills-lock.json`. Restore them with `npx skills experimental_install`.

The local set contains Matt Pocock's engineering and productivity skills plus
`design-taste-frontend`. Keep these available for explicit workflows without
invoking them automatically for routine development.

Durable Superpowers designs and plans belong in `docs/superpowers/specs/` and
`docs/superpowers/plans/`. Runtime state under `.superpowers/` is generated and
must not be committed.
