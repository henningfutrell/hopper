// Delivery history (issue #2554 part 2, design.md "Delivery forecasts"), pure: each job's delivery track from its
// events, and the measured step durations of a repository.
//
// Feature: delivery tracks
//   Scenario: a change merged and promoted: every measured step has its start and end, and it is in promotion_set
//   Scenario: a change at work, or with its checks running: the step it is in, since when
//   Scenario: a batch run that failed, then one that passed: the landing checks end at the first promotion
//   Scenario: the history of a repository counts only its tracks' ended steps
import { describe, expect, it } from 'vitest';
import { deliveryTracks, pullRequestRef, stepHistory } from '../../src/domain/delivery-history.ts';
import type { DomainEvent, EventType } from '../../src/domain/types.ts';

let seq = 0;
const ev = (type: EventType, at: string, data: Record<string, unknown>, jobId?: string): DomainEvent =>
  ({ seq: ++seq, schemaVersion: 1, id: `e${seq}`, type, at: `2026-10-20T${at}:00.000Z`, data, ...(jobId ? { jobId } : {}) });
const queued = (jobId: string, at: string, repo = 'octo/shed', number = 7) => ev('job.queued', at, { spec: {}, priority: 50, source: { source: 'github', kind: 'issue', key: 'k', repo, number } }, jobId);
const PR = 'https://github.com/octo/shed/pull/12';

const merged = (jobId: string) => [
  queued(jobId, '08:00'),
  ev('job.started', '08:05', { attempts: 1 }, jobId),
  ev('github_proxy.done', '08:40', { op: 'pr.create', repo: 'octo/shed', url: PR }, jobId),
  ev('job.started', '08:45', { attempts: 2 }, jobId),
  ev('job.finished', '09:00', { result: {} }, jobId),
  ev('job.pull_request_merged', '09:20', { pullRequest: PR, part: false }, jobId),
];

describe('deliveryTracks', () => {
  it('a change merged and promoted: each measured step from its events, then promotion_set', () => {
    const events = [
      ...merged('j1'),
      ev('landing_batch.started', '09:30', { repo: 'octo/shed', pullRequest: 900, merges: [11, 12] }),
      ev('landing_batch.promoted', '10:30', { repo: 'octo/shed', pullRequest: 900 }),
    ];
    expect(deliveryTracks(events).get('j1')).toEqual({
      jobId: 'j1', repo: 'octo/shed', issue: 'octo/shed#7', pullRequest: PR,
      actuals: [
        { step: 'queued', start: '2026-10-20T08:00:00.000Z', end: '2026-10-20T08:05:00.000Z' },
        { step: 'coding', start: '2026-10-20T08:05:00.000Z', end: '2026-10-20T09:00:00.000Z' },
        { step: 'pr_checks', start: '2026-10-20T09:00:00.000Z', end: '2026-10-20T09:20:00.000Z' },
        { step: 'landing', start: '2026-10-20T09:20:00.000Z', end: '2026-10-20T09:20:00.000Z' },
        { step: 'landing_checks', start: '2026-10-20T09:20:00.000Z', end: '2026-10-20T10:30:00.000Z' },
      ],
      current: { step: 'promotion_set', since: '2026-10-20T10:30:00.000Z' },
    });
  });

  it('a change at work, or with its checks running: the step it is in, since when', () => {
    const tracks = deliveryTracks([
      queued('q', '07:00'),
      queued('c', '07:00'), ev('job.started', '07:10', { attempts: 1 }, 'c'),
      ...merged('m').slice(0, 5),
    ]);
    expect(tracks.get('q')!.current).toEqual({ step: 'queued', since: '2026-10-20T07:00:00.000Z' });
    expect(tracks.get('c')!.current).toEqual({ step: 'coding', since: '2026-10-20T07:10:00.000Z' });
    expect(tracks.get('m')).toMatchObject({ pullRequest: PR, current: { step: 'pr_checks', since: '2026-10-20T09:00:00.000Z' } });
    expect(tracks.get('m')!.actuals.at(-1)).toEqual({ step: 'pr_checks', start: '2026-10-20T09:00:00.000Z' });
  });

  it('a failed batch run, then one that passed: the landing checks end at the first promotion', () => {
    const t = deliveryTracks([
      ...merged('j1'),
      ev('landing_batch.started', '09:30', { repo: 'Octo/Shed', pullRequest: 900, merges: [12] }),
      ev('landing_batch.failed', '10:00', { repo: 'octo/shed', pullRequest: 900 }),
      ev('landing_batch.started', '10:05', { repo: 'octo/shed', pullRequest: 901, merges: [12, 13] }),
      ev('landing_batch.promoted', '11:00', { repo: 'octo/shed', pullRequest: 901 }),
      ev('landing_batch.started', '11:05', { repo: 'octo/shed', pullRequest: 902, merges: [12] }),
      ev('landing_batch.promoted', '12:00', { repo: 'octo/shed', pullRequest: 902 }),
    ]).get('j1')!;
    expect(t.actuals.at(-1)).toEqual({ step: 'landing_checks', start: '2026-10-20T09:20:00.000Z', end: '2026-10-20T11:00:00.000Z' });
  });

  it('a job with no job.queued in the events has no track', () => {
    expect(deliveryTracks([ev('job.started', '08:00', { attempts: 1 }, 'x')]).size).toBe(0);
  });
});

describe('stepHistory', () => {
  it('counts only the ended steps of the repository\'s tracks, in ms', () => {
    const tracks = deliveryTracks([
      ...merged('a'),
      queued('b', '08:00'), ev('job.started', '08:30', { attempts: 1 }, 'b'),
      queued('other', '08:00', 'octo/barn'), ev('job.started', '09:00', { attempts: 1 }, 'other'),
    ]).values();
    expect(stepHistory(tracks, 'Octo/Shed')).toEqual({
      queued: [5 * 60_000, 30 * 60_000],
      coding: [55 * 60_000],
      pr_checks: [20 * 60_000],
      landing: [0],
    });
  });
});

describe('pullRequestRef', () => {
  it('reads owner/name and number from a pull request URL', () => {
    expect(pullRequestRef('https://github.com/Octo/Shed/pull/12')).toEqual({ repo: 'octo/shed', number: 12 });
    expect(pullRequestRef('https://github.com/octo/shed/issues/12')).toBeUndefined();
  });
});
