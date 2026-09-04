# MockMate Release 1 Safety Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove MockMate's current corruption, certificate, upload, header, identity, error, and traffic-scaling hazards without introducing the versioned-core persistence model.

**Architecture:** Keep the current TypeScript/Express `Project`/`Resource`/`Scenario` model for this release, but place safe boundaries around it: isolated storage, stable scenario IDs, explicit update semantics, structured errors, route-specific body parsing, and project-scoped traffic. Release 2 replaces this compatibility model with the canonical repository, Body Assets, Endpoints, Response Variants, and App States.

**Tech Stack:** TypeScript, Node.js, Express 4, React 19, Vitest, Supertest, jsdom, Testing Library.

## Global Constraints

- This is an in-place TypeScript/Express migration, not a rewrite.
- Do not run `packages/server/src/services/certs/generator.test.ts` until Task 1 is complete and reviewed.
- Names are display values only. Stable IDs are used in paths and references.
- `undefined` retains an optional value; explicit `null` clears it; persisted cleared optional fields are omitted.
- JSON `null` remains a valid response body and must not be interpreted as a clear operation.
- All admin errors use `code`, `message`, optional `path`, optional `details`, optional `recovery`, and `requestId`.
- Use `400` for malformed requests, `404` for missing IDs, `409` for collisions, `413` for size limits, and sanitized `500` responses. Release 2 adds canonical `422` validation behavior.
- Normal editable bodies target 10 MiB, but immutable Body Assets and the exact final 10 MiB contract are Release 2 work.
- Do not add `schemaVersion: 3`, generations, Body Assets, compiled matching, App States, optimistic revisions, or migration compatibility to Release 1.
- Do not start the full dashboard redesign, device pairing, bundle import/export, proxy rewrite, stream faults, or HLS/DASH work.
- Follow red-green-refactor for every behavior change and commit after each task passes its targeted tests.

---

### Task 1: Isolate Certificate Tests From User Data

**Files:**
- Create: `packages/server/src/test-support/test-storage.ts`
- Create: `packages/server/src/test-support/test-storage.test.ts`
- Modify: `packages/server/src/vitest.setup.ts`
- Modify: `packages/server/src/services/certs/generator.test.ts`
- Modify: `packages/server/vitest.config.ts`

**Interfaces:**
- Consumes: Vitest's `VITEST_WORKER_ID`, Node's temporary directory, and the existing `MOCKMATE_DATA_DIR` storage override.
- Produces: `getTestStorageRoot(): string`, `assertSafeTestPath(candidate: string, testRoot?: string): void`, and `cleanupTestStorage(): void`.

- [ ] **Step 1: Add a failing containment test without running the certificate suite**

```ts
// packages/server/src/test-support/test-storage.test.ts
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertSafeTestPath,
  getOriginalHome,
  getTestStorageRoot,
} from './test-storage';

describe('test storage safety', () => {
  it('places storage below the worker-specific temporary root', () => {
    const root = getTestStorageRoot();
    expect(path.relative(os.tmpdir(), root)).not.toMatch(/^\.\.(?:\/|\\|$)/);
    expect(process.env.MOCKMATE_DATA_DIR).toBe(root);
  });

  it('rejects cleanup outside the test root', () => {
    expect(() => assertSafeTestPath(getOriginalHome())).toThrow(
      /Refusing to modify a path outside MockMate test storage/,
    );
  });
});
```

- [ ] **Step 2: Run only the new test and verify RED**

Run: `npm run test --workspace=packages/server -- --run src/test-support/test-storage.test.ts`

Expected: FAIL because `./test-storage` and its exported safety functions do not exist. Do not run `generator.test.ts` yet.

- [ ] **Step 3: Implement worker-scoped storage and guarded cleanup**

```ts
// packages/server/src/test-support/test-storage.ts
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const originalHome = os.homedir();
const workerId = process.env.VITEST_WORKER_ID ?? '0';
const testRoot = path.join(
  os.tmpdir(),
  `mockmate-vitest-${process.pid}-${workerId}`,
);

export function getTestStorageRoot(): string {
  return testRoot;
}

export function getOriginalHome(): string {
  return originalHome;
}

export function assertSafeTestPath(
  candidate: string,
  root = testRoot,
): void {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return;
  }
  throw new Error('Refusing to modify a path outside MockMate test storage');
}

export function cleanupTestStorage(): void {
  assertSafeTestPath(testRoot);
  fs.rmSync(testRoot, { recursive: true, force: true });
}
```

Replace `packages/server/src/vitest.setup.ts` with setup that runs before test modules import certificate code:

```ts
import * as path from 'node:path';
import {
  cleanupTestStorage,
  getTestStorageRoot,
} from './test-support/test-storage';

const root = getTestStorageRoot();
const fakeHome = path.join(root, 'home');

process.env.MOCKMATE_DATA_DIR = root;
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;

cleanupTestStorage();
```

In `generator.test.ts`, derive the directory only after setup and guard every removal:

```ts
import { getStorageConfig } from '../storage';
import { assertSafeTestPath } from '../../test-support/test-storage';

const testCertsDir = () => getStorageConfig().certsDir;

beforeEach(() => {
  assertSafeTestPath(testCertsDir());
  fs.rmSync(testCertsDir(), { recursive: true, force: true });
});
```

Set `fileParallelism: true` in `vitest.config.ts`; isolation comes from worker-specific paths rather than disabling parallel tests.

- [ ] **Step 4: Verify the safety helper, then the certificate suite**

Run: `npm run test --workspace=packages/server -- --run src/test-support/test-storage.test.ts`

Expected: PASS.

Run: `npm run test --workspace=packages/server -- --run src/services/certs/generator.test.ts`

Expected: PASS. Existing certificate behavior remains unchanged in Task 1; this task changes only test isolation. Confirm from the test paths that no read, write, or delete resolves beneath the user's real home directory.

- [ ] **Step 5: Commit the isolation boundary**

```bash
git add packages/server/src/test-support/test-storage.ts packages/server/src/test-support/test-storage.test.ts packages/server/src/vitest.setup.ts packages/server/src/services/certs/generator.test.ts packages/server/vitest.config.ts
git commit -m "test: isolate certificate storage"
```

---

### Task 2: Preserve The CA And Renew Only The Leaf

**Files:**
- Modify: `packages/server/src/services/certs/generator.ts`
- Modify: `packages/server/src/services/certs/types.ts`
- Modify: `packages/server/src/services/certs/generator.test.ts`
- Modify: `packages/server/src/services/certs/test-certs.ts`
- Modify: `packages/server/src/services/storage.ts`
- Modify: `packages/server/src/routes/setup.ts`

**Interfaces:**
- Consumes: `getStorageConfig().certsDir`, `CertificateData`, `CertificatePair`, and node-forge certificate parsing.
- Produces: `CertificatePaths`, `getCertificatePaths`, `loadCA`, `loadServerCertificate`, `saveCA`, `saveServerCertificate`, `validateCertificateKeyPair`, `validateCertificateAuthority`, `certificateCoversDomains`, `shouldRegenerateLeaf`, and the revised `ensureCertificates`.

- [ ] **Step 1: Add failing CA-retention and SAN tests**

