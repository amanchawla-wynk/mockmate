# MockMate Dashboard

The dashboard is the schema-v4 authoring and review UI for Projects, Endpoints,
Variants, App States, Traffic, static files, and interception settings.

## Ownership Rules

- Endpoint forms edit the Endpoint-owned `baseUrl`, matcher, mode, and Variants.
- App State mode and selection retain dormant IDs and bindings while disabled.
- Traffic detail owns redacted evidence, exact-body retrieval, and reviewed
  `Mock This` promotion.
- Interception settings save `interceptHosts`, `captureRawTraffic`, and
  `debugProvenanceHeaders` together with one expected revision.
- Import, Endpoint creation, Traffic capture, and promotion never change the
  interception allowlist implicitly.

## Commands

```bash
npm run dev --workspace=packages/dashboard
npm run test --workspace=packages/dashboard
npm run typecheck --workspace=packages/dashboard
npm run build --workspace=packages/dashboard
```

See [Traffic capture and interception](../../docs/traffic-capture.md) for the
canonical routes and operator behavior.
