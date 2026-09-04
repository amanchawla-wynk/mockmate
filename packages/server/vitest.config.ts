import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./src/vitest.setup.ts'],
    exclude: [
      'node_modules/**',
      'dist/**',
      'src/integration/**',
      'src/performance/**',
    ],
    pool: 'forks',
    fileParallelism: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
  },
});
