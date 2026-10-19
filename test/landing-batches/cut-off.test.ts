// Issue #2086: a cut-off check is no test failure. A batch run or a bisect run whose check GitHub cancelled, or that
// timed out (a shard at the job's time limit), is run again at the same tip or point, at most BATCH_RERUNS times. A
// cut-off check never starts a bisect, never makes a culprit, never reverts and never files a fix issue. A failed test
// still bisects as before (red.test.ts). Fake GitHub at the LandingBatchGitHub seam.
//
// Feature: the batch runner on a cut-off check
//   Scenario: a shard cancelled at its time limit: the batch runs again at the same tip, and green promotes it
//   Scenario: a check timed out each time: the batch runs again BATCH_RERUNS times, then waits for a new merge; no bisect
//   Scenario: a bisect run cut off runs again at the same point; its real result goes on with the bisect
import { describe, expect, it } from 'vitest';
import { BATCH_RERUNS } from '../../src/domain/landing-batches.ts';
import { fail, merged, P1, P2, P3, pass, runner, world } from './red-world.ts';

/** The checks of a run with one shard cut off: the shard, and the one check to require, which fails with it. */
const cutOff = (conclusion: 'cancelled' | 'timed_out') => [
  { name: 'shard (3)', status: 'completed', conclusion, id: 31 },
  { name: 'shard (4)', status: 'completed', conclusion: 'success', id: 41 },
  { name: 'test', status: 'completed', conclusion: 'failure', id: 7 },
];

const BATCH = [
  { sha: P1, parents: ['base', 'h11'], message: 'Merge pull request #11 from owner/issue-1' },
  { sha: P2, parents: [P1, 'h12'], message: 'Merge pull request #12 from owner/issue-5' },
  { sha: P3, parents: [P2, 'h13'], message: 'Merge pull request #13 from owner/issue-6' },
];

