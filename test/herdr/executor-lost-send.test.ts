import { describe, expect, it } from 'vitest';
import { STATUS_NOTE_NUDGE, protocolFooter } from '../../src/executors/herdr/index.ts';
import { CWD, contextFor, jobWith, setup, until } from './support.ts';

const DONE = { output: ['● Wrote hello.txt.', '  HOPPER_DONE'] };

describe('herdr-claude executor: lost sends', () => {
  // Issue #278: a job must never stay running while its Claude sits idle at an empty prompt.
  it('a prompt that never reaches Claude is sent again once Claude has sat idle for idleNudgeMs, and the job goes on', async () => {
    const { herdr, clock, executor } = setup({ turns: [DONE], dropsPrompts: 1 }, { idleNudgeMs: 20000 });
    const { ctx, progress, saved } = contextFor(jobWith({ prompt: 'Write hello.txt' }));
    expect(await executor.run(ctx)).toEqual({ kind: 'finished', result: { summary: 'Wrote hello.txt.', paneId: 'w1:p1' } });
    const sent = `Write hello.txt\n\n${protocolFooter(CWD)}`;
    expect(herdr.prompts.map((p) => p.text)).toEqual([sent, sent]);
    expect(clock.elapsed()).toBeGreaterThanOrEqual(20000);
    expect(clock.elapsed()).toBeLessThan(40000);
    expect(progress.map((p) => p.message)).toContain('the prompt never reached claude: sent it again');
    expect(saved.at(-1)).toMatchObject({ turn: { text: sent } });
  });

  it('a nudge that never reaches Claude is sent again too', async () => {
    const note = { output: ['● Tests are running in the background.'] };
    const { herdr, executor } = setup({ turns: [note, DONE] }, { idleNudgeMs: 20000 });
    const run = executor.run(contextFor(jobWith({ prompt: 'go' })).ctx);
    await until(() => herdr.prompts.length === 1);
    herdr.dropPrompts(1);
    expect(await run).toMatchObject({ kind: 'finished' });
    expect(herdr.prompts.slice(1).map((p) => p.text)).toEqual([STATUS_NOTE_NUDGE, STATUS_NOTE_NUDGE]);
  });

  it('fails the job when its prompt never reaches Claude after three sends: it never stays running on an idle Claude', async () => {
    const { herdr, clock, executor } = setup({ turns: [DONE], dropsPrompts: 1000 }, { idleNudgeMs: 20000 });
    const out = await executor.run(contextFor(jobWith({ prompt: 'go' })).ctx);
    expect(out).toMatchObject({ kind: 'failed', error: expect.stringMatching(/^the prompt never reached claude after 3 sends/) });
    expect(herdr.prompts).toHaveLength(3);
    expect(clock.elapsed()).toBeLessThan(100000);
  });

  it('a turn saved but never sent before a daemon restart is sent again on reattach, not watched forever', async () => {
    const { herdr, executor } = setup({ turns: [DONE], dropsPrompts: 1 });
    const first = contextFor(jobWith({ prompt: 'Write hello.txt' }));
    const running = executor.run(first.ctx);
    await until(() => herdr.prompts.length === 1);
    first.ac.abort('shutdown');
    expect(await running).toEqual({ kind: 'failed', error: 'shutdown' });
    const job = jobWith({ prompt: 'Write hello.txt' }, { executorState: first.saved.at(-1) });
    expect(await executor.reattach!(contextFor(job).ctx)).toMatchObject({ kind: 'finished', result: { summary: 'Wrote hello.txt.' } });
    expect(herdr.prompts).toHaveLength(2);
    expect(herdr.prompts[1]!.text).toBe(herdr.prompts[0]!.text);
  });

  it('a turn saved before the hopper kept what it sent, and never sent, fails on reattach instead of waiting', async () => {
    const { herdr, executor } = setup({ turns: [DONE], dropsPrompts: 1 });
    const first = contextFor(jobWith({ prompt: 'go' }));
    const running = executor.run(first.ctx);
    await until(() => herdr.prompts.length === 1);
    first.ac.abort('shutdown');
    await running;
    const { turn, ...rest } = first.saved.at(-1) as { turn: { text?: string } };
    const { text: _text, ...older } = turn;
    const job = jobWith({ prompt: 'go' }, { executorState: { ...rest, turn: older } });
    expect(await executor.reattach!(contextFor(job).ctx)).toMatchObject({ kind: 'failed', error: expect.stringMatching(/^the prompt never reached claude/) });
    expect(herdr.prompts).toHaveLength(1);
  });
});
