// Each job its own git worktree (issue #379): the herdr-claude executor's side, over the fake herdr.
// What the commands do to a real repository is test/herdr/job-worktree.test.ts.
import { describe, expect, it } from 'vitest';
import { checkoutWorktreeOf, jobWorktreeOf, makeJobWorktreeCommand } from '../../src/executors/herdr/job-worktree.ts';
import { CWD, JOB_ID, contextFor, jobWith, setup, until } from './support.ts';

const DONE = { output: ['● Done.', '  HOPPER_DONE'] };
const JOB_TREE = jobWorktreeOf(CWD, JOB_ID);
const SCRATCH = `${CWD}/.hopper-scratch/${JOB_ID}`;

const runs = (herdr: { calls: { method: string; args: unknown[] }[] }): string[] =>
  herdr.calls.filter((c) => c.method === 'runInPane').map((c) => c.args[1] as string);

describe('herdr-claude executor: a job worktree for each job (issue #379)', () => {
  it('is in the job\'s scratch dir, named as the work tree is', () => {
    expect(JOB_TREE).toBe(`${SCRATCH}/jh-work`);
  });

  it('makes the job its own worktree of the work tree before Claude starts, and runs Claude there', async () => {
    const { herdr, executor } = setup({ turns: [DONE], repositories: [CWD] }, { jobWorktrees: true });
    const { ctx, saved, workTrees } = contextFor(jobWith({ prompt: 'go' }));
    expect(await executor.run(ctx)).toMatchObject({ kind: 'finished' });
    expect(runs(herdr)).toContain(makeJobWorktreeCommand(CWD, JOB_ID));
    const order = herdr.calls.map((c) => c.method === 'runInPane' ? `run:${String(c.args[1]).includes('worktree add') ? 'worktree' : 'other'}` : c.method);
    expect(order.indexOf('run:worktree')).toBeLessThan(order.indexOf('startAgent'));
    expect(saved.at(-1)).toMatchObject({ cwd: CWD, jobWorktree: JOB_TREE });
    expect(workTrees.at(-1)).toBe(JOB_TREE);
  });

  it('the prompt names the job worktree as the work tree, and the shared work tree as one to leave alone', async () => {
    const { herdr, executor } = setup({ turns: [DONE], repositories: [CWD] }, { jobWorktrees: true });
    await executor.run(contextFor(jobWith({ prompt: 'go' })).ctx);
    const sent = herdr.prompts[0]!.text;
    expect(sent).toContain(`[hopper work tree] This job's work tree is ${CWD}.`);
    expect(sent).toContain(`[hopper job worktree] Work in ${JOB_TREE}: a git worktree of ${CWD} made for this job alone`);
    expect(sent).toContain(`${CWD} itself is shared with other jobs`);
  });

  it('accepts the folder-trust dialog naming the job worktree', async () => {
    const { executor } = setup({ turns: [DONE], repositories: [CWD], trustDialogFor: JOB_TREE }, { jobWorktrees: true });
    const { ctx, progress } = contextFor(jobWith({ prompt: 'go' }));
    expect(await executor.run(ctx)).toMatchObject({ kind: 'finished' });
    expect(progress.map((p) => p.message)).toContain(`trusted workdir ${JOB_TREE}`);
  });

  // Issue #361: a work tree that is no repository gets the job's repository, and the job a worktree of that checkout.
  it('a job from a repository, its work tree no repository: a worktree of the repository\'s checkout in the work tree, named in the prompt', async () => {
    const { herdr, executor } = setup({ turns: [DONE] }, { jobWorktrees: true });
    const source = { source: 'github', kind: 'github-account', key: 'k', url: 'u', title: 't', author: 'a', repo: 'acme/app' };
    const { ctx, saved, workTrees } = contextFor(jobWith({ prompt: 'go' }, { source }));
    expect(await executor.run(ctx)).toMatchObject({ kind: 'finished' });
    expect(runs(herdr)).toContain(makeJobWorktreeCommand(CWD, JOB_ID, { repo: 'acme/app' }));
    const tree = checkoutWorktreeOf(CWD, JOB_ID, 'acme/app');
    expect(saved.at(-1)).toMatchObject({ cwd: CWD, jobWorktree: tree, checkout: `${CWD}/app` });
    expect(workTrees.at(-1)).toBe(tree);
    expect(herdr.prompts[0]!.text).toContain(`[hopper job worktree] Work in ${tree}: a git worktree of ${CWD}/app made for this job alone`);
  });

  it('job worktrees off, a job from a repository: the checkout is made, and the job runs in the work tree', async () => {
    const { herdr, executor } = setup({ turns: [DONE] });
    const source = { source: 'github', kind: 'github-account', key: 'k', url: 'u', title: 't', author: 'a', repo: 'acme/app' };
    const { ctx, saved, workTrees } = contextFor(jobWith({ prompt: 'go' }, { source }));
    expect(await executor.run(ctx)).toMatchObject({ kind: 'finished' });
    expect(runs(herdr)).toContain(makeJobWorktreeCommand(CWD, JOB_ID, { repo: 'acme/app', worktrees: false }));
    expect(saved.at(-1)).not.toHaveProperty('jobWorktree');
    expect(workTrees).toEqual([CWD]);
  });

  it('a work tree that is not the top of a git repository: the job runs in it, as without job worktrees', async () => {
    const { herdr, executor } = setup({ turns: [DONE] }, { jobWorktrees: true });
    const { ctx, saved, workTrees } = contextFor(jobWith({ prompt: 'go' }));
    expect(await executor.run(ctx)).toMatchObject({ kind: 'finished' });
    expect(runs(herdr)).toContain(makeJobWorktreeCommand(CWD, JOB_ID));
    expect(saved.at(-1)).toMatchObject({ cwd: CWD });
    expect(saved.at(-1)).not.toHaveProperty('jobWorktree');
    expect(workTrees).toEqual([CWD]);
    expect(herdr.prompts[0]!.text).not.toContain('[hopper job worktree]');
  });

  it('fails the job, pane closed, with what git said, when the worktree cannot be made', async () => {
    const { herdr, executor } = setup({ turns: [DONE], repositories: [CWD], worktreeFails: true }, { jobWorktrees: true });
    const out = await executor.run(contextFor(jobWith({ prompt: 'go' })).ctx);
    expect(out.kind).toBe('failed');
    expect(out.kind === 'failed' && out.error).toContain(`the job worktree ${JOB_TREE} could not be made on local:`);
    expect(out.kind === 'failed' && out.error).toContain('fatal:');
    expect(herdr.agentStarts).toEqual([]);
    expect(herdr.closed).toEqual(['w1:p1']);
  });

  it('off: no worktree command, the job runs in the work tree', async () => {
    const { herdr, executor } = setup({ turns: [DONE], repositories: [CWD] }, { jobWorktrees: false });
    await executor.run(contextFor(jobWith({ prompt: 'go' })).ctx);
    expect(runs(herdr).some((r) => r.includes('git worktree'))).toBe(false);
    expect(herdr.prompts[0]!.text).toContain(`This job's work tree is ${CWD}.`);
  });

  it('when the job ends, the reap of its scratch dir, which holds the worktree, runs before the pane closes', async () => {
    const { herdr, executor } = setup({ turns: [DONE], repositories: [CWD] }, { jobWorktrees: true });
    const { ctx, saved } = contextFor(jobWith({ prompt: 'go' }));
    await executor.run(ctx);
    await executor.cleanup!(jobWith({ prompt: 'go' }, { executorState: saved.at(-1) }));
    const methods = herdr.calls.map((c) => c.method);
    expect(herdr.reaps).toEqual([{ jobId: JOB_ID, scratch: SCRATCH }]);
    expect(methods.indexOf('reap')).toBeLessThan(methods.indexOf('closePane'));
    expect(herdr.closed).toEqual(['w1:p1']);
  });

  it('a cancelled job reaps its scratch dir with the worktree too', async () => {
    const { herdr, executor } = setup({ turns: [{ output: [], end: 'working' }], repositories: [CWD] }, { jobWorktrees: true });
    const { ctx, ac } = contextFor(jobWith({ prompt: 'go' }));
    const running = executor.run(ctx);
    await until(() => herdr.prompts.length === 1);
    ac.abort('cancel');
    expect(await running).toEqual({ kind: 'failed', error: 'aborted' });
    expect(herdr.reaps).toEqual([{ jobId: JOB_ID, scratch: SCRATCH }]);
    expect(herdr.closed).toEqual(['w1:p1']);
  });

  it('reattached, it reports the job worktree its pane runs in', async () => {
    const { executor } = setup({ turns: [DONE] }, { jobWorktrees: true });
    const state = { workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1', agentName: 'jh-abcdef12', cwd: CWD, laneId: 'l', jobWorktree: JOB_TREE };
    const { ctx, workTrees } = contextFor(jobWith({ prompt: 'go' }, { executorState: state }));
    await executor.reattach!(ctx);
    expect(workTrees).toEqual([JOB_TREE]);
  });

  it('shares dependencies in the job worktree after it is made and before Claude starts; the prompt says the link is read-only (issue #410)', async () => {
    const { herdr, executor } = setup({ turns: [DONE], repositories: [CWD], deps: 'linked' }, { jobWorktrees: true, sharedDependencies: true });
    const { ctx, saved, progress } = contextFor(jobWith({ prompt: 'go' }));
    expect(await executor.run(ctx)).toMatchObject({ kind: 'finished' });
    const order = herdr.calls.map((c) => (c.method === 'runInPane' ? `run:${String(c.args[1]).includes('worktree add') ? 'worktree' : String(c.args[1]).includes('.hopper-scratch/deps') ? 'deps' : 'other'}` : c.method));
    expect(order.indexOf('run:deps')).toBeGreaterThan(order.indexOf('run:worktree'));
    expect(order.indexOf('run:deps')).toBeLessThan(order.indexOf('startAgent'));
    expect(runs(herdr).find((r) => r.includes('.hopper-scratch/deps'))).toContain(`'${CWD}' '${JOB_TREE}' 1440`);
    expect(saved.at(-1)).toMatchObject({ sharedDependencies: true });
    expect(progress.map((p) => p.message)).toContain('dependencies: linked');
    expect(herdr.prompts[0]!.text).toContain('Its node_modules is a link to dependencies shared with the other jobs of this repository: read-only.');
    expect(herdr.prompts[0]!.text).toContain('make no other clone or worktree of it for this job');
  });

  it('dependencies not shared (no lockfile, or the install failed): the job goes on, and the prompt says nothing of a link', async () => {
    for (const deps of ['none', 'failed'] as const) {
      const { herdr, executor } = setup({ turns: [DONE], repositories: [CWD], deps }, { jobWorktrees: true, sharedDependencies: true });
      const { ctx, saved } = contextFor(jobWith({ prompt: 'go' }));
      expect(await executor.run(ctx)).toMatchObject({ kind: 'finished' });
      expect(saved.at(-1)).not.toHaveProperty('sharedDependencies');
      expect(herdr.prompts[0]!.text).not.toContain('node_modules');
    }
  });

  it('off, or no job worktree: no dependencies command', async () => {
    const off = setup({ turns: [DONE], repositories: [CWD], deps: 'linked' }, { jobWorktrees: true, sharedDependencies: false });
    await off.executor.run(contextFor(jobWith({ prompt: 'go' })).ctx);
    expect(runs(off.herdr).some((r) => r.includes('.hopper-scratch/deps'))).toBe(false);
    const plain = setup({ turns: [DONE], deps: 'linked' }, { jobWorktrees: true, sharedDependencies: true });
    await plain.executor.run(contextFor(jobWith({ prompt: 'go' })).ctx);
    expect(runs(plain.herdr).some((r) => r.includes('.hopper-scratch/deps'))).toBe(false);
  });

  // Issue #518: on two machines herdr's wait for the outcome answered within seconds, the worktree still being
  // made; the job failed as though ten minutes had passed. Its answer only says when to look at the screen.
  it('herdr\'s wait answers before the outcome is on screen: the hopper waits on until it is', async () => {
    const { herdr, executor } = setup({ turns: [DONE], repositories: [CWD], worktreeLag: 5, waitAnswersEarly: 'matched' }, { jobWorktrees: true });
    const { ctx, saved } = contextFor(jobWith({ prompt: 'go' }));
    expect(await executor.run(ctx)).toMatchObject({ kind: 'finished' });
    expect(saved.at(-1)).toMatchObject({ jobWorktree: JOB_TREE });
    expect(runs(herdr).filter((r) => r.includes(' hopper-worktree '))).toHaveLength(1);
  });

  it('the outcome never shows: failed after the ten minutes, by the hopper\'s own clock', async () => {
    const { executor, clock } = setup({ turns: [DONE], repositories: [CWD], worktreeLag: 1e9, waitAnswersEarly: 'matched' }, { jobWorktrees: true });
    const out = await executor.run(contextFor(jobWith({ prompt: 'go' })).ctx);
    expect(out.kind === 'failed' && out.error).toContain('never made the job worktree within 600000 ms');
    expect(clock.elapsed()).toBeGreaterThanOrEqual(600000);
  });

  // Issue #518: a zsh whose start-up files were busy lost what was typed; the job waited ten minutes for nothing.
  it('the shell loses the command: it is typed again, the line cleared first', async () => {
    const { herdr, executor } = setup({ turns: [DONE], repositories: [CWD], dropsWorktreeRuns: 1 }, { jobWorktrees: true });
    const { ctx, saved, progress } = contextFor(jobWith({ prompt: 'go' }));
    expect(await executor.run(ctx)).toMatchObject({ kind: 'finished' });
    expect(runs(herdr).filter((r) => r.includes(' hopper-worktree '))).toHaveLength(2);
    expect(herdr.keys.map((k) => k.keys)).toContainEqual(['ctrl+c']);
    expect(saved.at(-1)).toMatchObject({ jobWorktree: JOB_TREE });
    expect(progress.map((p) => p.message)).toContainEqual(expect.stringMatching(/^the shell did not run the job worktree command; typing it again/));
  });

  it('a shell that never runs it: the start is tried again in a new pane', async () => {
    const { herdr, executor } = setup({ turns: [DONE], repositories: [CWD], dropsWorktreeRuns: 3 }, { jobWorktrees: true });
    const { ctx, progress } = contextFor(jobWith({ prompt: 'go' }));
    expect(await executor.run(ctx)).toMatchObject({ kind: 'finished' });
    expect(herdr.closed[0]).toBe('w1:p1');
    expect(progress.map((p) => p.message)).toContainEqual(expect.stringMatching(/claude did not start \(attempt 1 of 3\).*never ran the job worktree command/));
  });
});
