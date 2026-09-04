import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {
  CLEANUP_OWNER_CLOSE_FILE,
  finalizeCleanup,
  readOwnerCloseReport,
  validateOwnerCloseReport,
  writeCleanupManifest,
} = require(path.join(
  workspaceRoot,
  'packages/server/dist/test-support/cleanup-report.js',
));

function checkedRoot(root) {
  const absolute = path.resolve(root);
  const relative = path.relative(path.resolve(os.tmpdir()), absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)
    || !/^mockmate-e2e-/.test(path.basename(absolute))) {
    throw new Error('Refusing unsafe Chromium cleanup root');
  }
  return absolute;
}

function sanitize(value, root) {
  return JSON.parse(JSON.stringify(value, (_key, item) => (
    typeof item === 'string'
      ? item.replaceAll(root, '<MOCKMATE_E2E_ROOT>').replaceAll(os.homedir(), '<HOME>')
      : item
  )));
}

async function verifyArtifactOwnership(root, report) {
  const artifactRoots = report.manifest.roots.filter(({ owner }) => (
    owner === 'playwright-output' || owner === 'playwright-traces'
  ));
  if (artifactRoots.length !== 2) throw new Error('Playwright artifact roots are incomplete');
  const checked = checkedRoot(root);
  for (const artifact of artifactRoots) {
    const absolute = path.resolve(checked, artifact.relativePath);
    const relative = path.relative(checked, absolute);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Playwright artifact root escaped containment: ${artifact.owner}`);
    }
    if (!fs.existsSync(absolute)) continue;
    const pending = [absolute];
    while (pending.length > 0) {
      const current = pending.pop();
      const stat = await fs.promises.lstat(current);
      if (stat.isSymbolicLink()) throw new Error(`Playwright artifact is a symlink: ${artifact.owner}`);
      if (!stat.isDirectory()) continue;
      for (const entry of await fs.promises.readdir(current)) pending.push(path.join(current, entry));
    }
  }
}

async function spawnPlaywright(root) {
  const cli = require.resolve('@playwright/test/cli');
  const child = spawn(process.execPath, [
    cli,
    'test',
    '--config',
    path.join(workspaceRoot, 'playwright.config.ts'),
    ...process.argv.slice(2),
  ], {
    cwd: workspaceRoot,
    env: { ...process.env, MOCKMATE_E2E_ROOT: root },
    stdio: 'inherit',
  });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code: code ?? 1, signal }));
  });
}

const root = checkedRoot(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mockmate-e2e-')));
const initialManifest = {
  listeners: [],
  socketOwners: [],
  roots: [
    {
      owner: 'playwright-output',
      relativePath: 'playwright-output',
      afterOwnerClose: 'contained-until-parent-removal',
    },
    {
      owner: 'playwright-traces',
      relativePath: 'playwright-output',
      afterOwnerClose: 'contained-until-parent-removal',
    },
  ],
};

let playwrightResult = { code: 1, signal: null };
let playwrightError;
let cleanupReport;
let cleanupError;

try {
  await writeCleanupManifest(root, initialManifest);
  try {
    playwrightResult = await spawnPlaywright(root);
  } catch (error) {
    playwrightError = error;
  }

  try {
    const ownerReport = await readOwnerCloseReport(root);
    await validateOwnerCloseReport(root, ownerReport);
    await verifyArtifactOwnership(root, ownerReport);
    cleanupReport = await finalizeCleanup(root, ownerReport);
  } catch (error) {
    cleanupError = error;
    await fs.promises.rm(checkedRoot(root), { recursive: true, force: true });
    if (fs.existsSync(root)) throw new Error('Fallback cleanup left the E2E root behind');
  }
} finally {
  if (fs.existsSync(root)) {
    await fs.promises.rm(checkedRoot(root), { recursive: true, force: true });
  }
  const playwrightFailed = playwrightError !== undefined || playwrightResult.code !== 0;
  const finalExitStatus = playwrightFailed ? (playwrightResult.code || 1) : cleanupError ? 1 : 0;
  const evidence = {
    ownerCloseArtifact: CLEANUP_OWNER_CLOSE_FILE,
    playwright: playwrightError
      ? { exitStatus: 1, error: String(playwrightError) }
      : { exitStatus: playwrightResult.code, signal: playwrightResult.signal },
    cleanup: cleanupReport ?? {
      parentRemoved: !fs.existsSync(root),
      error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
    },
    finalExitStatus,
  };
  console.info(`MOCKMATE_E2E_CLEANUP ${JSON.stringify(sanitize(evidence, root))}`);
  process.exitCode = finalExitStatus;
}
