import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 15000,
    pool: 'forks',
    // Isolated HOME and loopback-only fetch in every worker: test/support/isolate.ts.
    setupFiles: ['test/support/isolate.ts'],
  },
});
