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

export async function createTestStorageDirectory(prefix: string): Promise<string> {
  if (!/^[a-zA-Z0-9_-]+$/.test(prefix)) {
    throw new Error('Test storage prefix must be a simple path segment');
  }
  await fs.promises.mkdir(testRoot, { recursive: true });
  const directory = await fs.promises.mkdtemp(path.join(testRoot, prefix));
  assertSafeTestPath(directory);
  return directory;
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