describe('the batch runner on a cut-off check (issue #2086)', () => {
  it('a shard cancelled at its time limit: the batch runs again at the same tip, and green promotes it', async () => {
    const w = world(BATCH.map((c) => ({ ...c })), [merged(11, P1), merged(12, P2), merged(13, P3)]);
    const clock = { now: new Date('2026-10-14T12:00:00.000Z') };
    const { r, events } = runner(w, clock);
    await r.pass(); // the batch run #100 of P3
    w.checks.set(P3, cutOff('cancelled'));
    await r.pass(); // cut off: closed, with no bisect
    expect(events.map((e) => e.type)).toEqual(['landing_batch.due', 'landing_batch.started', 'landing_batch.failed']);
    expect(events[2]!.data).toMatchObject({ tip: P3, pullRequest: 100, cutOff: true, reason: 'checks cut off: shard (3)' });
    await r.pass(); // the next pass runs it again at once, the same tip
    expect(events.map((e) => e.type).slice(3)).toEqual(['landing_batch.due', 'landing_batch.started']);
    expect(events[3]!.data).toMatchObject({ tip: P3, why: 'batch run #100 was cut off: run 2 of 3' });
    expect(w.calls).toContain('close #100');
    expect(w.calls).toContain('open #101 hopper-batch/p3cccccccccc -> dev');
    w.checks.set(P3, pass);
    await r.pass();
    expect(events.at(-1)!.type).toBe('landing_batch.promoted');
    expect(events.map((e) => e.type)).not.toContain('landing_batch.bisect_started');
    expect(w.issues).toEqual([]);
  });

  it('a check timed out each time: the batch runs again BATCH_RERUNS times, then waits for a new merge; no bisect, revert or issue', async () => {
    const w = world(BATCH.map((c) => ({ ...c })), [merged(11, P1), merged(12, P2), merged(13, P3)]);
    const clock = { now: new Date('2026-10-14T12:00:00.000Z') };
    const { r, events } = runner(w, clock);
    w.checks.set(P3, cutOff('timed_out'));
    // The first run, then each run again after the one before it ended, then the end of the last one.
    for (let i = 0; i < 2 * (1 + BATCH_RERUNS); i++) await r.pass();
    const types = events.map((e) => e.type);
    expect(types.filter((t) => t === 'landing_batch.started')).toHaveLength(1 + BATCH_RERUNS);
    expect(types.filter((t) => t === 'landing_batch.failed')).toHaveLength(1 + BATCH_RERUNS);
    expect(types.filter((t) => !['landing_batch.due', 'landing_batch.started', 'landing_batch.failed'].includes(t))).toEqual([]);
    clock.now = new Date('2026-10-14T14:00:00.000Z');
    await r.pass(); // two hours on: only the merges that wait are recorded
    expect(events.map((e) => e.type).slice(types.length)).toEqual(['landing_batch.pending']);
    expect(r.view().repos[0]!.why).toBe(`the landing branch tip ${P3.slice(0, 12)} was tested already`);
    expect(w.issues).toEqual([]);
    expect(w.calls.some((c) => c.startsWith('revert'))).toBe(false);

    // A new merge: a new tip, and its batch run starts as any other.
    w.commits.push({ sha: 'p4dddddddddddddddd', parents: [P3, 'h14'], message: 'Merge pull request #14 from owner/issue-7' });
    w.tip = 'p4dddddddddddddddd';
    await r.pass();
    expect(events.at(-1)!.data).toMatchObject({ tip: w.tip });
    expect(events.at(-1)!.type).toBe('landing_batch.started');
  });

  it('a bisect run cut off runs again at the same point; its real result goes on with the bisect', async () => {
    const w = world(BATCH.map((c) => ({ ...c })), [merged(11, P1), merged(12, P2), merged(13, P3)]);
    const clock = { now: new Date('2026-10-14T12:00:00.000Z') };
    const { r, events } = runner(w, clock);
    await r.pass();
    w.checks.set(P3, fail(7));
    await r.pass(); // a real failure: the bisect starts
    expect(events.at(-1)!.type).toBe('landing_batch.bisect_started');
    await r.pass(); // a bisect run of P2
    w.checks.set(P2, cutOff('cancelled'));
    await r.pass(); // cut off: recorded, and the bisect goes on
    expect(events.at(-1)!.data).toMatchObject({ index: 1, sha: P2, outcome: 'unknown', cutOff: true, reason: 'checks cut off: shard (3)' });
    expect(r.view().repos[0]!.state.bisect).toBeDefined();
    await r.pass(); // P2 again
    expect(events.at(-1)!.type).toBe('landing_batch.bisect_run');
    expect(events.at(-1)!.data).toMatchObject({ index: 1, sha: P2 });
    w.checks.set(P2, pass);
    await r.pass();
    expect(events.at(-1)!.data).toMatchObject({ index: 1, sha: P2, outcome: 'good' });
    await r.pass(); // the culprit: P3, #13
    expect(events.map((e) => e.type)).toContain('landing_batch.culprit');
    expect(events.find((e) => e.type === 'landing_batch.culprit')!.data).toMatchObject({ sha: P3, pullRequest: 13 });
  });

  it('a bisect run cut off more than BATCH_RERUNS times ends the bisect, with no culprit', async () => {
    const w = world(BATCH.map((c) => ({ ...c })), [merged(11, P1), merged(12, P2), merged(13, P3)]);
    const clock = { now: new Date('2026-10-14T12:00:00.000Z') };
    const { r, events } = runner(w, clock);
    await r.pass();
    w.checks.set(P3, fail(7));
    await r.pass();
    w.checks.set(P2, cutOff('timed_out'));
    for (let i = 0; i < 2 * (1 + BATCH_RERUNS); i++) await r.pass();
    expect(events.filter((e) => e.type === 'landing_batch.bisect_run')).toHaveLength(1 + BATCH_RERUNS);
    expect(r.view().repos[0]!.state.bisect).toBeUndefined();
    expect(r.view().repos[0]!.state.bisectEnded).toMatchObject({ reason: 'checks cut off: shard (3)' });
    await r.pass();
    expect(events.map((e) => e.type)).not.toContain('landing_batch.culprit');
    expect(w.issues).toEqual([]);
  });
});
