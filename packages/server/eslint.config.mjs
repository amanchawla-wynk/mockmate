import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { defineConfig, globalIgnores } from 'eslint/config';

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['src/**/*.ts'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
    ],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.node,
    },
  },
  {
    files: [
      'src/app.ts',
      'src/routes/admin.test.ts',
      'src/routes/admin.ts',
      'src/routes/automation.ts',
      'src/services/certs/generator.test.ts',
      'src/services/certs/test-certs.ts',
      'src/services/matcher.test.ts',
      'src/services/matcher.ts',
      'src/services/projects.ts',
      'src/services/proxy-server.ts',
      'src/services/resources.test.ts',
      'src/services/storage.ts',
      'src/test-https.ts',
      'src/types.ts',
      'src/utils/curl-parser.ts',
      'src/utils/postman-parser.ts',
    ],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    files: [
      'src/routes/admin.ts',
      'src/services/projects.ts',
    ],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    files: [
      'src/app.test.ts',
      'src/index.ts',
      'src/routes/admin.test.ts',
      'src/routes/admin.ts',
      'src/routes/mock.ts',
      'src/routes/setup-page.ts',
      'src/services/api-errors.ts',
      'src/services/certs/generator.ts',
      'src/services/matcher.test.ts',
      'src/services/matcher.ts',
      'src/services/projects.test.ts',
      'src/services/projects.ts',
      'src/services/resources.test.ts',
      'src/services/storage.test.ts',
      'src/services/storage.ts',
      'src/utils/postman-parser.ts',
    ],
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
  {
    files: ['src/services/fixtures.ts'],
    rules: {
      'no-control-regex': 'off',
    },
  },
  {
    files: ['src/routes/admin.ts'],
    rules: {
      'no-useless-catch': 'off',
    },
  },
  {
    files: [
      'src/services/matcher.ts',
      'src/utils/postman-parser.ts',
    ],
    rules: {
      'no-useless-escape': 'off',
    },
  },
]);