```ts
it('keeps the trusted CA when the requested SAN set changes', async () => {
  const first = await ensureCertificates(['192.168.1.10']);
  const second = await ensureCertificates(['192.168.1.11']);

  expect(second.ca.cert).toBe(first.ca.cert);
  expect(second.ca.privateKey).toBe(first.ca.privateKey);
  expect(second.server.cert).not.toBe(first.server.cert);
  expect(certificateCoversDomains(second.server.cert, [
    'localhost',
    '127.0.0.1',
    '192.168.1.11',
  ])).toBe(true);
});

it('honors a custom certificate directory without reloading the module', async () => {
  const customDir = path.join(getTestStorageRoot(), 'custom-certs');
  await ensureCertificates(['localhost'], customDir);
  expect(getCertificatePaths(customDir).caCert).toBe(
    path.join(customDir, 'ca.crt'),
  );
  expect(fs.existsSync(path.join(customDir, 'server.crt'))).toBe(true);
});

it.each([
  ['missing leaf', removeServerCertificate, true, false],
  ['invalid leaf', writeInvalidServerCertificate, true, false],
  ['expiring leaf', writeExpiringServerCertificate, true, false],
  ['unchanged SAN set', keepCertificateFiles, true, true],
  ['invalid CA', writeInvalidCA, false, false],
])('%s produces the expected CA/leaf reuse', async (_name, mutate, reuseCA, reuseLeaf) => {
  const first = await ensureCertificates(['localhost']);
  await mutate();
  const second = await ensureCertificates(['localhost']);
  expect(second.ca.cert === first.ca.cert).toBe(reuseCA);
  expect(second.server.cert === first.server.cert).toBe(reuseLeaf);
  expect(isCertificateSignedBy(second.server.cert, second.ca.cert)).toBe(true);
});

it('downloads the active retained CA and writes private keys as 0600', async () => {
  const pair = await ensureCertificates(['localhost']);
  const response = await request(app).get('/setup/ca.crt');
  expect(response.text).toBe(pair.ca.cert);
  expect(fs.statSync(getCertificatePaths().caKey).mode & 0o777).toBe(0o600);
  expect(fs.statSync(getCertificatePaths().serverKey).mode & 0o777).toBe(0o600);
});
```

Add exact key-pair regressions:

```ts
it('rotates both certificates when the CA key does not match the CA certificate', async () => {
  const first = await ensureCertificates(['localhost']);
  saveCA({ cert: first.ca.cert, privateKey: generateCA().privateKey });
  const second = await ensureCertificates(['localhost']);
  expect(second.ca.cert).not.toBe(first.ca.cert);
  expect(validateCertificateKeyPair(second.ca)).toBe(true);
});

it('keeps the CA but renews the leaf when the leaf key does not match', async () => {
  const first = await ensureCertificates(['localhost']);
  saveServerCertificate({ cert: first.server.cert, privateKey: generateCA().privateKey });
  const second = await ensureCertificates(['localhost']);
  expect(second.ca.cert).toBe(first.ca.cert);
  expect(second.server.cert).not.toBe(first.server.cert);
  expect(validateCertificateKeyPair(second.server)).toBe(true);
});
```

- [ ] **Step 2: Run the certificate test and verify RED**

Run: `npm run test --workspace=packages/server -- --run src/services/certs/generator.test.ts`

Expected: FAIL because current module-level paths ignore `certsDir`, changed SANs reuse the old leaf, and leaf renewal rotates the CA.

- [ ] **Step 3: Replace static paths with dynamic certificate paths**

```ts
export interface CertificatePaths {
  certsDir: string;
  caCert: string;
  caKey: string;
  serverCert: string;
  serverKey: string;
}

export function getCertificatePaths(certsDir = getStorageConfig().certsDir): CertificatePaths {
  return {
    certsDir,
    caCert: path.join(certsDir, 'ca.crt'),
    caKey: path.join(certsDir, 'ca.key'),
    serverCert: path.join(certsDir, 'server.crt'),
    serverKey: path.join(certsDir, 'server.key'),
  };
}

export function loadCA(certsDir?: string): CertificateData | null;
export function loadServerCertificate(certsDir?: string): CertificateData | null;
export function saveCA(ca: CertificateData, certsDir?: string): void;
export function saveServerCertificate(server: CertificateData, certsDir?: string): void;
```

Write private keys with `{ mode: 0o600 }`. Keep certificates at `0o644`.

- [ ] **Step 4: Implement separate CA and leaf lifecycle decisions**

```ts
export function shouldRegenerateLeaf(
  ca: CertificateData,
  server: CertificateData | null,
  domains: string[],
): boolean {
  if (!server) return true;
  if (!validateCertificateKeyPair(server)) return true;
  if (validateCertificate(server.cert).shouldRegenerate) return true;
  if (!certificateCoversDomains(server.cert, normalizeDomains(domains))) return true;
  return !isCertificateSignedBy(server.cert, ca.cert);
}

export async function ensureCertificates(
  domains: string[] = [],
  certsDir?: string,
): Promise<CertificatePair> {
  const requestedDomains = normalizeDomains(domains);
  let ca = loadCA(certsDir);
  const caInvalid = !ca
    || !validateCertificateKeyPair(ca)
    || !validateCertificateAuthority(ca.cert)
    || validateCertificate(ca.cert).shouldRegenerate;

  if (caInvalid) {
    ca = generateCA();
    saveCA(ca, certsDir);
    const server = generateServerCert(ca, requestedDomains);
    saveServerCertificate(server, certsDir);
    return { ca, server };
  }

  let server = loadServerCertificate(certsDir);
  if (shouldRegenerateLeaf(ca, server, requestedDomains)) {
    server = generateServerCert(ca, requestedDomains);
    saveServerCertificate(server, certsDir);
  }
  return { ca, server };
}
```

`normalizeDomains` must always include `localhost` and `127.0.0.1`, remove duplicates, and sort values before comparison. Update setup download paths to use `getCertificatePaths()`.

`validateCertificateKeyPair` signs a fixed digest with the private key and verifies it with the certificate public key. `validateCertificateAuthority` requires CA basic constraints, verifies the CA self-signature, and rejects malformed certificates. `isCertificateSignedBy` verifies the leaf signature with the retained CA public key.

- [ ] **Step 5: Verify certificate behavior**

Run: `npm run test --workspace=packages/server -- --run src/services/certs/generator.test.ts`

Expected: PASS, including byte-identical CA certificate/key across SAN changes and leaf-only renewal.

- [ ] **Step 6: Commit certificate lifecycle repair**

```bash
git add packages/server/src/services/certs/generator.ts packages/server/src/services/certs/types.ts packages/server/src/services/certs/generator.test.ts packages/server/src/services/certs/test-certs.ts packages/server/src/services/storage.ts packages/server/src/routes/setup.ts
git commit -m "fix: preserve trusted certificate authority"
```

---

### Task 3: Standardize Admin Error Responses

**Files:**
- Create: `packages/server/src/services/api-errors.ts`
- Create: `packages/server/src/services/api-errors.test.ts`
- Modify: `packages/server/src/types.ts`
- Modify: `packages/server/src/app.ts`
- Modify: `packages/server/src/routes/admin.ts`
- Modify: `packages/server/src/routes/admin.test.ts`
- Modify: `packages/server/src/app.test.ts`
- Modify: `packages/server/src/services/projects.ts`
- Modify: `packages/server/src/services/resources.ts`
- Modify: `packages/dashboard/package.json`
- Create: `packages/dashboard/vitest.config.ts`
- Create: `packages/dashboard/src/test/setup.ts`
- Modify: `packages/dashboard/src/api/types.ts`
- Modify: `packages/dashboard/src/api/client.ts`
- Create: `packages/dashboard/src/api/client.test.ts`

**Interfaces:**
- Consumes: Express middleware and domain-service not-found/collision failures.
- Produces: `ApiErrorResponse`, `HttpError`, `serializeApiError`, `requestIdMiddleware`, `apiErrorMiddleware`, dashboard `ApiClientError`, and the dashboard Vitest harness.

- [ ] **Step 1: Install and configure the dashboard test harness**

Run:

