// Issue #371: cleanup says when it could not reach the pane, so the engine can defer it and try again.
import { describe, expect, it } from 'vitest';
import { contextFor, jobWith, setup } from './support.ts';

const ASK = { output: ['● Which language?', '  HOPPER_QUESTION'] };

async function onQuestion() {
  const s = setup({ turns: [ASK] });
  const first = contextFor(jobWith({ prompt: 'Write a greeting' }));
  expect((await s.executor.run(first.ctx)).kind).toBe('question');
  return { ...s, job: jobWith({ prompt: 'Write a greeting' }, { executorState: first.saved.at(-1), status: 'failed' }) };
}

describe('herdr-claude executor: cleanup', () => {
  it('rejects while the pane\'s herdr cannot be reached, and leaves the pane open', async () => {
    const { herdr, executor, job } = await onQuestion();
    herdr.setUnreachable(true);
    await expect(executor.cleanup!(job)).rejects.toThrow(/pane w1:p1 may still be open: herdr: client is not dialled in/);
    expect(herdr.closed).toEqual([]);
  });

  it('closes the pane once it is reached again', async () => {
    const { herdr, executor, job } = await onQuestion();
    herdr.setUnreachable(true);
    await expect(executor.cleanup!(job)).rejects.toThrow();
    herdr.setUnreachable(false);
    await executor.cleanup!(job);
    expect(herdr.closed).toEqual(['w1:p1']);
  });

  it('resolves for a pane already gone: closed by hand, or by an earlier cleanup', async () => {
    const { herdr, executor, job } = await onQuestion();
    await executor.cleanup!(job);
    // The reap runs on the machine again (issue #410) and finds nothing left: no pane to close twice.
    await expect(executor.cleanup!(job)).resolves.toEqual({ kept: [] });
    expect(herdr.closed).toEqual(['w1:p1']);
  });

  it('rejects when herdr refuses the close for another reason', async () => {
    const { herdr, executor, job } = await onQuestion();
    herdr.failNext('closePane', 'timeout');
    await expect(executor.cleanup!(job)).rejects.toThrow(/closePane failed: timeout/);
  });

  it('resolves for a job that never opened a pane', async () => {
    const { executor } = await onQuestion();
    await expect(executor.cleanup!(jobWith({ prompt: 'x' }, { status: 'failed' }))).resolves.toBeUndefined();
  });
});
