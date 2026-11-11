import { defineConfig } from 'vitest/config';

/**
 * Coverage is a ratchet, not a target: the floors below are the numbers this
 * suite already holds, so a refactor that deletes tests fails CI instead of
 * quietly shrinking the safety net. Raise them when coverage improves.
 *
 * The bot's ceiling is low on purpose. discord.ts, voice.ts, server.ts and
 * decks.ts are orchestration around Discord voice and HTTP, exercised in
 * production rather than unit tests; everything pure is covered closely.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // The PNG round-trip tests encode large frames; 5s is too tight when the
    // suite runs in parallel on CI runners (seen as a flaky timeout).
    testTimeout: 15000,
    hookTimeout: 15000,
    coverage: {
      provider: 'v8',
      reporter: ['text-summary'],
      // Measured 2026-11-11: 16.27 / 10.10 / 22.15 / 16.82.
      thresholds: { statements: 15, branches: 9, functions: 21, lines: 15 },
    },
  },
});