```bash
npm install --workspace=packages/dashboard --save-dev vitest@^3.2.4 jsdom@^26.1.0 @testing-library/react@^16.3.0 @testing-library/jest-dom@^6.8.0 @testing-library/user-event@^14.6.1
```

Add `"test": "vitest"` and `"test:watch": "vitest --watch"` to dashboard scripts. Create `vitest.config.ts` with `environment: 'jsdom'`, `globals: true`, and `setupFiles: ['./src/test/setup.ts']`; import `@testing-library/jest-dom/vitest` from setup.

- [ ] **Step 2: Add failing structured-error tests**

```ts
it('sanitizes unexpected admin failures', () => {
  const response = serializeApiError(
    new Error('/Users/example/.mockmate/secret'),
    'req-test',
  );
  expect(response).toEqual({
    status: 500,
    body: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
      requestId: 'req-test',
    },
  });
  expect(JSON.stringify(response)).not.toContain('/Users/example');
});

it('returns structured malformed-JSON errors', async () => {
  const response = await request(createApp())
    .post('/api/admin/projects')
    .set('Content-Type', 'application/json')
    .send('{');
  expect(response.status).toBe(400);
  expect(response.body.code).toBe('MALFORMED_JSON');
  expect(response.body.requestId).toEqual(expect.any(String));
});
```

Dashboard client test:

```ts
await expect(projectsApi.get('missing')).rejects.toMatchObject({
  name: 'ApiClientError',
  status: 404,
  code: 'PROJECT_NOT_FOUND',
  requestId: 'req-123',
});
```

- [ ] **Step 3: Run the focused tests and verify RED**

Run: `npm run test --workspace=packages/server -- --run src/services/api-errors.test.ts src/app.test.ts src/routes/admin.test.ts`

Expected: FAIL because admin failures still use inconsistent `{ error }` objects and no request ID middleware exists.

- [ ] **Step 4: Implement the server error contract**

```ts
export interface ApiErrorResponse {
  code: string;
  message: string;
  path?: string;
  details?: unknown;
  recovery?: string;
  requestId: string;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly options: Omit<ApiErrorResponse, 'code' | 'message' | 'requestId'> = {},
  ) {
    super(message);
  }
}

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const requestId = req.get('X-Request-Id') || randomUUID();
  res.locals.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  next();
}

export function serializeApiError(
  error: unknown,
  requestId: string,
): { status: number; body: ApiErrorResponse } {
  if (isMalformedJsonError(error)) {
    return {
      status: 400,
      body: { code: 'MALFORMED_JSON', message: 'Request body is not valid JSON', requestId },
    };
  }
  if (error instanceof HttpError) {
    return {
      status: error.status,
      body: { code: error.code, message: error.message, ...error.options, requestId },
    };
  }
  return {
    status: 500,
    body: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred', requestId },
  };
}

export function apiErrorMiddleware(
  error: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const requestId = String(res.locals.requestId);
  const serialized = serializeApiError(error, requestId);
  if (serialized.status === 500) console.error(`[${requestId}]`, error);
  res.status(serialized.status).json(serialized.body);
}
```

Mount `requestIdMiddleware` before admin routes and `apiErrorMiddleware` after all routes. Convert service not-found and duplicate errors to typed `HttpError` instances; never expose arbitrary caught messages.

- [ ] **Step 5: Preserve structured errors in the dashboard client**

```ts
export class ApiClientError extends Error {
  readonly name = 'ApiClientError';
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId: string,
    readonly path?: string,
    readonly details?: unknown,
    readonly recovery?: string,
  ) {
    super(message);
  }
}
```

Use one `readApiError(response)` function for every dashboard API method.

- [ ] **Step 6: Verify server and dashboard error tests**

Run: `npm run test --workspace=packages/server -- --run src/services/api-errors.test.ts src/app.test.ts src/routes/admin.test.ts`

Expected: PASS.

Run: `npm run test --workspace=packages/dashboard -- --run src/api/client.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit structured errors**

```bash
git add packages/server/src/services/api-errors.ts packages/server/src/services/api-errors.test.ts packages/server/src/types.ts packages/server/src/app.ts packages/server/src/routes/admin.ts packages/server/src/routes/admin.test.ts packages/server/src/app.test.ts packages/server/src/services/projects.ts packages/server/src/services/resources.ts packages/dashboard/package.json packages/dashboard/vitest.config.ts packages/dashboard/src/test/setup.ts packages/dashboard/src/api/types.ts packages/dashboard/src/api/client.ts packages/dashboard/src/api/client.test.ts
git commit -m "feat: standardize admin errors"
```

---

### Task 4: Restrict Admin Access And CORS

**Files:**
- Create: `packages/server/src/middleware/admin-security.ts`
- Create: `packages/server/src/middleware/admin-security.test.ts`
- Modify: `packages/server/src/app.ts`
- Modify: `packages/server/src/app.test.ts`

**Interfaces:**
- Consumes: Task 3's `HttpError` and request IDs.
- Produces: `AppOptions`, `isLoopbackAddress`, and `requireLocalAdmin`.

- [ ] **Step 1: Add failing loopback and origin tests**

```ts
it.each(['127.0.0.1', '::1', '::ffff:127.0.0.1'])('accepts loopback %s', address => {
  expect(isLoopbackAddress(address)).toBe(true);
});

it('denies remote admin while leaving mock routes reachable', async () => {
  const app = createApp({ isAdminRequestLocal: () => false });
  expect((await request(app).get('/api/admin/status')).status).toBe(403);
  expect((await request(app).get('/setup')).status).not.toBe(403);
});

it('reflects only configured dashboard origins', async () => {
  const app = createApp({ dashboardOrigins: ['http://localhost:5173'] });
  const allowed = await request(app).get('/api/admin/status').set('Origin', 'http://localhost:5173');
  const denied = await request(app).get('/api/admin/status').set('Origin', 'https://attacker.example');
  expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  expect(denied.headers['access-control-allow-origin']).toBeUndefined();
});
```

- [ ] **Step 2: Run security tests and verify RED**

Run: `npm run test --workspace=packages/server -- --run src/middleware/admin-security.test.ts src/app.test.ts`

Expected: FAIL because CORS is wildcard and admin routes have no source-address ACL.

- [ ] **Step 3: Implement route-scoped administration security**

```ts
export interface AppOptions {
  dashboardOrigins?: string[];
  allowRemoteAdmin?: boolean;
  isAdminRequestLocal?: (req: Request) => boolean;
}

export function isLoopbackAddress(address?: string): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

export function requireLocalAdmin(options: AppOptions = {}): RequestHandler {
  return (req, _res, next) => {
    const local = options.isAdminRequestLocal?.(req) ?? isLoopbackAddress(req.socket.remoteAddress);
    if (!options.allowRemoteAdmin && !local) {
      next(new HttpError(403, 'ADMIN_LOCAL_ONLY', 'Administration is available only from this machine'));
      return;
    }
    next();
  };
}
```

Mount `requireLocalAdmin(options)` and precise-origin CORS on `/api/admin` before any admin body parser. Do not trust `X-Forwarded-For`; Express proxy trust remains disabled. Keep `/setup`, mock routes, static responses, and proxy traffic LAN reachable. Because the same Express application must serve device-facing mock routes, route-scoped loopback enforcement is the localhost administration boundary; a separate listener is not required for this release.

- [ ] **Step 4: Verify security tests**

Run: `npm run test --workspace=packages/server -- --run src/middleware/admin-security.test.ts src/app.test.ts`

Expected: PASS with remote admin denied by default and no wildcard admin origin.

- [ ] **Step 5: Commit admin security**

```bash
git add packages/server/src/middleware/admin-security.ts packages/server/src/middleware/admin-security.test.ts packages/server/src/app.ts packages/server/src/app.test.ts
git commit -m "fix: restrict admin access to localhost"
```

---

### Task 5: Preserve Exact Static Upload Bytes

**Files:**
- Create: `packages/server/src/routes/static-files.ts`
- Modify: `packages/server/src/app.ts`
- Modify: `packages/server/src/routes/admin.ts`
- Modify: `packages/server/src/routes/admin.test.ts`
- Modify: `packages/server/src/app.test.ts`
- Modify: `packages/server/src/services/fixtures.ts`
- Modify: `packages/server/src/services/fixtures.test.ts`

**Interfaces:**
- Consumes: Task 3 errors, Task 4 admin ACL, and existing `writeStaticFile`/static serving.
- Produces: `staticFilesRouter`, mounted before generic JSON parsing.

- [ ] **Step 1: Add failing byte-preservation tests**

```ts
const bytes = Buffer.from([0x00, 0xff, 0x7b, 0x22, 0x61, 0x22, 0x3a, 0x31, 0x7d]);
const upload = await request(app)
  .post(`/api/admin/projects/${project.id}/static-files?path=data/blob.bin`)
  .set('Content-Type', 'application/json')
  .send(bytes);
