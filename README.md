# MockMate

MockMate is a local schema-v4 mock API server for mobile development. It can
intercept selected backend origins through an HTTP proxy, serve canonical mocks,
pass requests through to their original origins, and record bounded Traffic
evidence for review.

## Quick Start

```bash
npm install
npm start
```

The dashboard is served from `http://localhost:3456`. Open `/setup` from a device
on the same network to install and trust the development CA and configure the
HTTP proxy.

## Core Model

- A Project owns runtime interception settings and App State mode.
- An Endpoint owns a required HTTP/HTTPS `baseUrl`, matcher, mode, and Variants.
- Endpoint mode is `mock` or `passthrough`. Mock mode requires a Serving now Variant.
- With App States disabled, mock Endpoints serve their Serving now Variant. With App
  States enabled, only active-state bindings are mocked; unbound Endpoints pass through.
- Traffic records redacted request evidence, bounded body previews, and exact
  request/response bodies (always retained; subject to ephemeral LRU eviction).
- `debugProvenanceHeaders` controls diagnostic response headers.

## Proxy Setup

Keep applications pointed at their real backend URLs. Install and trust the
MockMate CA, configure the device HTTP proxy, then explicitly save exact or
wildcard hostnames in the interception allowlist. Unselected HTTPS remains blind
and unrecorded. A catch-all `*` requires confirmation.

Selected unmatched requests and Passthrough Endpoints forward to the incoming
original origin. Direct requests to MockMate require a trusted backend `Host`
authority and never perform passthrough.

## Development

```bash
npm run dev:server
npm run dev:dashboard
npm test
npm run build
```

## Documentation

- [Traffic capture and interception](./docs/traffic-capture.md)
- [HTTPS setup](./docs/HTTPS-Support-Guide.md)
- [Troubleshooting](./docs/Troubleshooting.md)

## License

MIT
