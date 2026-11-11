import { defineConfig } from 'vitest/config';

/**
 * Coverage is a ratchet, not a target: the floors below are the numbers this
 * suite already holds, so a refactor that deletes tests fails CI instead of
 * quietly shrinking the safety net. Raise them when coverage improves.
 *
 * Much of @vaporzr/core is network resolvers (YouTube, Spotify, Audius, …) that
 * need live credentials; the pure DSP, limits and parsing code is covered
 * closely, so the global number stays in the low forties.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary'],
      // Measured 2026-11-11: 41.28 / 33.62 / 40.13 / 43.90.
      thresholds: { statements: 40, branches: 32, functions: 39, lines: 42 },
    },
  },
});
