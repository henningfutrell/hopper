// How the work after a person's act spent its time (issue #1194): the wait on its queue apart from its run, per act.
import { describe, expect, it } from 'vitest';
import { actOf, createAfterAnswerTimings, withAct, SAMPLES } from '../../src/sources/after-answer-timings.ts';

describe('after-answer timings (issue #1194)', () => {
  it('keeps the wait apart from the run, per act, with p50, p95 and max', () => {
    const t = createAfterAnswerTimings(() => new Date('2026-10-15T00:00:00Z'));
    for (let i = 1; i <= 20; i++) t.record('rerun', i, i * 10);
    t.record('merge', 5000, 2000);
    expect(t.summary()).toEqual([
      { act: 'merge', count: 1, waitMs: { p50: 5000, p95: 5000, max: 5000 }, runMs: { p50: 2000, p95: 2000, max: 2000 }, lastAt: '2026-10-15T00:00:00.000Z' },
      { act: 'rerun', count: 20, waitMs: { p50: 10, p95: 19, max: 20 }, runMs: { p50: 100, p95: 190, max: 200 }, lastAt: '2026-10-15T00:00:00.000Z' },
    ]);
  });

  it('keeps only the last samples of each act, and counts every one', () => {
    const t = createAfterAnswerTimings(() => new Date());
    for (let i = 0; i < SAMPLES + 10; i++) t.record('sync:approve', i < 10 ? 100_000 : 1, 1);
    expect(t.summary()[0]).toMatchObject({ act: 'sync:approve', count: SAMPLES + 10, waitMs: { max: 1 } });
  });

  it('names the act of the work started inside withAct, through awaits', async () => {
    expect(actOf()).toBeUndefined();
    const seen = await withAct('retry', async () => {
      await new Promise((r) => setTimeout(r, 1));
      return actOf();
    });
    expect(seen).toBe('retry');
    expect(actOf()).toBeUndefined();
  });
});
