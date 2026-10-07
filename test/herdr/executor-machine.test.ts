// A herdr-claude job on an attached machine drives that machine's herdr, and its pane state says
// which machine, so resume, reattach and cleanup reach the same pane (design.md "Attached machines").
import { describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import type { FakeTurn } from '../../src/executors/herdr/index.ts';
import { LAPTOP, contextFor, jobWith, setup } from './support.ts';

const STUDIO = { id: 'studio', label: 'studio', maxLanes: 1, online: true, executors: ['herdr-claude'], client: { tokenEnv: 'STUDIO_CLIENT_TOKEN' } };

const DONE: FakeTurn = { output: ['● Done on the laptop.', '  HOPPER_DONE'] };
const ASK: FakeTurn = { output: ['● Which branch?', '  HOPPER_QUESTION'] };

// Issue #260: this machine added with a herdr session of its own runs its jobs in that session.
describe('herdr-claude executor on this machine with its own herdr session', () => {
  const HERE = { id: 'workstation', label: 'workstation', maxLanes: 2, online: true, executors: ['herdr-claude'], herdr: { bin: 'herdr', session: 'jobs' } };

  it('runs the job in that session of this machine\'s herdr; the executor\'s own session and every attached machine see nothing', async () => {
    const { herdr, locals, reached, executor } = setup({}, { local: { jobs: { turns: [DONE] } } });
    const { ctx, saved } = contextFor(jobWith({ prompt: 'go' }), 'workstation/lane-1', HERE);
    expect(await executor.run(ctx)).toMatchObject({ kind: 'finished' });
    expect(herdr.calls).toEqual([]);
    expect(reached).toEqual([]);
    expect(locals.get('jobs')!.agentStarts).toHaveLength(1);
    expect(saved[0]).toMatchObject({ session: 'jobs', paneId: 'w1:p1', laneId: 'workstation/lane-1' });
    expect(saved[0]).not.toHaveProperty('ssh');
  });

  it('this machine naming the executor\'s own session uses the executor\'s herdr', async () => {
    const { herdr, locals, executor } = setup({ turns: [DONE] }, { local: { jobs: {} } });
    const { ctx } = contextFor(jobWith({ prompt: 'go' }), 'workstation/lane-1', { ...HERE, herdr: { bin: 'herdr', session: 'jh-test' } });
    expect(await executor.run(ctx)).toMatchObject({ kind: 'finished' });
    expect(herdr.agentStarts).toHaveLength(1);
    expect(locals.get('jobs')!.calls).toEqual([]);
  });
});

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

// Issue #323: a hopper in a container runs jobs on an attached machine, where its own home means nothing.
describe('herdr-claude executor: ~ in a work tree resolves on the lane\'s machine', () => {
  const FAR = { ...LAPTOP, home: '/home/far' };

  it.each([
    ['the default work tree ~', undefined, '/home/far'],
    ['a payload work tree under ~', '~/jobs', '/home/far/jobs'],
  ])('%s: against the attached machine\'s home, never this process\'s', async (_name, cwd, expected) => {
    const { remotes, executor } = setup({}, { defaultCwd: '~', remote: { laptop: { turns: [DONE] } } });
    const { ctx, workTrees } = contextFor(jobWith({ prompt: 'go', ...(cwd ? { cwd } : {}) }), 'laptop/lane-1', FAR);
    expect(await executor.run(ctx)).toMatchObject({ kind: 'finished' });
    expect(remotes.get('laptop')!.calls.find((c) => c.method === 'createTab')!.args[0]).toMatchObject({ cwd: expected, env: { TMPDIR: `${expected}/.hopper-scratch` } });
    expect(workTrees).toEqual([expected]);
  });

  it('a client target: against the home its client reported', async () => {
    const { remotes, executor } = setup({}, { defaultCwd: '~/hopper-jobs', remote: { studio: { turns: [DONE] } } });
    expect(await executor.run(contextFor(jobWith({ prompt: 'go' }), 'studio/lane-1', { ...STUDIO, home: '/Users/far' }).ctx)).toMatchObject({ kind: 'finished' });
    expect(remotes.get('studio')!.calls.find((c) => c.method === 'createTab')!.args[0]).toMatchObject({ cwd: '/Users/far/hopper-jobs' });
  });

  it('an attached machine whose home is not known yet: the job fails at once and no tab opens there', async () => {
    const { remotes, executor } = setup({}, { defaultCwd: '~', remote: { laptop: { turns: [DONE] } } });
    expect(await executor.run(contextFor(jobWith({ prompt: 'go' }), 'laptop/lane-1', LAPTOP).ctx)).toEqual({
      kind: 'failed', error: 'cannot resolve the work tree ~ on laptop: its home is not known yet (the machine has not answered a probe)',
    });
    expect(remotes.get('laptop')!.calls).toEqual([]);
  });

  it('an absolute work tree needs no home', async () => {
    const { remotes, executor } = setup({}, { defaultCwd: '/srv/jobs', remote: { laptop: { turns: [DONE] } } });
    expect(await executor.run(contextFor(jobWith({ prompt: 'go' }), 'laptop/lane-1', LAPTOP).ctx)).toMatchObject({ kind: 'finished' });
    expect(remotes.get('laptop')!.calls.find((c) => c.method === 'createTab')!.args[0]).toMatchObject({ cwd: '/srv/jobs' });
  });

  it('this machine: against this process\'s home', async () => {
    const { herdr, executor } = setup({ turns: [DONE] }, { defaultCwd: '~/jobs' });
    expect(await executor.run(contextFor(jobWith({ prompt: 'go' })).ctx)).toMatchObject({ kind: 'finished' });
    expect(herdr.calls.find((c) => c.method === 'createTab')!.args[0]).toMatchObject({ cwd: `${homedir()}/jobs` });
  });
});

describe('herdr-claude executor: a work tree the machine cannot use fails the job at once', () => {
  it('the shell cannot enter the work tree: failed with what the shell said, pane closed, no 60 s wait and no Claude', async () => {
    const { remotes, executor } = setup({}, { defaultCwd: '/home/node', remote: { laptop: { turns: [DONE], unusableDirs: ['/home/node'] } } });
    const out = await executor.run(contextFor(jobWith({ prompt: 'go' }), 'laptop/lane-1', LAPTOP).ctx);
    expect(out).toMatchObject({ kind: 'failed' });
    expect((out as { error: string }).error).toMatch(/^the work tree \/home\/node is not usable on laptop: /);
    const there = remotes.get('laptop')!;
    expect(there.calls.filter((c) => c.method === 'runInPane')).toHaveLength(1);
    expect(there.agentStarts).toEqual([]);
    expect(there.calls.some((c) => c.method === 'closePane')).toBe(true);
  });
});
