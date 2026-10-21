import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // The PNG round-trip tests encode large frames; 5s is too tight when the
    // suite runs in parallel on CI runners (seen as a flaky timeout).
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
