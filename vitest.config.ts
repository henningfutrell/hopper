import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The UI's own alias, so happy-dom tests can render ui/src (test/ui/questions.test.ts).
  resolve: { alias: { '@': fileURLToPath(new URL('./ui/src', import.meta.url)) } },
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 15000,
    pool: 'forks',
    // Isolated HOME and loopback-only fetch in every worker: test/support/isolate.ts.
    setupFiles: ['test/support/isolate.ts'],
  },
});
