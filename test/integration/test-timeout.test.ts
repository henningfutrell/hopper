import { describe, expect, it } from 'vitest';

// Integration tests boot a hopper and start jobs: on a loaded CI runner one took past the 15 s default while the code
// it tests did not change. Each gets 45 s (issue #2948).
describe('the timeout of an integration test (issue #2948)', () => {
  it('a test under test/integration/ that names no timeout gets 45 s', ({ task }) => {
    expect(task.timeout).toBe(45_000);
  });

  it('a test that names its own timeout keeps it', { timeout: 20_000 }, ({ task }) => {
    expect(task.timeout).toBe(20_000);
  });
});
