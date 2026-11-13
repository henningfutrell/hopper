// Vitest setup, run before each test file: a test under test/integration/ gets 45 s, not the 15 s default of
// vitest.config.ts (issue #2948). Those tests boot a hopper, join machines and start jobs: on a loaded CI runner
// one took past 15 s while the code it tests did not change. A test, a describe or a file that names its own
// timeout keeps it. CI asserts behavior and ordering, not speed.
import { expect, vi } from 'vitest';

const INTEGRATION_TEST_TIMEOUT_MS = 45_000;

if (expect.getState().testPath?.replaceAll('\\', '/').includes('/test/integration/')) vi.setConfig({ testTimeout: INTEGRATION_TEST_TIMEOUT_MS });
