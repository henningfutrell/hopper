// Kept delivery tracks (issue #2775, design.md "Kept delivery tracks"), pure: each job's track folded from its events, the
// step it is in and what it waits on, and the one deployment record it closes with.
//
// Feature: a job's kept track and its deployment record
//   Scenario: a job queued has a track at once, in `queued`, waiting on a lane
//   Scenario: every step it starts and ends is a transition on its track
//   Scenario: a fix merged on the landing branch but not promoted is open in `landing_checks`, not done
//   Scenario: a change promoted, in a repository with no promotion set schedule, waits on one and stays open
//   Scenario: a change past production closes with a `deploy` record: its pull request, its target and each hop
//   Scenario: a research job closes with a `none` record that carries its source and outcome
//   Scenario: a failed job, or a pull request closed with no merge, closes with a `none` record
//   Scenario: a person's no-deploy mark closes an open track with a none record, which stays open to a flip
//   Scenario: the expectation flips any number of times before the deployment completes; each flip is kept, in order
//   Scenario: a none record flipped to deploy reopens the track; it locks once that deployment completes
//   Scenario: a completed deployment locks the record, whatever a person said before; a locked track stays as it was
//   Scenario: the same events folded again change nothing; folded in two halves give the same track
import { describe, expect, it } from 'vitest';
import { expectOf, foldTrackEvents, lockedOf, trackOf, type TrackContext, type TrackMarks } from '../../src/domain/kept-tracks.ts';
import type { PromotionSetSchedule } from '../../src/domain/promotion-sets.ts';
import type { DomainEvent, EventType } from '../../src/domain/types.ts';

let seq = 0;
const at = (hhmm: string) => `2026-10-20T${hhmm}:00.000Z`;
const ev = (type: EventType, hhmm: string, data: Record<string, unknown>, jobId?: string): DomainEvent =>
  ({ seq: ++seq, schemaVersion: 1, id: `e${seq}`, type, at: at(hhmm), data, ...(jobId ? { jobId } : {}) });
const queued = (jobId: string, hhmm: string, number = 7) =>
  ev('job.queued', hhmm, { spec: {}, priority: 50, source: { source: 'github', kind: 'issue', key: 'k', repo: 'Octo/Shed', number } }, jobId);
const PR = 'https://github.com/octo/shed/pull/12';

const merged = (jobId: string) => [
  queued(jobId, '08:00'),
  ev('job.started', '08:05', { attempts: 1 }, jobId),
  ev('github_proxy.done', '08:40', { op: 'pr.create', repo: 'octo/shed', url: PR }, jobId),
  ev('job.finished', '09:00', { result: {} }, jobId),
  ev('job.pull_request_merged', '09:20', { pullRequest: PR, part: false }, jobId),
];
const batch = () => [
  ev('landing_batch.started', '09:30', { repo: 'octo/shed', pullRequest: 900, merges: [11, 12] }),
  ev('landing_batch.promoted', '10:30', { repo: 'octo/shed', pullRequest: 900 }),
];

const ctx = (c: Partial<TrackContext> = {}): TrackContext => ({ now: at('12:00'), delivery: { gates: {} }, cleared: {}, job: { status: 'finished' }, ...c });
const fold = (events: DomainEvent[], marks = new Map<string, TrackMarks>()) => { foldTrackEvents(marks, events); return marks; };

/** Each day at 11:00 UTC; test gate an hour after, production an hour after that. */
const schedule: PromotionSetSchedule = {
  timeZone: 'UTC', cutoffs: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, time: '11:00' })), testGateAfterMinutes: 60,
  productionAfterMinutes: 60, epoch: '2026-10-01T00:00:00.000Z', expedite: 'none',
};

