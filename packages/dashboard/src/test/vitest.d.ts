import type matchers from '@testing-library/jest-dom/matchers';

declare module 'vitest' {
  interface Assertion<T = unknown> extends matchers.TestingLibraryMatchers<unknown, T> {
    readonly __testingLibraryMatchers?: never;
  }

  interface AsymmetricMatchersContaining extends matchers.TestingLibraryMatchers<unknown, unknown> {
    readonly __testingLibraryMatchers?: never;
  }
}
