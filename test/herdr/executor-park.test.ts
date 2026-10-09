// Parking (issue #501), the herdr-claude executor's side over the fake herdr: `park` ends the pane and Claude and
// stops the job's processes, never naming its scratch dir (its worktree) to the reap; a resume of the parked job
// opens a new pane, enters the same worktree, and resumes the recorded session, then sends the answer; with no session
// recorded (issue #530), it starts a fresh one there and sends the task, the engine's brief and the footer.
import { describe, expect, it } from 'vitest';
import { jobWorktreeOf } from '../../src/executors/herdr/job-worktree.ts';
import type { PaneState } from '../../src/executors/herdr/start.ts';
import { CWD, JOB_ID, contextFor, jobWith, setup } from './support.ts';

const ASK = { output: ['● Which colour?', '  HOPPER_QUESTION'] };
const DONE = { output: ['● Done.', '  HOPPER_DONE'] };
const JOB_TREE = jobWorktreeOf(CWD, JOB_ID);
const PARKED = { at: '2026-10-08T00:00:00Z', from: 'waiting_answer' as const };

describe('herdr-claude executor: park and resume (issue #501)', () => {
  it('park: Claude exits, the job\'s processes stop, the pane closes; the scratch dir is never reaped', async () => {
    const { herdr, executor } = setup({ turns: [ASK], repositories: [CWD] }, { jobWorktrees: true });
    const { ctx, saved, sessions } = contextFor(jobWith({ prompt: 'go' }));
    expect(await executor.run(ctx)).toMatchObject({ kind: 'question' });
    const state = saved.at(-1) as unknown as PaneState;

    await executor.park!(jobWith({ prompt: 'go' }, { status: 'parked', executorState: { ...state }, agentSession: sessions[0]! }));

    expect(herdr.closed).toEqual([state.paneId]);
    expect(herdr.reaps).toEqual([{ jobId: JOB_ID }]);
    expect(await herdr.getAgent(state.agentName)).toBeNull();
  });

  it('park rejects when the machine cannot be reached, so the engine says so and the sweep stops it later', async () => {
    const { herdr, executor } = setup({ turns: [ASK] });
    const { ctx, saved } = contextFor(jobWith({ prompt: 'go' }));
    await executor.run(ctx);
    herdr.setUnreachable(true);
    await expect(executor.park!(jobWith({ prompt: 'go' }, { status: 'parked', executorState: { ...saved.at(-1) } }))).rejects.toThrow(/may still be open/);
  });

  it('resume of a parked job: a new pane, the same worktree, `claude --resume <session>`, then the answer', async () => {
    const { herdr, executor } = setup({ turns: [ASK, DONE], repositories: [CWD] }, { jobWorktrees: true });
    const first = contextFor(jobWith({ prompt: 'go' }));
    await executor.run(first.ctx);
    const state = first.saved.at(-1) as unknown as PaneState;
    const session = first.sessions[0]!;
    const parkedJob = jobWith({ prompt: 'go' }, { status: 'claimed', executorState: { ...state }, agentSession: session, parked: PARKED });
    await executor.park!(parkedJob);

    const again = contextFor(parkedJob);
    expect(await executor.resume!(again.ctx, 'Blue.')).toMatchObject({ kind: 'finished' });
    expect(herdr.agentStarts).toHaveLength(2);
    expect(herdr.agentStarts[1]!.args).toEqual(expect.arrayContaining(['--resume', session]));
    expect(herdr.agentStarts[1]!.args).not.toContain('--session-id');
    expect(herdr.agentStarts[1]!.paneId).not.toBe(state.paneId);
    expect(again.saved.at(-1)).toMatchObject({ cwd: CWD, jobWorktree: JOB_TREE });
    expect(again.workTrees.at(-1)).toBe(JOB_TREE);
    expect(again.sessions).toEqual([session]);
    expect(herdr.prompts.map((p) => p.text).at(-1)).toBe('Blue.');
    // Whatever of the parked run might still run is stopped before the session is resumed: never two agents in it.
    expect(herdr.reaps.filter((r) => r.scratch === undefined)).toHaveLength(2);
  });

  it('cleanup of a parked job that was cancelled: only the reap, scratch dir included; no key reaches its old pane id, which may be another job\'s now', async () => {
    const { herdr, executor } = setup({ turns: [ASK, DONE] });
    const first = contextFor(jobWith({ prompt: 'go' }));
    await executor.run(first.ctx);
    const state = first.saved.at(-1) as unknown as PaneState;
    await executor.park!(jobWith({ prompt: 'go' }, { status: 'parked', executorState: { ...state } }));
    const keysBefore = herdr.keys.length;

    await executor.cleanup!(jobWith({ prompt: 'go' }, { status: 'cancelled', executorState: { ...state }, parked: PARKED }));

    expect(herdr.keys).toHaveLength(keysBefore);
    expect(herdr.closed).toEqual([state.paneId]);
    expect(herdr.reaps.at(-1)).toEqual({ jobId: JOB_ID, scratch: `${CWD}/.hopper-scratch/${JOB_ID}` });
  });

  it('a parked job with no recorded session (issue #530) starts a fresh one in the same worktree: its task, the brief, the footer', async () => {
    const { herdr, executor } = setup({ turns: [ASK, DONE], repositories: [CWD] }, { jobWorktrees: true });
    const first = contextFor(jobWith({ prompt: 'Paint the shed' }));
    await executor.run(first.ctx);
    const state = first.saved.at(-1) as unknown as PaneState;
    const parkedJob = jobWith({ prompt: 'Paint the shed' }, { status: 'claimed', executorState: { ...state }, parked: PARKED });
    await executor.park!(parkedJob);

    const again = contextFor(parkedJob);
    expect(await executor.resume!(again.ctx, 'BRIEF: it asked which colour; the answer: Blue.')).toMatchObject({ kind: 'finished' });
    expect(herdr.agentStarts[1]!.args).not.toContain('--resume');
    expect(herdr.agentStarts[1]!.args).toContain('--session-id');
    expect(again.sessions).toHaveLength(1);
    expect(again.saved.at(-1)).toMatchObject({ cwd: CWD, jobWorktree: JOB_TREE });
    const sent = herdr.prompts.at(-1)!.text;
    expect(sent.indexOf('Paint the shed')).toBeLessThan(sent.indexOf('BRIEF:'));
    expect(sent).toContain('HOPPER_DONE');
  });

  it('a parked job with no pane state fails its resume: its work tree is not known', async () => {
    const { herdr, executor } = setup({ turns: [DONE] });
    const job = jobWith({ prompt: 'go' }, { status: 'claimed', parked: PARKED });
    expect(await executor.resume!(contextFor(job).ctx, 'go on')).toEqual({ kind: 'failed', error: 'the parked job has no pane state: its work tree is not known' });
    expect(herdr.agentStarts).toEqual([]);
  });
});
