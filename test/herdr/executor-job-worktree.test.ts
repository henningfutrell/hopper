// Each job its own git worktree (issue #379): the herdr-claude executor's side, over the fake herdr.
// What the commands do to a real repository is test/herdr/job-worktree.test.ts.
import { describe, expect, it } from 'vitest';
import { jobWorktreeOf, makeJobWorktreeCommand, removeJobWorktreeCommand } from '../../src/executors/herdr/job-worktree.ts';
import { CWD, JOB_ID, contextFor, jobWith, setup, until } from './support.ts';

const DONE = { output: ['● Done.', '  HOPPER_DONE'] };
const JOB_TREE = jobWorktreeOf(CWD, JOB_ID);

const runs = (herdr: { calls: { method: string; args: unknown[] }[] }): string[] =>
  herdr.calls.filter((c) => c.method === 'runInPane').map((c) => c.args[1] as string);

describe('herdr-claude executor: a job worktree for each job (issue #379)', () => {
  it('is under the work tree, named for the job', () => {
    expect(JOB_TREE).toBe(`${CWD}/.hopper-jobs/${JOB_ID}`);
  });

  it('makes the job its own worktree of the work tree before Claude starts, and runs Claude there', async () => {
    const { herdr, executor } = setup({ turns: [DONE], repositories: [CWD] }, { jobWorktrees: true });
    const { ctx, saved, workTrees } = contextFor(jobWith({ prompt: 'go' }));
    expect(await executor.run(ctx)).toMatchObject({ kind: 'finished' });
    expect(runs(herdr)).toContain(makeJobWorktreeCommand(CWD, JOB_TREE));
    const order = herdr.calls.map((c) => c.method === 'runInPane' ? `run:${String(c.args[1]).includes('worktree add') ? 'worktree' : 'other'}` : c.method);
    expect(order.indexOf('run:worktree')).toBeLessThan(order.indexOf('startAgent'));
    expect(saved.at(-1)).toMatchObject({ cwd: JOB_TREE, jobWorktree: { from: CWD } });
    expect(workTrees.at(-1)).toBe(JOB_TREE);
  });

  it('the prompt names the job worktree as the work tree, and the shared work tree as one to leave alone', async () => {
    const { herdr, executor } = setup({ turns: [DONE], repositories: [CWD] }, { jobWorktrees: true });
    await executor.run(contextFor(jobWith({ prompt: 'go' })).ctx);
    const sent = herdr.prompts[0]!.text;
    expect(sent).toContain(`[hopper work tree] This job's work tree is ${JOB_TREE}.`);
    expect(sent).toContain(`Temporary files go in ${JOB_TREE}/.hopper-scratch`);
    expect(sent).toContain(`[hopper job worktree] ${JOB_TREE} is a git worktree of ${CWD} made for this job alone`);
  });

  it('accepts the folder-trust dialog naming the job worktree', async () => {
    const { executor } = setup({ turns: [DONE], repositories: [CWD], trustDialogFor: JOB_TREE }, { jobWorktrees: true });
    const { ctx, progress } = contextFor(jobWith({ prompt: 'go' }));
    expect(await executor.run(ctx)).toMatchObject({ kind: 'finished' });
    expect(progress.map((p) => p.message)).toContain(`trusted workdir ${JOB_TREE}`);
  });

  it('a work tree that is not the top of a git repository: the job runs in it, as without job worktrees', async () => {
    const { herdr, executor } = setup({ turns: [DONE] }, { jobWorktrees: true });
    const { ctx, saved, workTrees } = contextFor(jobWith({ prompt: 'go' }));
    expect(await executor.run(ctx)).toMatchObject({ kind: 'finished' });
    expect(runs(herdr)).toContain(makeJobWorktreeCommand(CWD, JOB_TREE));
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
    expect(runs(herdr).some((r) => r.includes('hopper-job-'))).toBe(false);
    expect(herdr.prompts[0]!.text).toContain(`This job's work tree is ${CWD}.`);
  });

  it('when the job ends, removes its worktree (once nothing in it is unpushed) before the pane closes', async () => {
    const { herdr, executor } = setup({ turns: [DONE], repositories: [CWD] }, { jobWorktrees: true });
    const { ctx, saved } = contextFor(jobWith({ prompt: 'go' }));
    await executor.run(ctx);
    await executor.cleanup!(jobWith({ prompt: 'go' }, { executorState: saved.at(-1) }));
    const methods = herdr.calls.map((c) => c.method === 'runInPane' && c.args[1] === removeJobWorktreeCommand(CWD, JOB_TREE) ? 'remove' : c.method);
    expect(methods.indexOf('remove')).toBeGreaterThan(-1);
    expect(methods.indexOf('remove')).toBeLessThan(methods.indexOf('closePane'));
    expect(herdr.closed).toEqual(['w1:p1']);
  });

  it('a worktree kept for its unpushed work still lets the pane close', async () => {
    const { herdr, executor } = setup({ turns: [DONE], repositories: [CWD], keepsWorktrees: true }, { jobWorktrees: true });
    const { ctx, saved } = contextFor(jobWith({ prompt: 'go' }));
    await executor.run(ctx);
    await executor.cleanup!(jobWith({ prompt: 'go' }, { executorState: saved.at(-1) }));
    expect(herdr.screen('w1:p1')).toContain('hopper-job-worktree-kept');
    expect(herdr.closed).toEqual(['w1:p1']);
  });

  it('a cancelled job removes its worktree too', async () => {
    const { herdr, executor } = setup({ turns: [{ output: [], end: 'working' }], repositories: [CWD] }, { jobWorktrees: true });
    const { ctx, ac } = contextFor(jobWith({ prompt: 'go' }));
    const running = executor.run(ctx);
    await until(() => herdr.prompts.length === 1);
    ac.abort('cancel');
    expect(await running).toEqual({ kind: 'failed', error: 'aborted' });
    expect(runs(herdr)).toContain(removeJobWorktreeCommand(CWD, JOB_TREE));
    expect(herdr.closed).toEqual(['w1:p1']);
  });

  it('a job without a job worktree removes nothing when it ends', async () => {
    const { herdr, executor } = setup({ turns: [DONE] }, { jobWorktrees: true });
    const { ctx, saved } = contextFor(jobWith({ prompt: 'go' }));
    await executor.run(ctx);
    await executor.cleanup!(jobWith({ prompt: 'go' }, { executorState: saved.at(-1) }));
    expect(runs(herdr).some((r) => r.includes('worktree remove'))).toBe(false);
  });

  it('reattached, it reports the job worktree its pane runs in', async () => {
    const { executor } = setup({ turns: [DONE] }, { jobWorktrees: true });
    const state = { workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1', agentName: 'jh-abcdef12', cwd: JOB_TREE, laneId: 'l', jobWorktree: { from: CWD } };
    const { ctx, workTrees } = contextFor(jobWith({ prompt: 'go' }, { executorState: state }));
    await executor.reattach!(ctx);
    expect(workTrees).toEqual([JOB_TREE]);
  });
});
