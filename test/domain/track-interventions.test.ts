// Interventions on a kept delivery track (issue #2775 part 6, design.md "Part 6: interventions and the delivery hold"),
// pure: each person's act on a job's change is kept on its track, at the step the track was in, and `allowedActs` says
// which acts the step allows.
//
// Feature: a person steps into a job's change
//   Scenario: a person's Park, Pick up, Run again, Merge now and expedite flag are interventions on the track, at their step
//   Scenario: the hopper's own parks and moves, and a job's own acts, are no interventions
//   Scenario: a delivery hold and its release are interventions; the hold holds until it is released
//   Scenario: an expedite flag on the job's issue or pull request is an intervention on its track too
//   Scenario: the same events folded again keep each intervention once
//   Scenario: at queued and coding a running job can be parked; a parked job can be picked up
//   Scenario: at pr_checks a job at work is parked, a finished one is held
//   Scenario: from landing on the change is held or taken over; a held change is only released
//   Scenario: Run again before production, never at production; expedite only when the schedule allows it
//   Scenario: a closed track allows no act
import { describe, expect, it } from 'vitest';
import { foldTrackEvents, trackOf, type KeptTrack, type TrackContext, type TrackMarks } from '../../src/domain/kept-tracks.ts';
import { allowedActs, holdOf } from '../../src/domain/track-interventions.ts';
import type { DomainEvent, EventType } from '../../src/domain/types.ts';

let seq = 0;
const at = (hhmm: string) => `2026-10-20T${hhmm}:00.000Z`;
const ev = (type: EventType, hhmm: string, data: Record<string, unknown>, jobId?: string): DomainEvent =>
  ({ seq: ++seq, schemaVersion: 1, id: `e${seq}`, type, at: at(hhmm), data, ...(jobId ? { jobId } : {}) });
const PR = 'https://github.com/octo/shed/pull/12';
const queued = (jobId: string) =>
  ev('job.queued', '08:00', { spec: {}, priority: 50, source: { source: 'github', kind: 'issue', key: 'k', repo: 'Octo/Shed', number: 7 } }, jobId);
const ctx = (c: Partial<TrackContext> = {}): TrackContext => ({ now: at('12:00'), delivery: { gates: {} }, cleared: {}, job: { status: 'finished' }, ...c });
const fold = (events: DomainEvent[], marks = new Map<string, TrackMarks>()) => { foldTrackEvents(marks, events); return marks; };
const track = (events: DomainEvent[], c: Partial<TrackContext> = {}) => trackOf('j', fold(events).get('j')!, ctx(c));

const started = () => [queued('j'), ev('job.started', '08:05', { attempts: 1 }, 'j')];
const merged = () => [
  ...started(),
  ev('github_proxy.done', '08:40', { op: 'pr.create', repo: 'octo/shed', url: PR }, 'j'),
  ev('job.finished', '09:00', { result: {} }, 'j'),
  ev('job.pull_request_merged', '09:20', { pullRequest: PR, part: false, person: 'ana', via: 'ui' }, 'j'),
];

describe('interventions on a kept delivery track', () => {
  it("a person's Park, Pick up, Run again, Merge now and expedite flag are interventions on the track, at their step", () => {
    const t = track([
      ...started(),
      ev('job.parked', '08:10', { from: 'running', by: 'ana', via: 'ui', reason: 'wait for the review' }, 'j'),
      ev('job.unparked', '08:20', { to: 'queued', by: 'ana', via: 'cli' }, 'j'),
      ev('delivery_expedite.changed', '08:30', { job: 'j', expedite: true, by: 'bo' }),
      ev('github_proxy.done', '08:40', { op: 'pr.create', repo: 'octo/shed', url: PR }, 'j'),
      ev('job.finished', '09:00', { result: {} }, 'j'),
      ev('job.pull_request_merged', '09:20', { pullRequest: PR, part: false, person: 'ana', via: 'ui' }, 'j'),
      ev('job.rerun', '09:30', { by: 'user', person: 'bo', via: 'ui' }, 'j'),
    ]);
    expect(t.interventions?.map(({ act, by, step, at: when }) => ({ act, by, step, at: when }))).toEqual([
      { act: 'park', by: 'ana', step: 'coding', at: at('08:10') },
      { act: 'pick_up', by: 'ana', step: 'coding', at: at('08:20') },
      { act: 'expedite', by: 'bo', step: 'coding', at: at('08:30') },
      { act: 'merge_now', by: 'ana', step: 'pr_checks', at: at('09:20') },
      { act: 'run_again', by: 'bo', step: 'landing_checks', at: at('09:30') },
    ]);
    expect(t.interventions?.[0]).toMatchObject({ reason: 'wait for the review' });
    expect(t.interventions?.[2]).toMatchObject({ expedite: true });
  });

  it("the hopper's own parks and moves, and a job's own acts, are no interventions", () => {
    const t = track([
      ...started(),
      ev('job.parked', '08:10', { from: 'waiting_answer', auto: true, why: 'its question waited on a person' }, 'j'),
      ev('job.parked', '08:11', { from: 'running', move: 'busy_machine', auto: true }, 'j'),
      ev('job.unparked', '08:12', { to: 'queued', elsewhere: true }, 'j'),
      ev('job.parked', '08:13', { from: 'running', by: 'job j', via: 'job' }, 'j'),
      ev('job.rerun', '08:14', { by: 'tending' }, 'j'),
      ev('job.pull_request_merged', '08:15', { pullRequest: PR, part: false, byHopper: true }, 'j'),
    ]);
    expect(t.interventions).toBeUndefined();
  });

  it('a delivery hold and its release are interventions; the hold holds until it is released', () => {
    const held = [...merged(), ev('delivery_track.held', '09:40', { by: 'ana', step: 'landing_checks', owner: 'person', reason: 'I ship it by hand' }, 'j')];
    const t = track(held);
    expect(t.interventions?.at(-1)).toMatchObject({ act: 'hold', by: 'ana', step: 'landing_checks', owner: 'person', reason: 'I ship it by hand' });
    expect(t.hold).toEqual({ by: 'ana', at: at('09:40'), step: 'landing_checks', owner: 'person', reason: 'I ship it by hand' });
    const released = track([...held, ev('delivery_track.released', '10:00', { by: 'bo', step: 'landing_checks' }, 'j')]);
    expect(released.interventions?.at(-1)).toMatchObject({ act: 'release', by: 'bo', step: 'landing_checks' });
    expect(released.hold).toBeUndefined();
    expect(holdOf(released.interventions)).toBeUndefined();
  });

  it('an expedite flag on the job\'s issue or pull request is an intervention on its track too', () => {
    const t = track([
      ...merged(),
      ev('delivery_expedite.changed', '09:40', { issue: 'octo/shed#7', expedite: true, by: 'ana' }),
      ev('delivery_expedite.changed', '09:50', { pullRequest: PR, expedite: false, by: 'bo' }),
      ev('delivery_expedite.changed', '09:55', { issue: 'octo/shed#8', expedite: true, by: 'cy' }),
    ]);
    expect(t.interventions?.filter((i) => i.act === 'expedite').map((i) => [i.by, i.expedite])).toEqual([['ana', true], ['bo', false]]);
  });

  it('the same events folded again keep each intervention once', () => {
    const events = [...merged(), ev('delivery_track.held', '09:40', { by: 'ana', step: 'landing_checks', owner: 'hopper' }, 'j')];
    const marks = fold(events);
    const once = structuredClone(marks.get('j'));
    expect(foldTrackEvents(marks, events).size).toBe(0);
    expect(marks.get('j')).toEqual(once);
  });
});

