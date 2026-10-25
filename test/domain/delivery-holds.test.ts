// The delivery hold's effect (issue #2775 part 7, design.md "Part 6: interventions and the delivery hold"), pure: which
// jobs a hold holds, read from the hold and release events, what the step's owner says while it waits, and the cut of a
// batch run at the first held change.
//
// Feature: the step's owner does not act on a held change
//   Scenario: a job's last hold or release says whether its change is held, in any order of its events
//   Scenario: the wait says that the delivery is held, who owns it, since when and why, and names no person
//   Scenario: the pull requests of one repository a hold holds, by number
//   Scenario: a batch run takes the landing branch up to the first held merge; nothing held, no cut
import { describe, expect, it } from 'vitest';
import { heldCut, heldJobs, heldNumbers, holdWhy } from '../../src/domain/track-interventions.ts';
import type { DomainEvent, EventType } from '../../src/domain/types.ts';

let seq = 0;
const ev = (type: EventType, jobId: string, data: Record<string, unknown>, s = ++seq): DomainEvent =>
  ({ seq: s, schemaVersion: 1, id: `e${s}`, type, at: `2026-10-25T10:${String(s).padStart(2, '0')}:00.000Z`, data, jobId });
const held = (jobId: string, owner = 'hopper', s?: number) => ev('delivery_track.held', jobId, { by: 'ana', step: 'landing_checks', owner, reason: 'wait for the release notes' }, s);
const released = (jobId: string, s?: number) => ev('delivery_track.released', jobId, { by: 'ana', step: 'landing_checks' }, s);

describe('the delivery hold holds a change (issue #2775 part 7)', () => {
  it("a job's last hold or release says whether its change is held, in any order of its events", () => {
    const holds = heldJobs([released('a', 30), held('a', 'hopper', 20), held('b', 'person', 21), released('c', 23), held('c', 'hopper', 22)].reverse());
    expect([...holds.keys()]).toEqual(['b']);
    expect(holds.get('b')).toMatchObject({ owner: 'person', step: 'landing_checks', reason: 'wait for the release notes' });
    expect(heldJobs([ev('job.parked', 'd', { by: 'ana', from: 'running', via: 'ui' })]).size).toBe(0);
  });

  it('the wait says that the delivery is held, who owns it, since when and why, and names no person', () => {
    const [h] = heldJobs([held('a', 'person')]).values();
    const why = holdWhy(h!);
    expect(why).toMatch(/^its delivery is held: a person took ownership of it at landing_checks since 2026-10-25T10:\d\d:00\.000Z \(wait for the release notes\); a release lets it go on$/);
    expect(why).not.toContain('ana');
    const [p] = heldJobs([ev('delivery_track.held', 'b', { by: 'ana', step: 'pr_checks', owner: 'hopper' })]).values();
    expect(holdWhy(p!)).toMatch(/^its delivery is held: paused at pr_checks since .*; a release lets it go on$/);
  });

  it('the pull requests of one repository a hold holds, by number', () => {
    expect([...heldNumbers(['https://github.com/Octo/Shed/pull/12', 'https://github.com/octo/other/pull/13', 'https://github.com/octo/shed/pull/14', 'not a url'], 'octo/shed')])
      .toEqual([12, 14]);
  });

  it('a batch run takes the landing branch up to the first held merge; nothing held, no cut', () => {
    const commits = [
      { sha: 'a1', parents: ['p'], message: 'a commit of #14' },
      { sha: 'm12', parents: ['base', 'x'], message: 'Merge pull request #12 from octo/issue-1' },
      { sha: 'm14', parents: ['m12', 'a1'], message: 'Merge pull request #14 from octo/issue-2' },
      { sha: 'm16', parents: ['m14', 'y'], message: 'Merge pull request #16 from octo/issue-3' },
    ];
    expect(heldCut(commits, new Set([16, 14]))).toEqual({ pullRequest: 14, tip: 'm12' });
    expect(heldCut(commits, new Set([12]))).toEqual({ pullRequest: 12, tip: 'base' });
    expect(heldCut(commits, new Set())).toBeUndefined();
    expect(heldCut(commits, new Set([99]))).toBeUndefined();
  });
});
