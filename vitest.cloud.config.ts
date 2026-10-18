// The cloud acceptance tests (issue #1956, test/cloud-acceptance/README.md): a mock AWS (moto) behind the policy-assert
// proxy, the real `aws` CLI in a container, and the hopper's real composition root. They start containers of their own
// and take minutes, so `npm test` leaves them out; `npm run test:cloud` runs them, and the cloud-acceptance workflow
// runs them nightly and on a pull request that changes the vault, the sandbox module or the infra plans.
import { defineConfig } from 'vitest/config';
import { containerRuntime } from './test/support/host-services.ts';

containerRuntime(process.env);

export default defineConfig({
  test: {
    include: ['test/cloud-acceptance/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 180_000,
    pool: 'forks',
    fileParallelism: false,
    globalSetup: ['test/support/run.ts', 'test/support/postgres.ts'],
    setupFiles: ['test/support/isolate.ts'],
  },
});
