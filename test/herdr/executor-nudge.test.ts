import { describe, expect, it } from 'vitest';
import { STATUS_NOTE_NUDGE } from '../../src/executors/herdr/index.ts';
import { contextFor, jobWith, setup, until } from './support.ts';

// Issue #491: a nudge is a paid turn. A job that waits on its own background work is not nudged, and the
// nudges in a row come further apart, then stop.

const DONE = { output: ['● Wrote hello.txt.', '  HOPPER_DONE'] };
const NOTE = { output: ['● Still waiting for write access.'] };
const HOUR = 3600000;
const MINUTE = 60000;

/** The fake clock's time at each send to the job. */
function sendTimes(s: ReturnType<typeof setup>): number[] {
  const times: number[] = [];
  const prompt = s.herdr.prompt.bind(s.herdr);
  s.herdr.prompt = (name, text) => { times.push(s.clock.elapsed()); return prompt(name, text); };
  return times;
}

describe('herdr-claude executor: nudges', () => {
  it('sends no nudge while the job waits on background work it started; the work ending wakes the job, which goes on', async () => {
    const waiting = { output: ['● Started a background poll for write access; it will tell me when it is granted.'], background: { work: '1 shell', polls: HOUR / 1000 } };
    const { herdr, clock, executor } = setup({ turns: [waiting, DONE] }, { idleNudgeMs: 20000 });
    const { ctx, progress } = contextFor(jobWith({ prompt: 'go', timeoutMs: 3 * HOUR }));
    expect(await executor.run(ctx)).toMatchObject({ kind: 'finished', result: { summary: 'Wrote hello.txt.' } });
    expect(herdr.prompts.map((p) => p.text)).toEqual([expect.stringContaining('go')]);
    expect(clock.elapsed()).toBeGreaterThanOrEqual(HOUR);
    expect(progress.map((p) => p.message).filter((m) => m?.startsWith('waiting on background work'))).toEqual([
      'waiting on background work (1 shell): no nudge while it runs',
    ]);
  });

  it('nudges a job whose background work ended without waking it', async () => {
    const waiting = { output: ['● Waiting for the poll.'], background: { work: '1 shell', polls: 600, wakes: false } };
    const { herdr, executor } = setup({ turns: [waiting, DONE] }, { idleNudgeMs: 20000 });
    expect(await executor.run(contextFor(jobWith({ prompt: 'go', timeoutMs: HOUR })).ctx)).toMatchObject({ kind: 'finished' });
    expect(herdr.prompts.slice(1).map((p) => p.text)).toEqual([STATUS_NOTE_NUDGE]);
  });

  it('nudges in a row after idleNudgeMs, then 1, 5, 15 and 30 minutes, then no more: the job shows as waiting until it times out', async () => {
    const s = setup({ turns: [NOTE, NOTE, NOTE, NOTE, NOTE, NOTE, NOTE] }, { idleNudgeMs: 20000 });
    const times = sendTimes(s);
    const { ctx, progress } = contextFor(jobWith({ prompt: 'go', timeoutMs: 4 * HOUR }));
    expect(await s.executor.run(ctx)).toMatchObject({ kind: 'failed', error: 'timed out' });
    expect(s.herdr.prompts.slice(1).map((p) => p.text)).toEqual(Array(5).fill(STATUS_NOTE_NUDGE));
    const gaps = times.slice(1).map((t, i) => t - times[i]!);
    [20000, MINUTE, 5 * MINUTE, 15 * MINUTE, 30 * MINUTE].forEach((gap, i) => {
      expect(gaps[i]).toBeGreaterThanOrEqual(gap);
      expect(gaps[i]).toBeLessThan(gap + 10000);
    });
    expect(progress.map((p) => p.message)).toContain('waiting: 6 status notes in a row without a marker; no more nudges until claude works again');
  });

  it('a job that works again by itself after the nudges stopped starts a new row of nudges', async () => {
    const s = setup({ turns: [NOTE, NOTE, NOTE, NOTE, NOTE, NOTE, NOTE, DONE] }, { idleNudgeMs: 20000 });
    const run = s.executor.run(contextFor(jobWith({ prompt: 'go', timeoutMs: 4 * HOUR })).ctx);
    await until(() => s.herdr.prompts.length === 6, 100000);
    const capped = s.clock.elapsed();
    await until(() => s.clock.elapsed() > capped + HOUR, 100000);
    expect(s.herdr.prompts).toHaveLength(6);
    s.herdr.wake(s.herdr.agentStarts[0]!.name);
    expect(await run).toMatchObject({ kind: 'finished' });
    expect(s.herdr.prompts.slice(6).map((p) => p.text)).toEqual([STATUS_NOTE_NUDGE]);
  });
});
