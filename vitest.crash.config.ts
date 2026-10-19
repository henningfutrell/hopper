// The crash harness (issue #1954, docs/design.md "The crash harness"): hoppers as processes of their own, killed at kill
// points or cut off from the database mid-statement. Each file runs for minutes, so `npm test` leaves them out; `npm run
// test:crash` runs them, and the crash workflow runs them nightly (with more seeds for the randomised runs) and on a pull
// request that changes the sagas, the outbox, the item lifecycle or landing batches.
import { defineConfig } from 'vitest/config';
import { containerRuntime, testExclude } from './test/support/host-services.ts';

export default defineConfig({
  test: {
    include: ['test/crash/**/*.test.ts'],
    exclude: testExclude(process.env, { runtime: containerRuntime(process.env), say: (line) => console.warn(line) }),
    testTimeout: 15000,
    pool: 'forks',
    globalSetup: ['test/support/run.ts', 'test/support/postgres.ts'],
    setupFiles: ['test/support/isolate.ts'],
  },
});