expect(upload.status).toBe(201);

const served = await request(app).get('/static_files/data/blob.bin').buffer(true);
expect(Buffer.from(served.body)).toEqual(bytes);

it.each([
  ['zero-byte body', Buffer.alloc(0), 'empty.bin', 201],
  ['unsafe traversal', Buffer.of(1), '../escape.bin', 400],
  ['oversized input', Buffer.alloc(50 * 1024 * 1024 + 1), 'large.bin', 413],
])('%s has deterministic upload behavior', async (_name, body, relPath, status) => {
  const response = await request(app)
    .post(`/api/admin/projects/${project.id}/static-files`)
    .query({ path: relPath })
    .set('Content-Type', 'application/octet-stream')
    .send(body);
  expect(response.status).toBe(status);
  if (status === 201) {
    const served = await request(app).get(`/static_files/${relPath}`).buffer(true);
    expect(Buffer.from(served.body)).toEqual(body);
  }
});

it('accepts legacy metadata above Express default 100 KiB', async () => {
  const response = await request(app).post(`/api/admin/projects/${project.id}/resources`)
    .send(resourceRequestWithBody('x'.repeat(128 * 1024)));
  expect(response.status).not.toBe(413);
});
```

- [ ] **Step 2: Run route tests and verify RED**

Run: `npm run test --workspace=packages/server -- --run src/app.test.ts src/routes/admin.test.ts src/services/fixtures.test.ts`

Expected: FAIL because the generic JSON parser consumes JSON-looking uploads before the raw parser and zero-byte uploads are mishandled.

- [ ] **Step 3: Create and mount a dedicated raw router first**

```ts
const router = Router({ mergeParams: true });

router.post(
  '/',
  express.raw({ type: '*/*', limit: '50mb' }),
  (req, res, next) => {
    try {
      if (!Buffer.isBuffer(req.body)) {
        throw new HttpError(400, 'STATIC_BODY_REQUIRED', 'Static upload body must be raw bytes');
      }
      const relPath = requireSafeRelativePath(String(req.query.path ?? ''));
      const project = getProject(req.params.projectId);
      const result = writeStaticFile(project.slug, relPath, req.body);
      res.status(201).json(result);
    } catch (error) {
      next(error);
    }
  },
);
```

Mount order in `app.ts`:

```ts
app.use(requestIdMiddleware);
app.use('/api/admin', requireLocalAdmin(options));
app.use('/api/admin/projects/:projectId/static-files', staticFilesRouter);
app.use('/api/admin', express.json({ limit: '12mb' }), adminRouter);
```

Remove the old upload handler and late raw-parser block from `admin.ts`/`app.ts`. Translate body-parser size failures to `413 PAYLOAD_TOO_LARGE`.

- [ ] **Step 4: Verify upload and serving tests**

Run: `npm run test --workspace=packages/server -- --run src/app.test.ts src/routes/admin.test.ts src/services/fixtures.test.ts`

Expected: PASS with exact binary, JSON-looking, and zero-byte round trips.

- [ ] **Step 5: Commit raw static uploads**

```bash
git add packages/server/src/routes/static-files.ts packages/server/src/app.ts packages/server/src/routes/admin.ts packages/server/src/routes/admin.test.ts packages/server/src/app.test.ts packages/server/src/services/fixtures.ts packages/server/src/services/fixtures.test.ts
git commit -m "fix: preserve static upload bytes"
```

---

### Task 6: Separate Request And Response Header Semantics

**Files:**
- Create: `packages/dashboard/src/components/HeadersTable.tsx`
- Create: `packages/dashboard/src/components/HeadersTable.test.tsx`
- Modify: `packages/server/src/types.ts`
- Modify: `packages/server/src/services/resources.ts`
- Modify: `packages/server/src/services/matcher.ts`
- Modify: `packages/server/src/routes/admin.ts`
- Modify: `packages/server/src/services/resources.test.ts`
- Modify: `packages/server/src/services/matcher.test.ts`
- Modify: `packages/server/src/routes/admin.test.ts`
- Modify: `packages/server/src/app.test.ts`
- Modify: `packages/dashboard/src/api/types.ts`
- Modify: `packages/dashboard/src/components/ScenarioEditor.tsx`
- Delete: `packages/dashboard/src/components/ResponseHeadersTable.tsx`

**Interfaces:**
- Consumes: existing `Resource.match`, legacy `Scenario.headers`, `requestBody`, `queryParams`, and import adapters.
- Produces: `RequestMatcher`, `RequestExample`, `ResponseHeaders`, and `normalizeScenario`.

- [ ] **Step 1: Add failing credential-reflection tests**

```ts
it('never emits example request headers in the response', () => {
  const scenario = normalizeScenario({
    name: 'default',
    statusCode: 200,
    body: { ok: true },
    headers: { Authorization: 'Bearer secret' },
    responseHeaders: { 'X-Mock': 'yes' },
  });
  const response = buildResponse(scenario);
  expect(response.headers.Authorization).toBeUndefined();
  expect(response.headers['X-Mock']).toBe('yes');
  expect(scenario.requestExample?.headers?.Authorization).toBe('Bearer secret');
});

it.each([
  ['cURL', () => importCurl("curl -H 'Authorization: Bearer secret' https://api.test/items")],
  ['Postman', () => importPostman(collectionWithAuthorizationHeader)],
])('stores %s request headers only as request examples', async (_format, runImport) => {
  const imported = await runImport();
  expect(imported.scenarios[0].requestExample?.headers?.Authorization).toBe('Bearer secret');
  expect(buildResponse(imported.scenarios[0]).headers.Authorization).toBeUndefined();
});

it('continues using resource matcher headers for selection', () => {
  const match = matchRequest('GET', '/items', [resourceWithMatcherHeader('x-plan', 'paid')], {
    headers: { 'x-plan': 'paid' },
  });
  expect(match?.resource.id).toBe('resource_paid');
});
```

Add the UI regression before changing labels:

```tsx
it('renders matcher, example, and response headers as separate sections', () => {
  render(<ScenarioEditor projectId="p1" resource={resourceWithAllHeaderKinds} onUpdate={vi.fn()} />);
  expect(screen.getByRole('heading', { name: 'Request matcher headers' })).toBeVisible();
  expect(screen.getByRole('heading', { name: 'Example request headers' })).toBeVisible();
  expect(screen.getByRole('heading', { name: 'Response headers' })).toBeVisible();
});
```

- [ ] **Step 2: Run matcher/resource/import tests and verify RED**

Run: `npm run test --workspace=packages/server -- --run src/services/resources.test.ts src/services/matcher.test.ts src/routes/admin.test.ts src/app.test.ts`

Expected: FAIL because `Scenario.headers` is merged into emitted response headers.

- [ ] **Step 3: Introduce unambiguous types and legacy normalization**

```ts
export interface RequestMatcher {
  query?: Record<string, string>;
  headers?: Record<string, string>;
}

