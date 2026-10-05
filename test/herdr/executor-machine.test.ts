// A herdr-claude job on an attached machine drives that machine's herdr, and its pane state says
// which machine, so resume, reattach and cleanup reach the same pane (design.md "Attached machines").
import { describe, expect, it } from 'vitest';
import type { FakeTurn } from '../../src/executors/herdr/index.ts';
import { LAPTOP, contextFor, jobWith, setup } from './support.ts';

const STUDIO = { id: 'studio', label: 'studio', maxLanes: 1, online: true, executors: ['herdr-claude'], client: { tokenEnv: 'STUDIO_CLIENT_TOKEN' } };

const DONE: FakeTurn = { output: ['● Done on the laptop.', '  HOPPER_DONE'] };
const ASK: FakeTurn = { output: ['● Which branch?', '  HOPPER_QUESTION'] };

describe('herdr-claude executor on an attached machine', () => {
  it('runs the job through that machine\'s herdr; this machine\'s herdr sees nothing', async () => {
    const { herdr, remotes, reached, executor } = setup({}, { remote: { laptop: { turns: [DONE] } } });
    const { ctx, saved } = contextFor(jobWith({ prompt: 'go' }), 'laptop/lane-1', LAPTOP);
    const out = await executor.run(ctx);
    expect(out).toMatchObject({ kind: 'finished', result: { summary: 'Done on the laptop.' } });
    expect(herdr.calls).toEqual([]);
    expect(remotes.get('laptop')!.agentStarts).toHaveLength(1);
    // The scratch dir is made on that machine, where the work tree is.
    expect(remotes.get('laptop')!.calls.filter((c) => c.method === 'runInPane')).toHaveLength(1);
    // The machine's own herdr binary and session, by absolute path: never its PATH.
    expect(reached[0]).toEqual({ ssh: 'laptop', bin: '/home/user/.local/bin/herdr', session: 'jh-there' });
    expect(saved[0]).toMatchObject({ ssh: 'laptop', herdrBin: '/home/user/.local/bin/herdr', session: 'jh-there', paneId: 'w1:p1', laneId: 'laptop/lane-1' });
  });

  it('a container target has no herdr: the job fails there and nothing runs on this machine (issue #58)', async () => {
    const { herdr, executor } = setup({ turns: [DONE] });
    const box = { id: 'box', label: 'box', maxLanes: 1, online: true, executors: ['herdr-claude'], docker: 'target' };
    const { ctx } = contextFor(jobWith({ prompt: 'go' }), 'box/lane-1', box);
    expect(await executor.run(ctx)).toEqual({ kind: 'failed', error: 'herdr-claude does not run on container target box: it has no herdr; give it the command executor' });
    expect(herdr.calls).toEqual([]);
  });

  it('an ssh target that runs no herdr: the job fails there and nothing runs on this machine (issue #142)', async () => {
    const { herdr, executor } = setup({ turns: [DONE] });
    const wsl = { id: 'wsl', label: 'wsl', maxLanes: 1, online: true, executors: ['herdr-claude'], ssh: 'wsl' };
    const { ctx } = contextFor(jobWith({ prompt: 'go' }), 'wsl/lane-1', wsl);
    expect(await executor.run(ctx)).toEqual({ kind: 'failed', error: 'herdr-claude does not run on wsl: it runs no herdr; give it another executor' });
    expect(herdr.calls).toEqual([]);
  });

  it('on a client target: that client\'s herdr, reached through its tunnel with its token; the pane state says so (issue #59)', async () => {
    const { herdr, remotes, reached, executor } = setup({}, { remote: { studio: { turns: [ASK, DONE] } } });
    const first = contextFor(jobWith({ prompt: 'go' }), 'studio/lane-1', STUDIO);
    expect((await executor.run(first.ctx)).kind).toBe('question');
    expect(first.saved[0]).toMatchObject({ client: { machine: 'studio', tokenEnv: 'STUDIO_CLIENT_TOKEN' }, paneId: 'w1:p1' });
    expect(first.saved[0]).not.toHaveProperty('ssh');
    const job = jobWith({ prompt: 'go' }, { executorState: first.saved.at(-1) });
    expect((await executor.resume!(contextFor(job, 'studio/lane-1', STUDIO).ctx, 'main')).kind).toBe('finished');
    await executor.cleanup!(job);
    expect(remotes.get('studio')!.calls.some((c) => c.method === 'closePane')).toBe(true);
    expect(herdr.calls).toEqual([]);
    expect(new Set(reached.map((r) => JSON.stringify(r)))).toEqual(new Set([JSON.stringify({ client: { machine: 'studio', tokenEnv: 'STUDIO_CLIENT_TOKEN' } })]));
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
