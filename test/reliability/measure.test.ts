// Issue #535: lane reliability, measured from the hopper's own event log. A run is a claim on a lane and how it
// ended there; a lane fault is a failure that was not the job's fault (the machine offline or not dialled in, a
// start or dialog it could not get past, a pane lost). Newer runs weigh more.
import { describe, expect, it } from 'vitest';
import type { DomainEvent, EventType } from '../../src/domain/types.ts';
import { isLaneFault } from '../../src/reliability/fault.ts';
import { measure, runsFrom } from '../../src/reliability/measure.ts';

const AT = '2026-10-09T12:00:00.000Z';
let seq = 0;
function ev(type: EventType, jobId: string, at: string, more: Partial<DomainEvent> = {}, data: Record<string, unknown> = {}): DomainEvent {
  seq += 1;
  return { seq, schemaVersion: 1, id: `e${seq}`, type, at, jobId, data, ...more };
}
const claim = (jobId: string, lane: string, at: string) => ev('job.claimed', jobId, at, { laneId: lane, machineId: lane.split('/')[0] });
const start = (jobId: string, at: string) => ev('job.started', jobId, at);
const end = (type: EventType, jobId: string, lane: string, at: string, data: Record<string, unknown> = {}) => ev(type, jobId, at, { laneId: lane }, data);

describe('lane faults', () => {
  it.each([
    'pane lost', 'machine desk is offline', 'client box is not dialled in', 'claude exited at startup',
    'claude blocked at startup: Do you trust the files in this folder?', 'claude did not start in 3 attempts: no prompt',
    'the prompt never reached claude after 3 sends: …', 'herdr: connection refused', 'its link closed',
  ])('%s is a lane fault', (error) => expect(isLaneFault(error)).toBe(true));

  it.each(['tests fail on main', 'not complete: the pull request is not merged', 'too many questions', 'aborted', 'parked', 'interrupted by daemon restart'])(
    '%s is not', (error) => expect(isLaneFault(error)).toBe(false),
  );
});

describe('runs from the event log', () => {
  it('pairs each claim with its start and how it ended on that lane', () => {
    const runs = runsFrom([
      claim('j1', 'desk/lane-1', '2026-10-09T10:00:00.000Z'), start('j1', '2026-10-09T10:00:30.000Z'),
      end('job.finished', 'j1', 'desk/lane-1', '2026-10-09T10:20:00.000Z'),
      claim('j2', 'desk/lane-2', '2026-10-09T10:00:00.000Z'),
      end('job.failed', 'j2', 'desk/lane-2', '2026-10-09T10:01:00.000Z', { error: 'pane lost' }),
      claim('j3', 'desk/lane-1', '2026-10-09T11:00:00.000Z'), start('j3', '2026-10-09T11:00:10.000Z'),
      end('question.asked', 'j3', 'desk/lane-1', '2026-10-09T11:05:00.000Z'),
      claim('j4', 'desk/lane-2', '2026-10-09T11:00:00.000Z'),
      end('job.cancelled', 'j4', 'desk/lane-2', '2026-10-09T11:01:00.000Z'),
      // Claimed before the window: its machine comes from its lane.
      end('job.failed', 'j5', 'box/lane-1', '2026-10-09T09:00:00.000Z', { error: 'tests fail' }),
    ]);
    expect(runs).toEqual([
      { laneId: 'box/lane-1', machineId: 'box', endedAt: '2026-10-09T09:00:00.000Z', outcome: 'failed', error: 'tests fail' },
      { laneId: 'desk/lane-2', machineId: 'desk', claimedAt: '2026-10-09T10:00:00.000Z', endedAt: '2026-10-09T10:01:00.000Z', outcome: 'failed', error: 'pane lost' },
      { laneId: 'desk/lane-1', machineId: 'desk', claimedAt: '2026-10-09T10:00:00.000Z', startedAt: '2026-10-09T10:00:30.000Z', endedAt: '2026-10-09T10:20:00.000Z', outcome: 'finished' },
      { laneId: 'desk/lane-2', machineId: 'desk', claimedAt: '2026-10-09T11:00:00.000Z', endedAt: '2026-10-09T11:01:00.000Z', outcome: 'cancelled' },
      { laneId: 'desk/lane-1', machineId: 'desk', claimedAt: '2026-10-09T11:00:00.000Z', startedAt: '2026-10-09T11:00:10.000Z', endedAt: '2026-10-09T11:05:00.000Z', outcome: 'question' },
    ]);
  });
});

describe('measure', () => {
  it('counts runs, lane faults, success and start time per lane; cancelled runs do not count', () => {
    const runs = runsFrom([
      claim('a', 'desk/lane-1', '2026-10-09T10:00:00.000Z'), start('a', '2026-10-09T10:00:20.000Z'), end('job.finished', 'a', 'desk/lane-1', '2026-10-09T10:30:00.000Z'),
      claim('b', 'desk/lane-1', '2026-10-09T11:00:00.000Z'), start('b', '2026-10-09T11:00:40.000Z'), end('job.failed', 'b', 'desk/lane-1', '2026-10-09T11:10:00.000Z', { error: 'tests fail' }),
      claim('c', 'desk/lane-1', '2026-10-09T11:20:00.000Z'), end('job.failed', 'c', 'desk/lane-1', '2026-10-09T11:21:00.000Z', { error: 'pane lost' }),
      claim('d', 'desk/lane-1', '2026-10-09T11:30:00.000Z'), end('job.cancelled', 'd', 'desk/lane-1', '2026-10-09T11:31:00.000Z'),
    ]);
    const [s] = measure(runs, { at: AT, windowDays: 14 });
    expect(s).toMatchObject({
      laneId: 'desk/lane-1', machineId: 'desk', runs: 3, finished: 1, failed: 2, laneFaults: 1, recentFaults: 1,
      successRate: 1 / 3, medianStartMs: 30_000, lastRunAt: '2026-10-09T11:21:00.000Z',
    });
    expect(s!.score).toBeCloseTo(2 / 3, 2);
  });

  it('weighs a newer lane fault more than an older one', () => {
    const old = runsFrom([
      claim('a', 'x/lane-1', '2026-09-27T10:00:00.000Z'), end('job.failed', 'a', 'x/lane-1', '2026-09-27T10:01:00.000Z', { error: 'pane lost' }),
      claim('b', 'x/lane-1', '2026-10-09T10:00:00.000Z'), end('job.finished', 'b', 'x/lane-1', '2026-10-09T10:01:00.000Z'),
    ]);
    const recent = runsFrom([
      claim('a', 'y/lane-1', '2026-09-27T10:00:00.000Z'), end('job.finished', 'a', 'y/lane-1', '2026-09-27T10:01:00.000Z'),
      claim('b', 'y/lane-1', '2026-10-09T10:00:00.000Z'), end('job.failed', 'b', 'y/lane-1', '2026-10-09T10:01:00.000Z', { error: 'pane lost' }),
    ]);
    const [x] = measure(old, { at: AT, windowDays: 14 });
    const [y] = measure(recent, { at: AT, windowDays: 14 });
    expect(x!.score).toBeGreaterThan(y!.score);
  });

  it('leaves out runs that ended before the window', () => {
    const runs = runsFrom([claim('a', 'x/lane-1', '2026-09-01T10:00:00.000Z'), end('job.finished', 'a', 'x/lane-1', '2026-09-01T10:01:00.000Z')]);
    expect(measure(runs, { at: AT, windowDays: 14 })).toEqual([]);
  });
});