export interface RequestExample {
  headers?: Record<string, string>;
  queryParams?: QueryParam[];
  body?: unknown;
}

export type ResponseHeaders = Record<string, string>;

export interface Scenario {
  name: string;
  statusCode: number;
  body: unknown;
  fixture?: FixtureReference;
  requestExample?: RequestExample;
  responseHeaders?: ResponseHeaders;
  delay?: number;
  requestMatcher?: { path?: string; value?: unknown };
}
```

`normalizeScenario` must move legacy `headers`, `requestBody`, and `queryParams` into `requestExample`, keep `responseHeaders` separate, and omit the legacy keys from returned/persisted normalized objects.

- [ ] **Step 4: Emit response headers only and correct dashboard labels**

```ts
const headers: Record<string, string> = {
  'Content-Type': inferLegacyContentType(scenario.body),
  ...(scenario.responseHeaders ?? {}),
};
```

Use `HeadersTable` with explicit section labels: `Request matcher headers`, `Example request headers`, and `Response headers`. Replace the inaccurate “method + URL only” copy with text stating that method, host, path, query, and header matchers select an Endpoint.

- [ ] **Step 5: Verify server tests and dashboard compilation**

Run: `npm run test --workspace=packages/server -- --run src/services/resources.test.ts src/services/matcher.test.ts src/routes/admin.test.ts src/app.test.ts`

Expected: PASS.

Run: `npm run build --workspace=packages/dashboard`

Expected: PASS with no `Scenario.headers`, `requestBody`, or `queryParams` references in dashboard API types.

Run: `npm run test --workspace=packages/dashboard -- --run src/components/HeadersTable.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit semantic separation**

```bash
git add packages/server/src/types.ts packages/server/src/services/resources.ts packages/server/src/services/matcher.ts packages/server/src/routes/admin.ts packages/server/src/services/resources.test.ts packages/server/src/services/matcher.test.ts packages/server/src/routes/admin.test.ts packages/server/src/app.test.ts packages/dashboard/src/api/types.ts packages/dashboard/src/components/ScenarioEditor.tsx packages/dashboard/src/components/HeadersTable.tsx packages/dashboard/src/components/HeadersTable.test.tsx packages/dashboard/src/components/ResponseHeadersTable.tsx
git commit -m "fix: separate request and response headers"
```

---

### Task 7: Add Explicit Clear Semantics

**Files:**
- Create: `packages/server/src/services/update-semantics.ts`
- Create: `packages/server/src/services/update-semantics.test.ts`
- Modify: `packages/server/src/types.ts`
- Modify: `packages/server/src/services/projects.ts`
- Modify: `packages/server/src/services/resources.ts`
- Modify: `packages/server/src/services/projects.test.ts`
- Modify: `packages/server/src/services/resources.test.ts`
- Modify: `packages/server/src/routes/admin.test.ts`
- Modify: `packages/dashboard/src/api/types.ts`
- Modify: `packages/dashboard/src/components/PassthroughSettings.tsx`
- Modify: `packages/dashboard/src/components/ResourceEditor.tsx`
- Modify: `packages/dashboard/src/components/ScenarioEditor.tsx`
- Create: `packages/dashboard/src/components/UpdateForms.test.tsx`

**Interfaces:**
- Consumes: Task 6's unambiguous request/response fields.
- Produces: nullable update contracts, `applyOptionalUpdate`, and body-property presence checks.

- [ ] **Step 1: Add failing retain/clear/null-body tests**

```ts
it('distinguishes omitted optional values from explicit clears', () => {
  expect(applyOptionalUpdate('old', undefined)).toBe('old');
  expect(applyOptionalUpdate('old', null)).toBeUndefined();
  expect(applyOptionalUpdate('old', 'new')).toBe('new');
});

it('stores JSON null as the response body', () => {
  const updated = updateScenario(project.id, resource.id, scenario.id, { body: null });
  expect(updated.scenarios[0].body).toBeNull();
});

it.each([
  ['project description', () => updateProject(project.id, { description: null }), 'description'],
  ['project baseUrl', () => updateProject(project.id, { baseUrl: null }), 'baseUrl'],
  ['project interceptHosts', () => updateProject(project.id, { interceptHosts: null }), 'interceptHosts'],
  ['resource host', () => updateResource(project.id, resource.id, { host: null }), 'host'],
  ['resource matcher', () => updateResource(project.id, resource.id, { match: null }), 'match'],
  ['scenario fixture', () => updateScenario(project.id, resource.id, scenario.id, { fixture: null }), 'fixture'],
  ['scenario request example', () => updateScenario(project.id, resource.id, scenario.id, { requestExample: null }), 'requestExample'],
  ['scenario response headers', () => updateScenario(project.id, resource.id, scenario.id, { responseHeaders: null }), 'responseHeaders'],
  ['scenario delay', () => updateScenario(project.id, resource.id, scenario.id, { delay: null }), 'delay'],
])('clears %s rather than retaining stale data', (_name, update, field) => {
  expect(update()).not.toHaveProperty(field);
});
```

Add the dashboard clear regression before changing form payloads:

```tsx
it('sends null when an optional text field is deliberately cleared', async () => {
  render(<PassthroughSettings project={projectWithBaseUrl} onUpdate={vi.fn()} />);
  await userEvent.clear(screen.getByLabelText('Base URL'));
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(projectsApi.update).toHaveBeenCalledWith(projectWithBaseUrl.id, {
    baseUrl: null,
  });
});
```

- [ ] **Step 2: Run update tests and verify RED**

Run: `npm run test --workspace=packages/server -- --run src/services/update-semantics.test.ts src/services/projects.test.ts src/services/resources.test.ts src/routes/admin.test.ts`

Expected: FAIL because nullish coalescing currently retains stale optional values and treats body `null` as absent.

- [ ] **Step 3: Implement explicit update semantics**

```ts
export function applyOptionalUpdate<T>(
  current: T | undefined,
  update: T | null | undefined,
): T | undefined {
  if (update === undefined) return current;
  if (update === null) return undefined;
  return update;
}
```

Update contracts:

```ts
export interface UpdateProjectRequest {
  name?: string;
  description?: string | null;
  baseUrl?: string | null;
  interceptHosts?: string[] | null;
  environmentVariables?: EnvironmentVariable[] | null;
  passthroughEnabled?: boolean;
  captureRawTraffic?: boolean;
}

export interface UpdateResourceRequest {
  method?: HttpMethod;
  host?: string | null;
  path?: string;
  description?: string | null;
  match?: RequestMatcher | null;
  passthrough?: boolean;
}

export interface UpdateScenarioRequest {
  statusCode?: number;
  body?: unknown;
  fixture?: FixtureReference | null;
  requestExample?: RequestExample | null;
  responseHeaders?: ResponseHeaders | null;
  delay?: number | null;
}
```

Apply body updates with `Object.prototype.hasOwnProperty.call(updates, 'body')`, not `??`. Omit cleared optional properties when serializing.

- [ ] **Step 4: Send `null` from empty dashboard controls**

```ts
const normalizeOptionalText = (value: string): string | null => {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};
```

Use it in passthrough, resource, and scenario save payloads. Send `fixture: null` only when the user explicitly detaches it.

- [ ] **Step 5: Verify clear behavior and dashboard build**