describe('which acts a step allows', () => {
  const at0 = (events: DomainEvent[], status: NonNullable<TrackContext['job']>['status'], c: Partial<TrackContext> = {}) => {
    const job = { status };
    return allowedActs(track(events, { job, ...c }), job, c.delivery);
  };

  it('at queued and coding a running job can be parked; a parked job can be picked up', () => {
    expect(at0([queued('j')], 'queued')).toEqual([]);
    expect(at0(started(), 'running')).toEqual(['park']);
    expect(at0(started(), 'waiting_answer')).toEqual(['park']);
    expect(at0(started(), 'parked')).toEqual(['pick_up']);
  });

  it('at pr_checks a job at work is parked, a finished one is held', () => {
    const checks = [...started(), ev('github_proxy.done', '08:40', { op: 'pr.create', repo: 'octo/shed', url: PR }, 'j'), ev('job.finished', '09:00', { result: {} }, 'j')];
    expect(at0(checks, 'finished')).toEqual(['hold', 'take_ownership', 'run_again']);
    const atWork = [...started(), ev('github_proxy.done', '08:40', { op: 'pr.create', repo: 'octo/shed', url: PR }, 'j')];
    expect(at0(atWork, 'running')).toEqual(['park']);
  });

  it('from landing on the change is held or taken over; a held change is only released', () => {
    expect(at0(merged(), 'finished')).toEqual(['hold', 'take_ownership', 'run_again']);
    const held = [...merged(), ev('delivery_track.held', '09:40', { by: 'ana', step: 'landing_checks', owner: 'hopper' }, 'j')];
    expect(at0(held, 'finished')).toEqual(['release']);
  });

  it('Run again before production, never at production; expedite only when the schedule allows it', () => {
    const schedule = { timeZone: 'UTC', cutoffs: [{ weekday: 1, time: '11:00' }], testGateAfterMinutes: 60, productionAfterMinutes: 60, epoch: '2026-10-01T00:00:00.000Z' };
    const promoted = [...merged(), ev('landing_batch.started', '09:30', { repo: 'octo/shed', pullRequest: 900, merges: [12] }), ev('landing_batch.promoted', '10:30', { repo: 'octo/shed', pullRequest: 900 })];
    expect(at0(promoted, 'finished', { delivery: { gates: {}, schedule: { ...schedule, expedite: 'out_of_cadence' } } })).toEqual(['hold', 'take_ownership', 'run_again', 'expedite']);
    expect(at0(promoted, 'finished', { delivery: { gates: {}, schedule: { ...schedule, expedite: 'none' } } })).toEqual(['hold', 'take_ownership', 'run_again']);
    const flagged = [...promoted, ev('delivery_expedite.changed', '10:40', { job: 'j', expedite: true, by: 'ana' })];
    expect(at0(flagged, 'finished', { delivery: { gates: {}, schedule: { ...schedule, expedite: 'out_of_cadence' } } })).toEqual(['hold', 'take_ownership', 'run_again']);
    const production = { current: { step: 'production', since: at('12:00'), blocker: 'human_gate', waitingOn: 'x' }, state: 'open' } as Pick<KeptTrack, 'current' | 'state'>;
    expect(allowedActs(production, { status: 'finished' })).toEqual(['hold', 'take_ownership']);
  });

  it('a closed track allows no act', () => {
    const done = [...started(), ev('job.finished', '09:00', { result: {} }, 'j')];
    const t = track(done);
    expect(t.state).toBe('closed');
    expect(allowedActs(t, { status: 'finished' })).toEqual([]);
  });
});
