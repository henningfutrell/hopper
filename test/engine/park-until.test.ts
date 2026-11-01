// Issue #2890: whether a park condition holds, with fakes at the seams: the job's source reads the item, as for a wait check,
// and the store gives the job it names. No database.
import { describe, expect, it } from 'vitest';
import type { Job } from '../../src/domain/types.ts';
import type { WatchedEnd, WatchedRef } from '../../src/domain/watched-items.ts';
import { untilBrief, untilOutcome } from '../../src/engine/park-until.ts';

const NOW = Date.parse('2026-10-31T12:00:00.000Z');
const parked = { id: 'p1', status: 'parked' } as Job;
const reads = (ended: WatchedEnd[] | undefined, asked: WatchedRef[][] = []) => ({ async endedWatched(_j: Job, refs: WatchedRef[]) { asked.push(refs); return ended; } });
const PR6 = { kind: 'issue' as const, repo: 'octo/supersearch', number: 6 };

describe('a park condition (issue #2890)', () => {
  it('an issue or a pull request: holds once its source reads it ended, merged or closed', async () => {
    const asked: WatchedRef[][] = [];
    const until = { kind: 'item' as const, repo: 'octo/supersearch', number: 6 };
    expect(await untilOutcome(parked, until, { reads: reads([], asked), jobOf: () => undefined, nowMs: NOW })).toEqual({ held: false, result: 'octo/supersearch#6 is open' });
    expect(asked).toEqual([[PR6]]);
    const merged = [{ ref: PR6, url: 'https://github.com/octo/supersearch/pull/6', state: 'merged' }];
    expect(await untilOutcome(parked, until, { reads: reads(merged), jobOf: () => undefined, nowMs: NOW })).toEqual({ held: true, fired: 'https://github.com/octo/supersearch/pull/6 was merged' });
  });

  it('an item it cannot read, or that does not exist, never holds', async () => {
    const until = { kind: 'item' as const, repo: 'octo/supersearch', number: 6 };
    expect(await untilOutcome(parked, until, { reads: reads(undefined), jobOf: () => undefined, nowMs: NOW })).toMatchObject({ held: false });
    expect(await untilOutcome(parked, until, { jobOf: () => undefined, nowMs: NOW })).toMatchObject({ held: false });
    const missing = [{ ref: PR6, url: 'https://github.com/octo/supersearch/issues/6', state: 'not_found' }];
    expect(await untilOutcome(parked, until, { reads: reads(missing), jobOf: () => undefined, nowMs: NOW })).toEqual({ held: false, result: 'octo/supersearch#6 cannot be read' });
  });

  it('a job: holds once it ended, or is gone', async () => {
    const until = { kind: 'job' as const, jobId: 'j2' };
    const of = (status: Job['status']) => () => ({ id: 'j2', status }) as Job;
    expect(await untilOutcome(parked, until, { jobOf: of('running'), nowMs: NOW })).toEqual({ held: false, result: 'job j2 is running' });
    expect(await untilOutcome(parked, until, { jobOf: of('finished'), nowMs: NOW })).toEqual({ held: true, fired: 'job j2 finished' });
    expect(await untilOutcome(parked, until, { jobOf: () => undefined, nowMs: NOW })).toEqual({ held: true, fired: 'job j2 is gone' });
  });

  it('a time: holds once it passed', async () => {
    const until = { kind: 'time' as const, at: '2026-10-31T13:00:00.000Z' };
    expect(await untilOutcome(parked, until, { jobOf: () => undefined, nowMs: NOW })).toMatchObject({ held: false });
    expect(await untilOutcome(parked, until, { jobOf: () => undefined, nowMs: NOW + 3600_000 })).toEqual({ held: true, fired: 'the time 2026-10-31T13:00:00.000Z passed' });
  });

  it('the job picked up is told why it resumes', () => {
    expect(untilBrief({ kind: 'item', repo: 'octo/supersearch', number: 6 }, 'https://github.com/octo/supersearch/pull/6 was merged'))
      .toBe('This job was parked until octo/supersearch#6 closes or merges. That happened: https://github.com/octo/supersearch/pull/6 was merged. It is resumed now, in the same session and work tree. Check what changed, then go on with it where you left off.');
  });
});