Run: `npm run test --workspace=packages/server -- --run src/services/update-semantics.test.ts src/services/projects.test.ts src/services/resources.test.ts src/routes/admin.test.ts`

Expected: PASS.

Run: `npm run build --workspace=packages/dashboard`

Expected: PASS.

Run: `npm run test --workspace=packages/dashboard -- --run src/components/UpdateForms.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit explicit clears**

```bash
git add packages/server/src/services/update-semantics.ts packages/server/src/services/update-semantics.test.ts packages/server/src/types.ts packages/server/src/services/projects.ts packages/server/src/services/resources.ts packages/server/src/services/projects.test.ts packages/server/src/services/resources.test.ts packages/server/src/routes/admin.test.ts packages/dashboard/src/api/types.ts packages/dashboard/src/components/PassthroughSettings.tsx packages/dashboard/src/components/ResourceEditor.tsx packages/dashboard/src/components/ScenarioEditor.tsx packages/dashboard/src/components/UpdateForms.test.tsx
git commit -m "fix: distinguish clear from omitted updates"
```

---

### Task 8: Add Stable Scenario IDs And Boundary-Safe Drafts

**Files:**
- Create: `packages/server/src/services/scenario-ids.ts`
- Create: `packages/server/src/services/scenario-ids.test.ts`
- Modify: `packages/server/src/types.ts`
- Modify: `packages/server/src/services/resources.ts`
- Modify: `packages/server/src/routes/admin.ts`
- Modify: `packages/server/src/services/resources.test.ts`
- Modify: `packages/server/src/routes/admin.test.ts`
- Modify: `packages/server/src/app.test.ts`
- Modify: `packages/server/src/scripts/import-xstream-automation.ts`
- Modify: `packages/dashboard/src/api/types.ts`
- Modify: `packages/dashboard/src/api/client.ts`
- Modify: `packages/dashboard/src/components/ScenarioEditor.tsx`
- Modify: `packages/dashboard/src/App.tsx`
- Modify: `packages/dashboard/src/components/Layout.tsx`
- Modify: `packages/dashboard/src/components/ProjectList.tsx`
- Create: `packages/dashboard/src/components/ScenarioEditor.test.tsx`
- Create: `packages/dashboard/src/hooks/useUnsavedChangesGuard.ts`
- Create: `packages/dashboard/src/hooks/useUnsavedChangesGuard.test.tsx`

**Interfaces:**
- Consumes: current resource IDs, Task 7 update semantics, and Task 3 dashboard client errors.
- Produces: `Scenario.id`, ID-based CRUD routes, `compatibilityScenarioId`, `ScenarioDraftKey`, and `useUnsavedChangesGuard`.

- [ ] **Step 1: Add failing stable-ID and draft-isolation tests**

```ts
it('uses a scenario ID instead of a display name in CRUD routes', async () => {
  await scenariosApi.update('project/1', 'resource?1', 'scenario#1', { statusCode: 201 });
  expect(fetch).toHaveBeenCalledWith(
    '/api/admin/projects/project%2F1/resources/resource%3F1/scenarios/scenario%231',
    expect.objectContaining({ method: 'PUT' }),
  );
});
```

```tsx
it('does not carry a default-scenario draft into another resource', async () => {
  const { rerender } = render(<ScenarioEditor projectId="p1" resource={resourceA} onUpdate={vi.fn()} />);
  await userEvent.type(screen.getByLabelText('Response body'), '{"from":"A"}');
  rerender(<ScenarioEditor projectId="p1" resource={resourceB} onUpdate={vi.fn()} />);
  expect(screen.getByLabelText('Response body')).toHaveValue('{"from":"B"}');
});

it('blocks save while JSON is invalid and preserves the typed text', async () => {
  render(<ScenarioEditor projectId="p1" resource={resourceA} onUpdate={vi.fn()} />);
  await userEvent.clear(screen.getByLabelText('Response body'));
  await userEvent.type(screen.getByLabelText('Response body'), '{');
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  expect(fetch).not.toHaveBeenCalled();
  expect(screen.getByLabelText('Response body')).toHaveValue('{');
});
```

- [ ] **Step 2: Run stable-ID tests and verify RED**

Run: `npm run test --workspace=packages/server -- --run src/services/scenario-ids.test.ts src/services/resources.test.ts src/routes/admin.test.ts`

Expected: FAIL because `Scenario.id` and ID-based service signatures do not exist.

Run: `npm run test --workspace=packages/dashboard -- --run src/components/ScenarioEditor.test.tsx src/hooks/useUnsavedChangesGuard.test.tsx src/api/client.test.ts`

Expected: FAIL because drafts are keyed by scenario name and invalid text can save a stale parsed body.

- [ ] **Step 3: Implement stable scenario identity**

```ts
export function compatibilityScenarioId(resourceId: string, scenarioName: string): string {
  const digest = createHash('sha256')
    .update(`${resourceId}\0${scenarioName}`)
    .digest('hex')
    .slice(0, 20);
  return `scn_${digest}`;
}

export interface Scenario {
  id: string;
  name: string;
  // Task 6 fields remain unchanged.
}
```

Normalize missing IDs deterministically when reading legacy resources. Generate random stable IDs for new scenarios. Persist compatibility IDs on the next successful mutation, not during a read. Change service signatures and routes to `scenarioId`:

```ts
updateScenario(projectId, resourceId, scenarioId, updates): Resource;
deleteScenario(projectId, resourceId, scenarioId): Resource;
duplicateScenario(projectId, resourceId, scenarioId, newName): Resource;
```

- [ ] **Step 4: Isolate drafts and guard navigation**

```ts
export type ScenarioDraftKey = `${string}:${string}:${string}`;

export function scenarioDraftKey(
  projectId: string,
  resourceId: string,
  scenarioId: string,
): ScenarioDraftKey {
  return `${projectId}:${resourceId}:${scenarioId}`;
}
```

Key parsed values, response text, request-example text, dirty flags, and validation errors by this key. Mount the editor as:

```tsx
<ScenarioEditor
  key={`${activeProject.id}:${selectedResource.id}`}
  projectId={activeProject.id}
  resource={selectedResource}
  onDirtyChange={setEditorDirty}
  onUpdate={refreshResources}
/>
```

`useUnsavedChangesGuard` must install `beforeunload` while any draft is dirty and expose this stable interface for Release 2 reuse:

```ts
export interface UnsavedChangesGuard {
  markDirty(draftKey: string): void;
  clearDraft(draftKey: string): void;
  attemptNavigation(action: () => void, draftKey: string): void;
  stay(): void;
  discard(): void;
  dialog: { open: boolean; draftKey?: string };
}
```

`Stay` leaves the draft and pending action untouched. `Discard` clears `dialog.draftKey` and executes the pending action. Use `attemptNavigation` for project, resource, and view changes.

- [ ] **Step 5: Verify stable-ID and draft tests**

Run: `npm run test --workspace=packages/server -- --run src/services/scenario-ids.test.ts src/services/resources.test.ts src/routes/admin.test.ts src/app.test.ts`

Expected: PASS.

Run: `npm run test --workspace=packages/dashboard -- --run src/components/ScenarioEditor.test.tsx src/hooks/useUnsavedChangesGuard.test.tsx src/api/client.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit stable identity and safe drafts**

```bash
git add packages/server/src/services/scenario-ids.ts packages/server/src/services/scenario-ids.test.ts packages/server/src/types.ts packages/server/src/services/resources.ts packages/server/src/routes/admin.ts packages/server/src/services/resources.test.ts packages/server/src/routes/admin.test.ts packages/server/src/app.test.ts packages/server/src/scripts/import-xstream-automation.ts packages/dashboard/src/api/types.ts packages/dashboard/src/api/client.ts packages/dashboard/src/components/ScenarioEditor.tsx packages/dashboard/src/components/ScenarioEditor.test.tsx packages/dashboard/src/hooks/useUnsavedChangesGuard.ts packages/dashboard/src/hooks/useUnsavedChangesGuard.test.tsx packages/dashboard/src/App.tsx packages/dashboard/src/components/Layout.tsx packages/dashboard/src/components/ProjectList.tsx packages/dashboard/src/api/client.test.ts
git commit -m "fix: isolate drafts with stable scenario IDs"
```

