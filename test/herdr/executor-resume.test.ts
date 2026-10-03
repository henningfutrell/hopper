import { describe, expect, it } from 'vitest';
import type { ExecutionOutcome } from '../../src/domain/ports.ts';
import type { FakeTurn } from '../../src/executors/herdr/index.ts';
import { CWD, LANE, contextFor, jobWith, setup, until } from './support.ts';

const ASK = { output: ['● Which language should the greeting be in?', '  JOB_HOPPER_QUESTION'] };
const DONE_FR = { steps: ['● Writing greeting.txt'], output: ['● I wrote greeting.txt in French.', '  JOB_HOPPER_DONE'] };

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
    const { executor, job } = await parked([ASK, { steps: ['● a', '● b', '● c'], output: ['● Next: which file name?', '  JOB_HOPPER_QUESTION'] }]);
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

  it('sends esc first when Claude is blocked at a dialog', async () => {
    const { herdr, executor, job } = await parked([{ output: ['● Pick one', '  ❯ 1. Red'], end: 'blocked' }, DONE_FR]);
    const out = await executor.resume!(contextFor(job).ctx, 'Red');
    expect(out.kind).toBe('finished');
    const escAt = herdr.calls.findIndex((c) => c.method === 'sendKeys' && (c.args[1] as string[])[0] === 'esc');
    const promptAt = herdr.calls.findIndex((c) => c.method === 'prompt' && c.args[1] === 'Red');
    expect(escAt).toBeGreaterThanOrEqual(0);
    expect(escAt).toBeLessThan(promptAt);
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
    await executor.cleanup!(job);
    expect(herdr.keys).toEqual([{ paneId: 'w1:p1', keys: ['esc'] }, { paneId: 'w1:p1', keys: ['ctrl+c', 'ctrl+c'] }]);
    expect(herdr.closed).toEqual(['w1:p1']);
    await expect(executor.cleanup!(job)).resolves.toBeUndefined();
    expect(herdr.closed).toEqual(['w1:p1']);
  });

  it('cleanup of a job that never got a pane does nothing', async () => {
    const { herdr, executor } = setup();
    await executor.cleanup!(jobWith({ prompt: 'go' }));
    expect(herdr.calls).toEqual([]);
  });
});
