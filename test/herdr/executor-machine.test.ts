// A herdr-claude job on an attached machine drives that machine's herdr, and its pane state says
// which machine, so resume, reattach and cleanup reach the same pane (design.md "Attached machines").
import { describe, expect, it } from 'vitest';
import type { FakeTurn } from '../../src/executors/herdr/index.ts';
import { LAPTOP, contextFor, jobWith, setup } from './support.ts';

const DONE: FakeTurn = { output: ['● Done on the laptop.', '  JOB_HOPPER_DONE'] };
const ASK: FakeTurn = { output: ['● Which branch?', '  JOB_HOPPER_QUESTION'] };

describe('herdr-claude executor on an attached machine', () => {
  it('runs the job through that machine\'s herdr; this machine\'s herdr sees nothing', async () => {
    const { herdr, remotes, reached, executor } = setup({}, { remote: { laptop: { turns: [DONE] } } });
    const { ctx, saved } = contextFor(jobWith({ prompt: 'go' }), 'laptop/lane-1', LAPTOP);
    const out = await executor.run(ctx);
    expect(out).toMatchObject({ kind: 'finished', result: { summary: 'Done on the laptop.' } });
    expect(herdr.calls).toEqual([]);
    expect(remotes.get('laptop')!.agentStarts).toHaveLength(1);
    // The machine's own herdr binary and session, by absolute path: never its PATH.
    expect(reached[0]).toEqual({ ssh: 'laptop', bin: '/home/user/.local/bin/herdr', session: 'jh-there' });
    expect(saved[0]).toMatchObject({ ssh: 'laptop', herdrBin: '/home/user/.local/bin/herdr', session: 'jh-there', paneId: 'w1:p1', laneId: 'laptop/lane-1' });
  });

  it('a job on this machine records no ssh target', async () => {
    const { executor } = setup({ turns: [DONE] });
    const { ctx, saved } = contextFor(jobWith({ prompt: 'go' }));
    await executor.run(ctx);
    expect(saved[0]).not.toHaveProperty('ssh');
  });

  it('resume, cleanup and reattach of an attached-machine job go to that machine', async () => {
    const { herdr, remotes, reached, executor } = setup({}, { remote: { laptop: { turns: [ASK, DONE] } } });
    const first = contextFor(jobWith({ prompt: 'go' }), 'laptop/lane-1', LAPTOP);
    expect((await executor.run(first.ctx)).kind).toBe('question');
    const job = jobWith({ prompt: 'go' }, { executorState: first.saved.at(-1) });
    expect(await executor.canReattach!(job)).toBe(true);
    const out = await executor.resume!(contextFor(job, 'laptop/lane-2', LAPTOP).ctx, 'main');
    expect(out.kind).toBe('finished');
    await executor.cleanup!(job);
    const laptop = remotes.get('laptop')!;
    expect(laptop.prompts.map((p) => p.text).at(-1)).toBe('main');
    expect(laptop.calls.some((c) => c.method === 'closePane')).toBe(true);
    expect(herdr.calls).toEqual([]);
    // cleanup has only the job: its saved state names the same machine, binary and session.
    expect(new Set(reached.map((r) => JSON.stringify(r)))).toEqual(new Set([JSON.stringify({ ssh: 'laptop', bin: '/home/user/.local/bin/herdr', session: 'jh-there' })]));
  });

  it('the same pane id on two machines is two panes: neither lane is refused', async () => {
    const { executor } = setup({ turns: [ASK] }, { remote: { laptop: { turns: [ASK] } } });
    const here = await executor.run(contextFor(jobWith({ prompt: 'go' }), 'local/lane-1').ctx);
    const there = await executor.run(contextFor(jobWith({ prompt: 'go' }, { id: 'ffffffff-0000-0000-0000-000000000000' }), 'laptop/lane-1', LAPTOP).ctx);
    expect([here.kind, there.kind]).toEqual(['question', 'question']);
  });
});