---

### Task 9: Make Traffic-Created Mocks Editable

**Files:**
- Modify: `packages/server/src/routes/admin.ts`
- Modify: `packages/server/src/services/resources.ts`
- Modify: `packages/server/src/services/matcher.ts`
- Modify: `packages/server/src/services/fixtures.ts`
- Modify: `packages/server/src/routes/admin.test.ts`
- Modify: `packages/server/src/app.test.ts`
- Modify: `packages/server/src/services/matcher.test.ts`
- Modify: `packages/dashboard/src/components/ScenarioEditor.tsx`
- Modify: `packages/dashboard/src/api/types.ts`

**Interfaces:**
- Consumes: Task 6 response semantics, Task 7 `fixture: null`, Task 8 stable scenario IDs, and existing raw HTTP fixture parsing.
- Produces: `decodeEditableFixtureBody` and a complete Traffic -> Create Mock -> Edit -> Serve flow.

- [ ] **Step 1: Add a failing end-to-end regression test**

```ts
it('serves a visible edit after creating a mock from captured traffic', async () => {
  const created = await createMockFromCapturedJson({
    projectId: project.id,
    status: 202,
    headers: { 'content-type': 'application/json', 'x-source': 'capture' },
    body: Buffer.from('{"value":"captured"}'),
  });

  expect(created.scenario.body).toEqual({ value: 'captured' });
  const updated = await updateScenario(
    project.id,
    created.resource.id,
    created.scenario.id,
    {
      statusCode: 203,
      body: { value: 'edited' },
      responseHeaders: { 'content-type': 'application/json', 'x-source': 'editor' },
      fixture: null,
    },
  );
  expect(updated.scenarios[0].fixture).toBeUndefined();

  const response = await request(app).get(created.resource.path);
  expect(response.status).toBe(203);
  expect(response.body).toEqual({ value: 'edited' });
  expect(response.headers['x-source']).toBe('editor');
});
```

- [ ] **Step 2: Run the integration path and verify RED**

Run: `npm run test --workspace=packages/server -- --run src/routes/admin.test.ts src/app.test.ts src/services/matcher.test.ts`

Expected: FAIL because fixture content remains invisible in the editor model and always overrides inline edits.

- [ ] **Step 3: Materialize editable captured responses**

```ts
export function decodeEditableFixtureBody(
  headers: Record<string, string>,
  body: Buffer,
): unknown | string {
  const mediaType = headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
  const text = body.toString('utf8');
  if (mediaType === 'application/json' || mediaType?.endsWith('+json')) {
    return JSON.parse(text);
  }
  return text;
}
```

When Traffic creates a mock, parse fixture status, response headers, and JSON/text body into visible scenario fields. Store its source at `fixtures/resources/<resource-id>/<scenario-id>.http`. Keep the fixture reference until an explicit response edit sends `fixture: null`.

Make runtime precedence explicit: serve the fixture only while the reference exists; after it is cleared, serve edited body/status/response headers. Preserve textual media types without JSON-quoting the string. Return `400 CAPTURE_NOT_EDITABLE` for malformed declared JSON rather than displaying `{}`.

- [ ] **Step 4: Update the editor's detach behavior**

When a fixture-backed JSON/text scenario is first changed, include `fixture: null` in the update payload and show `Captured source will be replaced by this edit`. Do not detach on unrelated navigation or opening the editor.

Add this failing dashboard assertion before implementing detachment:

```tsx
it('detaches a captured fixture only after an explicit response edit', async () => {
  render(<ScenarioEditor projectId="p1" resource={fixtureBackedResource} onUpdate={vi.fn()} />);
  expect(scenariosApi.update).not.toHaveBeenCalled();
  await userEvent.clear(screen.getByLabelText('Response body'));
  await userEvent.type(screen.getByLabelText('Response body'), '{"edited":true}');
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(scenariosApi.update).toHaveBeenCalledWith(
    'p1',
    fixtureBackedResource.id,
    fixtureBackedResource.scenarios[0].id,
    expect.objectContaining({ fixture: null, body: { edited: true } }),
  );
});
```

- [ ] **Step 5: Verify the complete flow**

Run: `npm run test --workspace=packages/server -- --run src/routes/admin.test.ts src/app.test.ts src/services/matcher.test.ts`

Expected: PASS for captured JSON and text edits. Binary capture normalization remains explicitly deferred to Release 2 Body Assets.

Run: `npm run test --workspace=packages/dashboard -- --run src/components/ScenarioEditor.test.tsx`

Expected: PASS with fixture detachment sent only after an explicit edit.

- [ ] **Step 6: Commit editable captured mocks**

```bash
git add packages/server/src/routes/admin.ts packages/server/src/services/resources.ts packages/server/src/services/matcher.ts packages/server/src/services/fixtures.ts packages/server/src/routes/admin.test.ts packages/server/src/app.test.ts packages/server/src/services/matcher.test.ts packages/dashboard/src/components/ScenarioEditor.tsx packages/dashboard/src/components/ScenarioEditor.test.tsx packages/dashboard/src/api/types.ts
git commit -m "fix: make captured mocks editable"
```

---

### Task 10: Bound And Scope Traffic By Project

**Files:**
- Create: `packages/server/src/services/logger.test.ts`
- Modify: `packages/server/src/types.ts`
- Modify: `packages/server/src/services/logger.ts`
- Modify: `packages/server/src/routes/admin.ts`
- Modify: `packages/server/src/routes/automation.ts`
- Modify: `packages/server/src/routes/mock.ts`
- Modify: `packages/server/src/services/proxy-handler.ts`
- Modify: `packages/server/src/app.test.ts`
- Modify: `packages/server/src/routes/admin.test.ts`
- Modify: `packages/dashboard/src/api/types.ts`
- Modify: `packages/dashboard/src/api/client.ts`
- Modify: `packages/dashboard/src/hooks/useLogs.ts`
- Create: `packages/dashboard/src/hooks/useLogs.test.tsx`
- Modify: `packages/dashboard/src/App.tsx`
- Modify: `packages/dashboard/src/components/TrafficView.tsx`
- Create: `packages/dashboard/src/components/TrafficView.test.tsx`
- Modify: `packages/dashboard/src/components/LogsView.tsx`

**Interfaces:**
- Consumes: Task 9's editable mock flow, stable project IDs, and Task 3 structured errors.
- Produces: `NewRequestLogEntry`, `TrafficQuery`, `RequestLogSummary`, `TrafficPage`, project-scoped log APIs, and incremental dashboard polling.

- [ ] **Step 1: Add failing project-boundary and pagination tests**

