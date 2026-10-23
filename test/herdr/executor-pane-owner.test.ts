// Issue #2676: a job's end closed the pane its executor state named, and on a lane whose herdr started again that id named
// the next job's pane: the next job's Claude got ctrl+c and its pane closed (exit code 143). The end acts on a pane only
// while it is the job's own: its agent runs in it, or its tab's label names the job (the pane key, issue #1569).
import { describe, expect, it } from 'vitest';
import type { Job } from '../../src/domain/types.ts';
import { contextFor, jobWith, setup } from './support.ts';

const ASK = { output: ['● Which language?', '  HOPPER_QUESTION'] };
const NEXT_ID = '99999999-3456-7890-abcd-ef1234567890';

/** Job A ran on the lane and left; job B runs on it now, in the pane whose id A's executor state names (a herdr started again). */
async function laneTakenOver() {
  const s = setup({ turns: [ASK, ASK] });
  const a = contextFor(jobWith({ prompt: 'Write a greeting' }));
  expect((await s.executor.run(a.ctx)).kind).toBe('question');
  const own = a.saved.at(-1) as { paneId: string };
  const b = contextFor(jobWith({ prompt: 'Write a poem' }, { id: NEXT_ID }));
  expect((await s.executor.run(b.ctx)).kind).toBe('question');
  const next = b.saved.at(-1) as { paneId: string };
  const stale = (status: Job['status'], extra: Partial<Job> = {}): Job => jobWith({ prompt: 'Write a greeting' }, { executorState: { ...own, paneId: next.paneId }, status, ...extra });
  return { ...s, own, next, stale };
}

describe('herdr-claude executor: a pane its job no longer holds (issue #2676)', () => {
  it('a cleanup reaps the job but sends no key to, and does not close, the pane another job holds now', async () => {
    const { herdr, executor, next, stale } = await laneTakenOver();
    const keys = herdr.keys.length;
    await executor.cleanup!(stale('cancelled'));
    expect(herdr.reaps.at(-1)?.jobId).toBe(jobWith({}).id);
    expect(herdr.keys.slice(keys).filter((k) => k.paneId === next.paneId)).toEqual([]);
    expect(herdr.closed).not.toContain(next.paneId);
    expect(await herdr.getAgent(`jh-${NEXT_ID.slice(0, 8)}`)).toMatchObject({ paneId: next.paneId });
  });

  it('a park leaves the pane another job holds now as it is', async () => {
    const { herdr, executor, next, stale } = await laneTakenOver();
    await executor.park!(stale('running'));
    expect(herdr.closed).not.toContain(next.paneId);
    expect(await herdr.getAgent(`jh-${NEXT_ID.slice(0, 8)}`)).toMatchObject({ paneId: next.paneId });
  });

  it('a cleanup still closes the job\'s own pane, found by its tab\'s label once its agent is gone', async () => {
    const { herdr, executor, own } = await laneTakenOver();
    herdr.killAgent(`jh-${jobWith({}).id.slice(0, 8)}`);
    const job = jobWith({ prompt: 'Write a greeting' }, { executorState: own, status: 'cancelled' });
    await executor.cleanup!(job);
    expect(herdr.closed).toContain(own.paneId);
  });
});
