import { expect, it } from 'vitest';

// Only integration tests get the longer timeout (issue #2948): a test outside test/integration/ keeps 15 s.
it('a test outside test/integration/ keeps the 15 s default', ({ task }) => {
  expect(task.timeout).toBe(15_000);
});