```ts
it('does not expose entries or bodies across projects', () => {
  const a = addLogEntry({ projectId: 'p-a', method: 'GET', path: '/a', statusCode: 200, duration: 1, responseBody: 'secret-a' });
  addLogEntry({ projectId: 'p-b', method: 'GET', path: '/b', statusCode: 200, duration: 1 });

  const page = getLogEntries('p-b', { limit: 100 });
  expect(page.entries.map(entry => entry.id)).not.toContain(a.id);
  expect(JSON.stringify(page.entries)).not.toContain('secret-a');
  expect(getLogEntry('p-b', a.id)).toBeUndefined();
});

it('returns only entries newer than the supplied cursor', () => {
  const first = addLogEntry(baseEntry('p-a', '/1'));
  const second = addLogEntry(baseEntry('p-a', '/2'));
  expect(getLogEntries('p-a', { afterId: first.id }).entries.map(item => item.id)).toEqual([second.id]);
});

it('scopes list, detail, clear, and create-rule routes to one project', async () => {
  const foreign = addLogEntry(baseEntry('p-a', '/secret'));
  expect((await request(app).get('/api/admin/projects/p-b/logs')).body.entries).toEqual([]);
  expect((await request(app).get(`/api/admin/projects/p-b/logs/${foreign.id}`)).status).toBe(404);
  expect((await request(app).post(`/api/admin/projects/p-b/logs/${foreign.id}/create-rule`)).status).toBe(404);
  await request(app).delete('/api/admin/projects/p-b/logs').expect(204);
  expect(getLogEntry('p-a', foreign.id)).toBeDefined();
});

it('stores only bounded previews and resets an expired cursor', () => {
  const body = 'x'.repeat(TRAFFIC_PREVIEW_BYTES * 2);
  const entry = addLogEntry({ ...baseEntry('p-a', '/large'), responseBody: body });
  const detail = getLogEntry('p-a', entry.id)!;
  expect(detail.responsePreview).toHaveLength(TRAFFIC_PREVIEW_BYTES);
  expect(detail.responseTruncated).toBe(true);
  expect(detail).not.toHaveProperty('responseBody');
  expireFromRetention(entry.id);
  expect(getLogEntries('p-a', { afterId: entry.id })).toMatchObject({ reset: true });
});
```

- [ ] **Step 2: Run logger and traffic tests and verify RED**

Run: `npm run test --workspace=packages/server -- --run src/services/logger.test.ts src/routes/admin.test.ts src/app.test.ts`

Expected: FAIL because logs are global and list responses contain complete retained bodies.

- [ ] **Step 3: Replace positional logging with a project-scoped contract**

```ts
export interface NewRequestLogEntry extends Omit<RequestLogEntry, 'id' | 'timestamp'> {
  projectId: string;
  timestamp?: string;
}

export interface TrafficQuery {
  afterId?: string;
  beforeId?: string;
  limit?: number;
}

export interface RequestLogSummary {
  id: string;
  projectId: string;
  timestamp: string;
  method: HttpMethod;
  path: string;
  statusCode: number;
  duration: number;
  resourceId?: string;
  scenarioId?: string;
  proxied?: boolean;
  requestSize?: number;
  responseSize?: number;
  requestTruncated?: boolean;
  responseTruncated?: boolean;
}

export interface TrafficPage {
  entries: RequestLogSummary[];
  latestId?: string;
  hasMore: boolean;
  reset?: boolean;
}

export const TRAFFIC_PREVIEW_BYTES = 16 * 1024;

export function addLogEntry(entry: NewRequestLogEntry): RequestLogEntry;
export function getLogEntries(projectId: string, query?: TrafficQuery): TrafficPage;
export function getLogEntry(projectId: string, logId: string): RequestLogEntry | undefined;
export function clearLogEntries(projectId: string): void;
```

Retain insertion order in the bounded in-memory ring. Resolve cursors by finding their retained index; when `afterId` is unknown, return the current bounded page with `reset: true`. Project list projections must omit request/response bodies and fixture bytes. Detail may include only a constant-size preview and metadata.

Truncate at capture time, not during projection. Remove `requestBody` and `responseBody` from retained `RequestLogEntry`; retain only UTF-8-safe `requestPreview`/`responsePreview` values capped at `TRAFFIC_PREVIEW_BYTES`, truncation flags, sizes, and fixture/body references. Binary previews are base64 and count decoded bytes toward the same cap.

- [ ] **Step 4: Replace global routes with project routes**

```text
GET    /api/admin/projects/:projectId/logs?afterId=<id>&limit=100
GET    /api/admin/projects/:projectId/logs/:logId
DELETE /api/admin/projects/:projectId/logs
```

Require project membership for every lookup. Update mock, proxy, and automation callers to pass one object with `projectId`. Make Traffic -> Create Mock reject a log from another project with `404 TRAFFIC_ENTRY_NOT_FOUND`.

- [ ] **Step 5: Make dashboard traffic incremental and lazy**

`useLogs(projectId)` must clear entries/details/cursors when the project changes, fetch an initial limited page, poll with `afterId`, avoid overlapping requests with `AbortController`, merge only new IDs, and fetch detail only after selecting a row. Rename `Recording/Paused` to `Live updates/Updates paused` because server capture continues.

- [ ] **Step 6: Verify server and dashboard traffic behavior**

Run: `npm run test --workspace=packages/server -- --run src/services/logger.test.ts src/routes/admin.test.ts src/app.test.ts`

Expected: PASS.

Run: `npm run test --workspace=packages/dashboard -- --run src/hooks/useLogs.test.tsx src/components/TrafficView.test.tsx`

Expected: PASS with project resets, cursored polling, lazy detail, and no full bodies in list state.

- [ ] **Step 7: Commit bounded project traffic**

```bash
git add packages/server/src/services/logger.test.ts packages/server/src/types.ts packages/server/src/services/logger.ts packages/server/src/routes/admin.ts packages/server/src/routes/automation.ts packages/server/src/routes/mock.ts packages/server/src/services/proxy-handler.ts packages/server/src/app.test.ts packages/server/src/routes/admin.test.ts packages/dashboard/src/api/types.ts packages/dashboard/src/api/client.ts packages/dashboard/src/hooks/useLogs.ts packages/dashboard/src/hooks/useLogs.test.tsx packages/dashboard/src/App.tsx packages/dashboard/src/components/TrafficView.tsx packages/dashboard/src/components/TrafficView.test.tsx packages/dashboard/src/components/LogsView.tsx
git commit -m "fix: scope and bound traffic logs"
```

---

### Task 11: Run Release 1 Gates And Record The Boundary

**Files:**
- Create: `docs/superpowers/reviews/2026-08-27-mockmate-release-1-verification.md`

**Interfaces:**
- Consumes: all ten Release 1 task outputs.
- Produces: committed command evidence for a safety baseline ready for Release 2.

- [ ] **Step 1: Run the complete server suite**

Run: `npm run test --workspace=packages/server -- --run`

Expected: PASS with zero tests accessing real user data.

- [ ] **Step 2: Run the complete dashboard suite**

Run: `npm run test --workspace=packages/dashboard -- --run`

Expected: PASS.

- [ ] **Step 3: Run repository-wide tests**

Run: `npm test`

Expected: PASS for server, dashboard, and `tools/*.test.mjs`.

- [ ] **Step 4: Run lint and build**

Run: `npm run lint`

Expected: PASS with zero ESLint errors.

Run: `npm run build`

Expected: PASS for dashboard Vite build and server TypeScript build.

- [ ] **Step 5: Confirm Release 2 work did not leak into Release 1**

Run:

```bash
git grep -n "schemaVersion: 3\|BodyAsset\|activeStateId\|baseStateId\|CompiledProject" -- packages/server/src packages/dashboard/src
```

Expected: no production matches. Mentions in the approved spec and implementation plans are allowed.

- [ ] **Step 6: Record and commit Release 1 verification**

Create the review file with the tested commit SHA, date, exact commands above, pass/fail counts, the certificate test root used, and the Release 2 scope-grep output. Do not claim a gate passed unless its fresh output is recorded.

```bash
git add docs/superpowers/reviews/2026-08-27-mockmate-release-1-verification.md
git commit -m "docs: record safety baseline verification"
```

Release 1 is ready for Release 2 only after every command above passes and the certificate suite has been reviewed for path safety.
