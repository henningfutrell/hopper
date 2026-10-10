// A herdr-claude job that times out (issue #630): what it showed of its progress — when its pane output last changed,
// whether it pushed work — is its liveness, and its scratch dir is kept, as a park keeps it: it may go on there.
import { describe, expect, it } from 'vitest';
import { CWD, JOB_ID, contextFor, jobWith, setup } from './support.ts';

const SCRATCH = `${CWD}/.hopper-scratch/${JOB_ID}`;

describe('herdr-claude executor: a timeout', () => {
  it('a timeout records its liveness (issue #630): when its pane output last changed, whether it pushed work; its scratch dir is kept, as a park keeps it', async () => {
    const { herdr, clock, executor } = setup({ turns: [{ steps: ['● Reading files', '● Writing code'], output: [], end: 'working' }], reapPushes: [`${SCRATCH}/repo`] });
    const started = clock.now().getTime();
    const out = await executor.run(contextFor(jobWith({ prompt: 'go', timeoutMs: 60000 })).ctx);
    expect(out).toMatchObject({ kind: 'failed', error: 'timed out', liveness: { pushed: true } });
    const outputAt = out.kind === 'failed' ? Date.parse(out.liveness?.outputAt ?? '') : NaN;
    expect(outputAt).toBeGreaterThan(started);
    expect(outputAt).toBeLessThan(clock.now().getTime());
    expect(herdr.reaps).toEqual([{ jobId: JOB_ID, scratch: SCRATCH, keep: true }]);
  });

  it('a silent timeout: no output in its turn, nothing pushed', async () => {
    const { herdr, executor } = setup({ turns: [{ output: [], end: 'working' }] });
    const out = await executor.run(contextFor(jobWith({ prompt: 'go', timeoutMs: 5000 })).ctx);
    expect(out).toEqual({ kind: 'failed', error: 'timed out', liveness: { pushed: false } });
    expect(herdr.reaps).toEqual([{ jobId: JOB_ID, scratch: SCRATCH, keep: true }]);
  });

  it('cleanup after a timeout keeps the scratch dir too', async () => {
    const { herdr, executor } = setup({ turns: [{ output: [], end: 'working' }] });
    const { ctx, saved } = contextFor(jobWith({ prompt: 'go', timeoutMs: 5000 }));
    const out = await executor.run(ctx);
    await executor.cleanup!({ ...ctx.job, status: 'failed', executorState: saved.at(-1), ...(out.kind === 'failed' && out.liveness ? { liveness: out.liveness } : {}) });
    expect(herdr.reaps).toHaveLength(2);
    expect(herdr.reaps.every((r) => r.keep === true)).toBe(true);
  });
});