describe('kept delivery tracks', () => {
  it('a job queued has a track at once, in queued, waiting on a lane', () => {
    const marks = fold([queued('j', '08:00')]);
    const t = trackOf('j', marks.get('j')!, ctx({ job: { status: 'queued' } }));
    expect(t).toMatchObject({ jobId: 'j', repo: 'octo/shed', issue: 'octo/shed#7', state: 'open', steps: [{ step: 'queued', start: at('08:00') }] });
    expect(t.current).toEqual({ step: 'queued', since: at('08:00'), blocker: 'queue', waitingOn: 'a lane to start the job' });
  });

  it('every step it starts and ends is a transition; merged but not promoted stays open in landing_checks', () => {
    const t = trackOf('j', fold(merged('j')).get('j')!, ctx());
    expect(t.steps).toEqual([
      { step: 'queued', start: at('08:00'), end: at('08:05') },
      { step: 'coding', start: at('08:05'), end: at('09:00') },
      { step: 'pr_checks', start: at('09:00'), end: at('09:20') },
      { step: 'landing', start: at('09:20'), end: at('09:20') },
      { step: 'landing_checks', start: at('09:20') },
    ]);
    expect(t).toMatchObject({ state: 'open', pullRequest: PR, current: { step: 'landing_checks', since: at('09:20'), blocker: 'ci_red' } });
    expect(t.current.waitingOn).toMatch(/landing branch/);
    expect(t.deployment).toBeUndefined();
  });

  it('promoted, in a repository with no promotion set schedule: open in promotion_set, waiting on a schedule', () => {
    const t = trackOf('j', fold([...merged('j'), ...batch()]).get('j')!, ctx());
    expect(t).toMatchObject({ state: 'open', current: { step: 'promotion_set', since: at('10:30'), blocker: 'queue' } });
    expect(t.current.waitingOn).toMatch(/no(ne)? .*schedule|schedule.*none/);
  });

  it('past production: closes with a deploy record of its pull request, target and every hop', () => {
    const marks = fold([...merged('j'), ...batch()]).get('j')!;
    const before = trackOf('j', marks, ctx({ now: at('11:30'), delivery: { schedule, gates: {} } }));
    expect(before).toMatchObject({ state: 'open', current: { step: 'test_gate', since: at('11:00') } });
    const t = trackOf('j', marks, ctx({ now: at('13:30'), delivery: { schedule, gates: {} } }), before);
    expect(t).toMatchObject({ state: 'closed', closedAt: at('13:00') });
    expect(t.deployment).toEqual({
      jobId: 'j', repo: 'octo/shed', at: at('13:00'), kind: 'deploy', artifact: { pullRequest: PR }, target: 'production', expected: 'delivered',
      observed: [...t.steps],
    });
    expect(t.steps.map((s) => [s.step, s.end])).toEqual([
      ['queued', at('08:05')], ['coding', at('09:00')], ['pr_checks', at('09:20')], ['landing', at('09:20')], ['landing_checks', at('10:30')],
      ['promotion_set', at('11:00')], ['test_gate', at('12:00')], ['production', at('13:00')],
    ]);
  });

  it('a gated step waits on its owner', () => {
    const marks = fold([...merged('j'), ...batch()]).get('j')!;
    const t = trackOf('j', marks, ctx({ now: at('13:30'), delivery: { schedule, gates: { production: { owner: 'release-owner' } } } }));
    expect(t).toMatchObject({ state: 'open', current: { step: 'production', blocker: 'human_gate', waitingOn: 'a gate clearance by release-owner' } });
  });

  it('a research job closes with a none record that carries its source and outcome', () => {
    const marks = fold([queued('r', '08:00'), ev('job.started', '08:01', { attempts: 1 }, 'r'), ev('job.finished', '08:30', { result: {} }, 'r')]);
    const t = trackOf('r', marks.get('r')!, ctx({ job: { status: 'finished', researchId: 'q1' } }));
    expect(t).toMatchObject({ state: 'closed', closedAt: at('08:30') });
    expect(t.deployment).toEqual({ jobId: 'r', repo: 'octo/shed', at: at('08:30'), kind: 'none', source: 'octo/shed#7', outcome: { status: 'finished', report: 'research' } });
  });

  it('a direct job with no issue: its source is its source name', () => {
    const e = ev('job.queued', '08:00', { spec: {}, priority: 50, source: { source: 'direct', kind: 'direct', key: 'd1' } }, 'd');
    const t = trackOf('d', fold([e, ev('job.finished', '08:10', { result: {} }, 'd')]).get('d')!, ctx());
    expect(t.deployment).toMatchObject({ kind: 'none', source: 'direct', outcome: { status: 'finished' } });
  });

  it('a failed job, or a pull request closed with no merge, closes with a none record', () => {
    const failed = trackOf('f', fold([queued('f', '08:00')]).get('f')!, ctx({ job: { status: 'failed' } }));
    expect(failed.deployment).toMatchObject({ kind: 'none', at: at('12:00'), outcome: { status: 'failed' } });
    const closed = fold([...merged('c').slice(0, 4), ev('job.pull_request_closed', '09:40', { pullRequest: PR, part: false, superseded: 'its base has every commit' }, 'c')]);
    const t = trackOf('c', closed.get('c')!, ctx());
    expect(t.deployment).toMatchObject({ kind: 'none', at: at('09:40'), outcome: { status: 'pull_request_closed', note: 'its base has every commit' } });
    // A finished job whose pull request is open is not closed: its change is still on its way.
    expect(trackOf('m', fold(merged('m').slice(0, 4)).get('m')!, ctx()).state).toBe('open');
  });

  it('a person\'s no-deploy mark closes an open track with a none record, which stays open to a flip', () => {
    const marks = fold([...merged('j'), ...batch()]).get('j')!;
    const t = expectOf(trackOf('j', marks, ctx()), { expect: 'none', by: 'owner', at: at('11:00'), note: 'not deployed anywhere' });
    expect(t).toMatchObject({ state: 'closed', closedAt: at('11:00'), expectations: [{ expect: 'none', by: 'owner', at: at('11:00'), note: 'not deployed anywhere' }] });
    expect(t.deployment).toMatchObject({ kind: 'none', at: at('11:00'), outcome: { status: 'marked', by: 'owner', note: 'not deployed anywhere' }, expectations: t.expectations });
    expect(lockedOf(t)).toBe(false);
    // The pass leaves a closed none track as it was: only a person's flip opens it again.
    expect(trackOf('j', marks, ctx({ now: at('23:00'), delivery: { schedule, gates: {} } }), t)).toBe(t);
  });

  it('the expectation flips any number of times before the deployment completes; each flip is kept, in order', () => {
    const marks = fold(merged('j')).get('j')!;
    let t = trackOf('j', marks, ctx());
    t = expectOf(t, { expect: 'deploy', by: 'a', at: at('10:00') });
    expect(t).toMatchObject({ state: 'open' });
    expect(t.deployment).toBeUndefined();
    t = expectOf(t, { expect: 'none', by: 'b', at: at('10:10') });
    t = expectOf(t, { expect: 'deploy', by: 'a', at: at('10:20') });
    t = expectOf(t, { expect: 'none', by: 'a', at: at('10:30'), note: 'cancelled' });
    expect(t.expectations!.map((x) => x.expect)).toEqual(['deploy', 'none', 'deploy', 'none']);
    expect(t).toMatchObject({ state: 'closed', closedAt: at('10:30'), deployment: { kind: 'none', at: at('10:30'), outcome: { status: 'marked', by: 'a', note: 'cancelled' } } });
    expect(t.deployment!.expectations).toHaveLength(4);
  });

  it('a none record flipped to deploy reopens the track, keeps its record, and locks once that deployment completes', () => {
    // A finished job with no pull request: the hopper closes it with a none record.
    const r = fold([queued('r', '08:00'), ev('job.finished', '08:30', { result: {} }, 'r')]);
    const none = trackOf('r', r.get('r')!, ctx());
    expect(none).toMatchObject({ state: 'closed', deployment: { kind: 'none', outcome: { status: 'finished' } } });
    const reopened = expectOf(none, { expect: 'deploy', by: 'owner', at: at('12:00') });
    expect(reopened).toMatchObject({ state: 'open', deployment: { kind: 'none', expectations: [{ expect: 'deploy' }] } });
    expect(reopened.closedAt).toBeUndefined();
    // The pass judges it again: a person expects a deployment, so the hopper does not close it as none.
    const judged = trackOf('r', r.get('r')!, ctx({ now: at('12:30') }), reopened);
    expect(judged).toMatchObject({ state: 'open', deployment: { kind: 'none' }, expectations: [{ expect: 'deploy' }] });
    // Its change is made later and delivered: the record turns to deploy, locked.
    const later = fold([ev('github_proxy.done', '13:00', { op: 'pr.create', repo: 'octo/shed', url: PR }, 'r'), ev('job.pull_request_merged', '13:10', { pullRequest: PR, part: false }, 'r'),
      ev('landing_batch.started', '13:20', { repo: 'octo/shed', pullRequest: 901, merges: [12] }), ev('landing_batch.promoted', '13:40', { repo: 'octo/shed', pullRequest: 901 })], r);
    const done = trackOf('r', later.get('r')!, ctx({ now: '2026-10-21T14:00:00.000Z', delivery: { schedule, gates: {} } }), judged);
    expect(done).toMatchObject({ state: 'closed', deployment: { kind: 'deploy', target: 'production', expectations: [{ expect: 'deploy' }] } });
    expect(lockedOf(done)).toBe(true);
  });

  it('a completed deployment locks the record, whatever a person said before; a locked track stays as it was', () => {
    const marks = fold([...merged('j'), ...batch()]).get('j')!;
    const open = expectOf(trackOf('j', marks, ctx({ now: at('11:30'), delivery: { schedule, gates: {} } })), { expect: 'deploy', by: 'a', at: at('11:30') });
    const t = trackOf('j', marks, ctx({ now: at('13:30'), delivery: { schedule, gates: {} } }), open);
    expect(t).toMatchObject({ state: 'closed', closedAt: at('13:00'), deployment: { kind: 'deploy' } });
    expect(lockedOf(t)).toBe(true);
    expect(() => expectOf(t, { expect: 'none', by: 'a', at: at('14:00') })).toThrow(/locked/);
    expect(trackOf('j', marks, ctx({ now: at('23:30') }), t)).toBe(t);
  });

  it('the same events folded again change nothing; folded in two halves give the same track', () => {
    const events = [...merged('j'), ...batch()];
    const once = fold(events);
    expect(foldTrackEvents(once, events).size).toBe(0);
    const halves = fold(events.slice(3), fold(events.slice(0, 3)));
    expect(halves).toEqual(once);
    // A closed job's queued event starts no new track.
    const marks = new Map<string, TrackMarks>();
    foldTrackEvents(marks, [queued('x', '08:00')], new Set(['x']));
    expect(marks.size).toBe(0);
  });
});
