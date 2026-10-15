// The job's sandbox (issue #1295): set up in the pane's shell after the job's container runtime and before Claude starts,
// so herdr's start of claude runs the sandbox's claude, and Claude and all it runs see only the job's runtime. A machine
// where bubblewrap cannot run starts Claude as before, and says so; a setup that failed fails the job before Claude starts.
import { describe, expect, it } from 'vitest';
import { contextFor, jobWith, JOB_ID, setup } from './support.ts';

const DONE = { output: ['Done.', 'HOPPER_DONE'] };

describe('herdr-claude executor: the job\'s sandbox (issue #1295)', () => {
  it('is set up after the container runtime and before Claude, in the job\'s scratch dir', async () => {
    const { herdr, executor } = setup({ turns: [DONE], scopes: true, runtime: 'own', sandbox: 'on' });
    const { ctx, progress } = contextFor(jobWith({ prompt: 'go' }));
    expect(await executor.run(ctx)).toMatchObject({ kind: 'finished' });
    const order = herdr.calls.map((c) => (c.method === 'runInPane' ? String(c.args[1]) : c.method));
    const runtime = order.findIndex((m) => m.includes(' hopper-runtime '));
    const sandbox = order.findIndex((m) => m.includes(' hopper-sandbox '));
    expect(sandbox).toBeGreaterThan(runtime);
    expect(order.indexOf('startAgent')).toBeGreaterThan(sandbox);
    expect(order[sandbox]).toContain(`/.worktrees/@scratch/${JOB_ID}'`);
    expect(progress.some((p) => p.message?.includes('sandbox: Claude runs in a sandbox'))).toBe(true);
  });

  it('a machine where bubblewrap cannot run: Claude starts as before, and the job is told', async () => {
    const { herdr, executor } = setup({ turns: [DONE] });
    const { ctx, progress } = contextFor(jobWith({ prompt: 'go' }));
    expect(await executor.run(ctx)).toMatchObject({ kind: 'finished' });
    expect(herdr.agentStarts).toHaveLength(1);
    expect(progress.some((p) => p.message?.includes('sandbox: none here'))).toBe(true);
  });

  it('a setup that failed fails the job before Claude starts', async () => {
    const { herdr, executor } = setup({ turns: [DONE], sandbox: 'failed' });
    const out = await executor.run(contextFor(jobWith({ prompt: 'go' })).ctx);
    expect(out).toMatchObject({ kind: 'failed', error: expect.stringMatching(/^the job's sandbox could not be set up on /) });
    expect(herdr.agentStarts).toEqual([]);
  });
});
