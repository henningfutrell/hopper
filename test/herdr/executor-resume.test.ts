import { describe, expect, it } from 'vitest';
import type { ExecutionOutcome } from '../../src/domain/ports.ts';
import type { FakeTurn } from '../../src/executors/herdr/index.ts';
import { CWD, LANE, contextFor, jobWith, setup, until } from './support.ts';

const ASK = { output: ['● Which language should the greeting be in?', '  HOPPER_QUESTION'] };
const DONE_FR = { steps: ['● Writing greeting.txt'], output: ['● I wrote greeting.txt in French.', '  HOPPER_DONE'] };

/** Run to the first question; returns the job as the engine would hand it to resume. */
async function parked(turns: FakeTurn[]) {
  const s = setup({ turns });
  const first = contextFor(jobWith({ prompt: 'Write a greeting' }));
  const out = await s.executor.run(first.ctx);
  expect(out.kind).toBe('question');
  const job = jobWith({ prompt: 'Write a greeting' }, { executorState: first.saved.at(-1), status: 'running' });
  return { ...s, job };
}

describe('herdr-claude executor: resume', () => {
  it('types the answer once, ignores the previous turn marker, finishes on the new one', async () => {
    const { herdr, executor, job } = await parked([ASK, DONE_FR]);
    const { ctx, progress } = contextFor(job, 'local/lane-2');
    const out = await executor.resume!(ctx, 'French.');
    expect(out).toEqual({ kind: 'finished', result: { summary: 'I wrote greeting.txt in French.', paneId: 'w1:p1' } });
    expect(herdr.prompts.map((p) => p.text).slice(1)).toEqual(['French.']);
    expect(progress.map((p) => p.message)).toContain('Writing greeting.txt');
  });

  it('does not report the old question while the resumed turn is still working', async () => {
    const { executor, job } = await parked([ASK, { steps: ['● a', '● b', '● c'], output: ['● Next: which file name?', '  HOPPER_QUESTION'] }]);
    const out = await executor.resume!(contextFor(job).ctx, 'French.');
    expect(out).toMatchObject({ kind: 'question', question: { text: 'Next: which file name?' } });
  });

  it('maps the new lane to the parked pane and saves state with that lane', async () => {
    const { herdr, executor, job } = await parked([ASK, { ...DONE_FR, steps: ['● a', '● b', '● c'] }]);
    const { ctx, saved } = contextFor(job, 'local/lane-2');
    const resuming = executor.resume!(ctx, 'French.');
    await until(() => herdr.prompts.length === 2);
    expect(executor.lanePanes().get('local/lane-2')).toBe('w1:p1');
    await resuming;
    expect(saved.at(-1)).toMatchObject({ paneId: 'w1:p1', agentName: 'jh-abcdef12', laneId: 'local/lane-2', cwd: CWD });
    expect(executor.lanePanes().size).toBe(0);
  });

  it('sends esc first when Claude is blocked at a dialog and the answer names none of its options', async () => {
    const { herdr, executor, job } = await parked([{ output: ['● Pick one', '  ❯ 1. Red'], end: 'blocked' }, DONE_FR]);
    const out = await executor.resume!(contextFor(job).ctx, 'Green');
    expect(out.kind).toBe('finished');
    const escAt = herdr.calls.findIndex((c) => c.method === 'sendKeys' && (c.args[1] as string[])[0] === 'esc');
    const promptAt = herdr.calls.findIndex((c) => c.method === 'prompt' && c.args[1] === 'Green');
    expect(escAt).toBeGreaterThanOrEqual(0);
    expect(escAt).toBeLessThan(promptAt);
  });

  // Issue #267: without yolo Claude asks before it acts; the answer picks the dialog's option.
  it('answers a permission dialog with the option the answer names: no esc, no prompt, the turn goes on', async () => {
    const dialog = {
      output: ['● Bash(rm -rf build)', ' Do you want to proceed?', ' ❯ 1. Yes', "   2. Yes, and don't ask again for rm commands", '   3. No, and tell Claude what to do differently (esc)'],
      end: 'blocked' as const,
    };
    const { herdr, executor, job } = await parked([dialog, DONE_FR]);
    const out = await executor.resume!(contextFor(job).ctx, '2');
    expect(out).toEqual({ kind: 'finished', result: { summary: 'I wrote greeting.txt in French.', paneId: 'w1:p1' } });
    expect(herdr.texts.map((t) => t.text)).toContain('2');
    expect(herdr.keys.some((k) => k.keys.includes('esc'))).toBe(false);
    expect(herdr.prompts).toHaveLength(1);
  });

  // Issue #278: a pick that never reaches the dialog leaves Claude waiting; the job must not stay running.
  it('asks again when a dialog pick is lost and Claude still waits at the same dialog after idleNudgeMs', async () => {
    const dialog = {
      output: ['● Bash(rm -rf build)', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No, and tell Claude what to do differently (esc)'],
      end: 'blocked' as const,
    };
    const s = setup({ turns: [dialog, DONE_FR], dropsDialogPicks: 1 }, { idleNudgeMs: 20000 });
    const first = contextFor(jobWith({ prompt: 'Write a greeting' }));
    expect((await s.executor.run(first.ctx)).kind).toBe('question');
    const job = jobWith({ prompt: 'Write a greeting' }, { executorState: first.saved.at(-1), status: 'running' });
    const before = s.clock.elapsed();
    const out = await s.executor.resume!(contextFor(job).ctx, '1');
    expect(out).toMatchObject({ kind: 'question', question: { detectedBy: 'blocked', text: expect.stringContaining('Do you want to proceed?') } });
    expect(s.clock.elapsed() - before).toBeGreaterThanOrEqual(20000);
    expect(s.clock.elapsed() - before).toBeLessThan(40000);
  });

  it('fails with pane lost when the agent is gone', async () => {
    const { herdr, executor, job } = await parked([ASK]);
    herdr.killAgent('jh-abcdef12');
    expect(await executor.resume!(contextFor(job).ctx, 'French.')).toEqual({ kind: 'failed', error: 'pane lost' });
  });

  it('fails with pane lost when the job carries no executor state', async () => {
    const { executor } = setup();
    expect(await executor.resume!(contextFor(jobWith({ prompt: 'go' })).ctx, 'x')).toEqual({ kind: 'failed', error: 'pane lost' });
  });
});

describe('herdr-claude executor: cancel, shutdown, cleanup', () => {
  const FOREVER = { output: [], end: 'working' as const };

  it('cancel: esc, ctrl+c twice, close the pane; failed aborted', async () => {
    const { herdr, executor } = setup({ turns: [FOREVER] });
    const { ctx, ac } = contextFor(jobWith({ prompt: 'go' }));
    const running = executor.run(ctx);
    await until(() => herdr.prompts.length === 1);
    ac.abort('cancel');
    expect(await running).toEqual({ kind: 'failed', error: 'aborted' });
    expect(herdr.keys).toEqual([{ paneId: 'w1:p1', keys: ['esc'] }, { paneId: 'w1:p1', keys: ['ctrl+c', 'ctrl+c'] }]);
    expect(herdr.closed).toEqual(['w1:p1']);
    expect(executor.lanePanes().has(LANE)).toBe(false);
  });

  it('shutdown: returns at once and leaves the pane alone', async () => {
    const { herdr, executor } = setup({ turns: [FOREVER] });
    const { ctx, ac } = contextFor(jobWith({ prompt: 'go' }));
    const running = executor.run(ctx);
    await until(() => herdr.prompts.length === 1);
    ac.abort('shutdown');
    const callsAtAbort = herdr.calls.length;
    const out: ExecutionOutcome = await running;
    expect(out).toEqual({ kind: 'failed', error: 'shutdown' });
    expect(herdr.keys).toEqual([]);
    expect(herdr.closed).toEqual([]);
    expect(herdr.calls.slice(callsAtAbort).filter((c) => c.method !== 'getAgent' && c.method !== 'read')).toEqual([]);
  });

  it('shutdown during resume also leaves the pane', async () => {
    const { herdr, executor, job } = await parked([ASK, FOREVER]);
    const { ctx, ac } = contextFor(job);
    const resuming = executor.resume!(ctx, 'French.');
    await until(() => herdr.prompts.length === 2);
    ac.abort('shutdown');
    expect(await resuming).toEqual({ kind: 'failed', error: 'shutdown' });
    expect(herdr.closed).toEqual([]);
  });

  it('cleanup exits Claude and closes the pane from executorState; idempotent and silent', async () => {
    const { herdr, executor, job } = await parked([ASK]);
    expect(await executor.cleanup!(job)).toEqual({ kept: [] });
    expect(herdr.keys).toEqual([{ paneId: 'w1:p1', keys: ['esc'] }, { paneId: 'w1:p1', keys: ['ctrl+c', 'ctrl+c'] }]);
    expect(herdr.closed).toEqual(['w1:p1']);
    // Again: the reap runs again on the machine (nothing left to stop), the pane is not closed twice.
    await expect(executor.cleanup!(job)).resolves.toEqual({ kept: [] });
    expect(herdr.closed).toEqual(['w1:p1']);
  });

  it('cleanup reaps through the machine\'s connection, never the pane, before it closes the pane: the job\'s scope, processes and scratch dir (issues #401, #410)', async () => {
    const { herdr, executor, job } = await parked([ASK]);
    const typed = herdr.calls.filter((c) => c.method === 'runInPane').length;
    await executor.cleanup!(job);
    const order = herdr.calls.map((c) => c.method);
    expect(herdr.reaps).toEqual([{ jobId: job.id, scratch: `${CWD}/.hopper-scratch/${job.id}` }]);
    expect(order.indexOf('reap')).toBeGreaterThan(order.lastIndexOf('sendKeys'));
    expect(order.indexOf('reap')).toBeLessThan(order.indexOf('closePane'));
    expect(herdr.calls.filter((c) => c.method === 'runInPane')).toHaveLength(typed);
  });

  it('cleanup answers the repositories the reap kept for their uncommitted or unpushed work (issue #401)', async () => {
    const s = setup({ turns: [ASK], reapKeeps: ['/w/.hopper-scratch/j/repo'] });
    const first = contextFor(jobWith({ prompt: 'Write a greeting' }));
    await s.executor.run(first.ctx);
    const job = jobWith({ prompt: 'Write a greeting' }, { executorState: first.saved.at(-1) });
    expect(await s.executor.cleanup!(job)).toEqual({ kept: ['/w/.hopper-scratch/j/repo'] });
  });

  it('reaps a Claude that does not exit by itself: the reap stops it with the job\'s other processes, nothing typed into it (issue #410)', async () => {
    const s = setup({ turns: [ASK], ignoresCtrlC: true });
    const first = contextFor(jobWith({ prompt: 'Write a greeting' }));
    await s.executor.run(first.ctx);
    const runs = s.herdr.calls.filter((c) => c.method === 'runInPane').length;
    const job = jobWith({ prompt: 'Write a greeting' }, { executorState: first.saved.at(-1) });
    expect(await s.executor.cleanup!(job)).toEqual({ kept: [] });
    expect(s.herdr.reaps).toHaveLength(1);
    expect(s.herdr.calls.filter((c) => c.method === 'runInPane')).toHaveLength(runs);
    expect(s.herdr.closed).toEqual(['w1:p1']);
  });

  it('a machine the reap cannot reach: the pane still closes, and nothing is said kept (the sweep reaps it later)', async () => {
    const s = setup({ turns: [ASK], machineUnreachable: true });
    const first = contextFor(jobWith({ prompt: 'Write a greeting' }));
    await s.executor.run(first.ctx);
    const job = jobWith({ prompt: 'Write a greeting' }, { executorState: first.saved.at(-1) });
    expect(await s.executor.cleanup!(job)).toBeUndefined();
    expect(s.herdr.closed).toEqual(['w1:p1']);
  });

  it('a job whose pane is gone (the hopper stopped, the machine restarted) is still reaped on its machine (issue #410)', async () => {
    const s = setup({ turns: [ASK] });
    const first = contextFor(jobWith({ prompt: 'Write a greeting' }));
    await s.executor.run(first.ctx);
    await s.herdr.closePane('w1:p1');
    const job = jobWith({ prompt: 'Write a greeting' }, { executorState: first.saved.at(-1) });
    expect(await s.executor.cleanup!(job)).toEqual({ kept: [] });
    expect(s.herdr.reaps).toEqual([{ jobId: job.id, scratch: `${CWD}/.hopper-scratch/${job.id}` }]);
  });

  it('a cancelled job is reaped as its pane closes, and cleanup after still answers what was kept', async () => {
    const s = setup({ turns: [FOREVER], reapKeeps: ['/w/kept'] });
    const { ctx, ac, saved } = contextFor(jobWith({ prompt: 'go' }));
    const running = s.executor.run(ctx);
    await until(() => s.herdr.prompts.length === 1);
    ac.abort('cancel');
    await running;
    expect(s.herdr.reaps).toHaveLength(1);
    expect(await s.executor.cleanup!(jobWith({ prompt: 'go' }, { executorState: saved.at(-1) }))).toEqual({ kept: ['/w/kept'] });
  });

  it('cleanup of a job that never got a pane does nothing', async () => {
    const { herdr, executor } = setup();
    await executor.cleanup!(jobWith({ prompt: 'go' }));
    expect(herdr.calls).toEqual([]);
  });

  it('refuses to map a pane another lane holds: failed, pane untouched', async () => {
    const s = setup({ turns: [{ output: [], end: 'working' }] });
    const first = contextFor(jobWith({ prompt: 'Write a greeting' }), 'local/lane-1');
    const running = s.executor.run(first.ctx);
    await until(() => s.herdr.prompts.length === 1);
    expect(s.executor.lanePanes().get('local/lane-1')).toBe('w1:p1');

    const intruder = jobWith({ prompt: 'x' }, { id: 'ffffffff-0000-0000-0000-000000000000', executorState: first.saved.at(-1) });
    const out = await s.executor.resume!(contextFor(intruder, 'local/lane-2').ctx, 'answer');
    expect(out.kind === 'failed' && out.error).toMatch(/w1:p1.*local\/lane-1/);
    expect(s.herdr.closed).toEqual([]);
    expect(s.herdr.keys).toEqual([]);
    expect(s.herdr.prompts).toHaveLength(1);
    expect([...s.executor.lanePanes()]).toEqual([['local/lane-1', 'w1:p1']]);

    first.ac.abort();
    await running;
  });
});
