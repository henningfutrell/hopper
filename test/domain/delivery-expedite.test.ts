// The expedite flag of a change (issue #2554 part 4, design.md "Delivery forecasts"), pure: a person's flag on a job,
// an issue or a pull request, read from the delivery_expedite.changed events for one delivery track.
//
// Feature: the expedite flag
//   Scenario: a flag on the track's job, its issue (any case) or its pull request expedites it
//   Scenario: the newest flag of a target wins: turned off, the change is not expedited
//   Scenario: of flags on two targets of one track, the newest wins
//   Scenario: a flag on another job, issue or pull request does not expedite it
import { describe, expect, it } from 'vitest';
import { expediteOf, expediteTargetOf } from '../../src/domain/delivery-expedite.ts';
import type { DeliveryTrack } from '../../src/domain/delivery-history.ts';
import type { DomainEvent } from '../../src/domain/types.ts';

let seq = 0;
const flag = (at: string, data: Record<string, unknown>): DomainEvent =>
  ({ seq: ++seq, schemaVersion: 1, id: `e${seq}`, type: 'delivery_expedite.changed', at: `2026-10-20T${at}:00.000Z`, data: { by: 'owner', ...data } });
const PR = 'https://github.com/octo/shed/pull/12';
const track: DeliveryTrack = { jobId: 'j1', repo: 'octo/shed', issue: 'octo/shed#7', pullRequest: PR, actuals: [], current: { step: 'coding', since: '2026-10-20T08:00:00.000Z' } };

describe('expediteOf', () => {
  it('a flag on the job, the issue in any case, or the pull request expedites the change', () => {
    for (const target of [{ job: 'j1' }, { issue: 'Octo/Shed#7' }, { pullRequest: PR }]) {
      expect(expediteOf([flag('09:00', { ...target, expedite: true })], track)).toEqual({ by: 'owner', at: '2026-10-20T09:00:00.000Z' });
    }
  });

  it('the newest flag of a target wins: turned off, the change is not expedited', () => {
    expect(expediteOf([flag('09:00', { job: 'j1', expedite: true }), flag('09:30', { job: 'j1', expedite: false })], track)).toBeUndefined();
    expect(expediteOf([flag('09:00', { job: 'j1', expedite: false }), flag('09:30', { job: 'j1', expedite: true })], track)?.at).toBe('2026-10-20T09:30:00.000Z');
  });

  it('of flags on two targets of the track, the newest wins', () => {
    expect(expediteOf([flag('09:00', { issue: 'octo/shed#7', expedite: true }), flag('09:30', { job: 'j1', expedite: false })], track)).toBeUndefined();
    expect(expediteOf([flag('09:00', { job: 'j1', expedite: false }), flag('09:30', { pullRequest: PR, expedite: true })], track)?.at).toBe('2026-10-20T09:30:00.000Z');
  });

  it('a flag on another job, issue or pull request does not expedite it', () => {
    const others = [{ job: 'j2' }, { issue: 'octo/shed#8' }, { issue: 'octo/other#7' }, { pullRequest: 'https://github.com/octo/shed/pull/13' }];
    expect(expediteOf(others.map((t) => flag('09:00', { ...t, expedite: true })), track)).toBeUndefined();
    expect(expediteOf([], track)).toBeUndefined();
  });
});

describe('expediteTargetOf', () => {
  it('names one target of a flag: the job, the issue lowercased, or the pull request', () => {
    expect(expediteTargetOf({ job: 'j1' })).toEqual({ job: 'j1' });
    expect(expediteTargetOf({ issue: 'Octo/Shed#7' })).toEqual({ issue: 'octo/shed#7' });
    expect(expediteTargetOf({ pr: PR })).toEqual({ pullRequest: PR });
  });
});
