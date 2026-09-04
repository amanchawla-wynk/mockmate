import * as os from 'node:os';
import * as path from 'node:path';

import { defineConfig, devices } from '@playwright/test';

function e2eRoot(): string {
  const configured = process.env.MOCKMATE_E2E_ROOT;
  if (!configured || !path.isAbsolute(configured)) {
    throw new Error('MOCKMATE_E2E_ROOT must be an absolute launcher-owned path');
  }
  const root = path.resolve(configured);
  const relative = path.relative(path.resolve(os.tmpdir()), root);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)
    || !/^mockmate-e2e-/.test(path.basename(root))) {
    throw new Error('MOCKMATE_E2E_ROOT is outside the contained E2E temporary root');
  }
  return root;
}

const root = e2eRoot();

export default defineConfig({
  testDir: './e2e',
  outputDir: path.join(root, 'playwright-output'),
  fullyParallel: false,
  workers: 1,
  retries: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [['line']],
  use: {
    trace: 'on-first-retry',
  },
  projects: [{
    name: 'chromium-desktop',
    use: { ...devices['Desktop Chrome'] },
  }],
});
