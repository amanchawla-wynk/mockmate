import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./src/vitest.setup.ts'],
    include: ['src/performance/**/*.performance.test.ts'],
    exclude: ['node_modules/**', 'dist/**'],
    fileParallelism: false,
    testTimeout: 120_000,
  },
});
