// Issue #1073 part 2: the batch runner on a red batch. A batch run whose checks fail starts a bisect within the batch;
// each pass takes one step: a bisect run of one point, read and closed; the culprit found; GitHub's revert of its pull
// request opened on the landing branch, then merged; a fix issue filed with the hopper label and assigned to the user,
// so Intake takes it; then a batch run of the landing branch with the culprit reverted, which promotes the rest. Fake
// GitHub at the LandingBatchGitHub seam.
//
// Feature: the batch runner on a red batch
//   Scenario: a red batch of three pull requests: bisect, culprit, revert, fix issue, and the rest promoted
//   Scenario: a red batch of one direct commit: the culprit at once, no revert, a fix issue that says why
//   Scenario: a bisect run with no check in time ends the bisect, with no culprit and no issue
//   Scenario: a red batch with no failing check (merge conflicts) starts no bisect
//   Scenario: merge conflicts: the tested branch is merged into the landing branch, and the batch runs again at once (part 4)
//   Scenario: a real conflict: one issue is filed, so Intake takes it; a later conflict files none (part 4)
import { describe, expect, it } from 'vitest';
import { fail, merged, P1, P2, P3, pass, runner, world } from './red-world.ts';

describe('the batch runner on a red batch (issue #1073)', () => {
  it('bisects, finds the culprit, reverts it, files a fix issue, and promotes the rest', async () => {
    const w = world([
      { sha: P1, parents: ['base', 'h11'], message: 'Merge pull request #11 from owner/issue-1' },
      { sha: P2, parents: [P1, 'h12'], message: 'Merge pull request #12 from owner/issue-5' },
      { sha: P3, parents: [P2, 'h13'], message: 'Merge pull request #13 from owner/issue-6' },
    ], [merged(11, P1, 'Closes #4'), merged(12, P2, 'Closes #5'), merged(13, P3, 'Closes #6')]);
    const clock = { now: new Date('2026-10-14T12:00:00.000Z') };
    const { r, events } = runner(w, clock);
    const types = (): string[] => events.map((e) => e.type);

    await r.pass(); // the batch run #100 of P3
    w.checks.set(P3, fail(7));
    await r.pass(); // red: closed, and a bisect of three points starts
    expect(types()).toEqual(['landing_batch.due', 'landing_batch.started', 'landing_batch.failed', 'landing_batch.bisect_started']);
    expect(events[3]!.data).toMatchObject({ tip: P3, points: [{ sha: P1, pullRequest: 11 }, { sha: P2, pullRequest: 12 }, { sha: P3, pullRequest: 13 }], checks: [{ name: 'test', id: 7 }] });

    await r.pass(); // a bisect run of the middle point
    expect(w.calls.slice(-2)).toEqual([`branch hopper-batch/bisect-${P2.slice(0, 12)} ${P2}`, `open #101 hopper-batch/bisect-${P2.slice(0, 12)} -> dev`]);
    await r.pass(); // its checks are pending
    expect(types().at(-1)).toBe('landing_batch.bisect_run');
    w.checks.set(P2, fail(9));
    w.logs.set(9, 'FAIL test/a.test.ts\nexpected 1 to be 2');
    await r.pass(); // P2 fails
    expect(w.calls.slice(-2)).toEqual([`delete hopper-batch/bisect-${P2.slice(0, 12)}`, 'close #101']);
    expect(events.at(-1)!.data).toMatchObject({ index: 1, sha: P2, outcome: 'bad', checks: [{ name: 'test', id: 9 }] });

    await r.pass(); // a bisect run of P1
    w.checks.set(P1, pass);
    await r.pass(); // P1 passes
    expect(events.at(-1)!.data).toMatchObject({ index: 0, sha: P1, outcome: 'good' });

    await r.pass(); // the culprit: P2, #12; its revert opened; the fix issue filed
    expect(types().slice(-3)).toEqual(['landing_batch.culprit', 'landing_batch.revert_opened', 'landing_batch.fix_filed']);
    expect(events.at(-3)!.data).toMatchObject({ tip: P3, sha: P2, pullRequest: 12, checks: [{ name: 'test', id: 9 }] });
    expect(w.calls).toContain('revert #12 as #103: Revert #12: it fails the full test suite');
    expect(w.issues).toHaveLength(1);
    expect(w.issues[0]).toMatchObject({ title: 'Fix the full test suite after #12', labels: ['hopper'], assignees: ['me'] });
    expect(w.issues[0]!.body).toContain('#5');
    expect(w.issues[0]!.body).toContain('#103');
    expect(w.issues[0]!.body).toContain('expected 1 to be 2');

    await r.pass(); // the revert merged into main; a batch run of the new tip starts at once
    expect(types().slice(-3)).toEqual(['landing_batch.reverted', 'landing_batch.due', 'landing_batch.started']);
    expect(events.at(-1)!.data).toMatchObject({ why: 'the culprit #12 was reverted', tip: w.tip });
    w.checks.set(w.tip, pass);
    await r.pass(); // green: the rest of the batch reaches dev
    expect(types().at(-1)).toBe('landing_batch.promoted');
    await r.pass();
    expect(w.issues).toHaveLength(1);
    expect(r.view().repos[0]!.state.culprit).toMatchObject({ sha: P2, revert: { state: 'merged' }, fix: { issue: 901 } });
  });

  it('a red batch of one direct commit: the culprit at once, no revert, and a fix issue that says why', async () => {
    const w = world([{ sha: P1, parents: ['base'], message: 'Fix a typo' }]);
    const clock = { now: new Date('2026-10-14T12:00:00.000Z') };
    const { r, events } = runner(w, clock);
    await r.pass();
    w.checks.set(P1, fail(7));
    await r.pass();
    expect(events.map((e) => e.type)).toEqual(['landing_batch.due', 'landing_batch.started', 'landing_batch.failed', 'landing_batch.culprit']);
    await r.pass();
    expect(events.map((e) => e.type).slice(-2)).toEqual(['landing_batch.revert_failed', 'landing_batch.fix_filed']);
    expect(w.issues[0]!.title).toBe(`Fix the full test suite after ${P1.slice(0, 12)}`);
    expect(w.issues[0]!.body).toContain('a direct commit');
    expect(w.issues[0]!.body).toContain('no output could be read');
  });

  it('a bisect run with no check in time ends the bisect, with no culprit and no issue', async () => {
    const w = world([
      { sha: P1, parents: ['base', 'h11'], message: 'Merge pull request #11 from owner/issue-1' },
      { sha: P2, parents: [P1, 'h12'], message: 'Merge pull request #12 from owner/issue-5' },
    ], [merged(11, P1), merged(12, P2)]);
    const clock = { now: new Date('2026-10-14T12:00:00.000Z') };
    const { r, events } = runner(w, clock);
    await r.pass();
    w.checks.set(P2, fail(7));
    await r.pass();
    await r.pass(); // a bisect run of P1
    clock.now = new Date('2026-10-14T12:31:00.000Z');
    await r.pass();
    expect(events.at(-1)!.type).toBe('landing_batch.bisect_tested');
    expect(events.at(-1)!.data).toMatchObject({ outcome: 'unknown', reason: 'no check ran in 30 minutes' });
    await r.pass();
    expect(w.issues).toEqual([]);
    expect(r.view().repos[0]!.state.bisectEnded).toMatchObject({ reason: 'no check ran in 30 minutes' });
  });

  it('a red batch with no failing check (merge conflicts) starts no bisect', async () => {
    const w = world([{ sha: P1, parents: ['base', 'h11'], message: 'Merge pull request #11 from owner/issue-1' }, { sha: P2, parents: [P1, 'h12'], message: 'Merge pull request #12 from owner/issue-5' }]);
    const clock = { now: new Date('2026-10-14T12:00:00.000Z') };
    const { r, events } = runner(w, clock);
    await r.pass();
    w.pulls.get(100)!.mergeable = false;
    await r.pass();
    // A back-merge in its place (part 4).
    expect(events.map((e) => e.type)).toEqual(['landing_batch.due', 'landing_batch.started', 'landing_batch.failed', 'landing_batch.back_merge_opened']);
  });

  it('merge conflicts: the tested branch is merged into the landing branch, and the batch runs again at once', async () => {
    const w = world([{ sha: P1, parents: ['base', 'h11'], message: 'Merge pull request #11 from owner/issue-1' }, { sha: P2, parents: [P1, 'h12'], message: 'Merge pull request #12 from owner/issue-5' }]);
    const clock = { now: new Date('2026-10-14T12:00:00.000Z') };
    const { r, events } = runner(w, clock);
    await r.pass();
    w.pulls.get(100)!.mergeable = false;
    await r.pass(); // red: closed; dev merged into a branch at the tip, and a pull request of it into main
    const branch = `hopper-batch/back-merge-${P2.slice(0, 12)}`;
    expect(events.map((e) => e.type)).toEqual(['landing_batch.due', 'landing_batch.started', 'landing_batch.failed', 'landing_batch.back_merge_opened']);
    expect(w.calls.slice(-3)).toEqual([`branch ${branch} ${P2}`, `merge dev into ${branch}: merged`, `open #101 ${branch} -> main`]);
    expect(events.at(-1)!.data).toMatchObject({ tip: P2, batch: 100, branch, merge: 'backmerge0000000', pullRequest: 101 });
    expect(w.pulls.get(101)!.body).toContain('#100');

    await r.pass(); // merged into main; the next batch run starts at once
    expect(w.calls).toContain('merge #101 backmerge0000000');
    expect(w.calls).toContain(`delete ${branch}`);
    expect(events.map((e) => e.type).slice(-3)).toEqual(['landing_batch.back_merged', 'landing_batch.due', 'landing_batch.started']);
    expect(events.at(-1)!.data).toMatchObject({ why: 'dev was merged into the landing branch', tip: w.tip });
    w.checks.set(w.tip, pass);
    await r.pass();
    expect(events.at(-1)!.type).toBe('landing_batch.promoted');
    expect(w.issues).toEqual([]);
  });

  it('a real conflict: one issue is filed, so Intake takes it; a later conflict files none', async () => {
    const w = world([{ sha: P1, parents: ['base', 'h11'], message: 'Merge pull request #11 from owner/issue-1' }]);
    w.backMerge = 'conflict';
    const clock = { now: new Date('2026-10-14T12:00:00.000Z') };
    const { r, events } = runner(w, clock);
    await r.pass();
    w.pulls.get(100)!.mergeable = false;
    await r.pass();
    expect(events.map((e) => e.type)).toEqual(['landing_batch.due', 'landing_batch.started', 'landing_batch.failed', 'landing_batch.back_merge_failed', 'landing_batch.back_merge_issue_filed']);
    expect(events[3]!.data).toMatchObject({ tip: P1, batch: 100, conflict: true });
    expect(w.calls).toContain(`delete hopper-batch/back-merge-${P1.slice(0, 12)}`);
    expect(w.issues).toHaveLength(1);
    expect(w.issues[0]).toMatchObject({ title: 'Resolve the merge conflicts of dev with main', labels: ['hopper'], assignees: ['me'] });
    expect(r.view().repos[0]!.state.backMergeIssue).toMatchObject({ issue: 901 });

    // A new merge, and its batch run has the same conflicts: no second issue.
    w.commits.push({ sha: P2, parents: [P1, 'h12'], message: 'Merge pull request #12 from owner/issue-5' });
    w.tip = P2;
    clock.now = new Date('2026-10-14T13:01:00.000Z');
    await r.pass();
    w.pulls.get(101)!.mergeable = false;
    await r.pass();
    expect(events.map((e) => e.type).slice(-4)).toEqual(['landing_batch.due', 'landing_batch.started', 'landing_batch.failed', 'landing_batch.back_merge_failed']);
    expect(w.issues).toHaveLength(1);
  });
});
