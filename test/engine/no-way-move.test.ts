// Issue #2355: a job that resumes elsewhere and gets no way to the hopper on its machine goes back to the queue, a few
// times at most; any other job does not. Fakes only at the store's events.
import { describe, expect, it } from 'vitest';
import type { DomainEvent, Job } from '../../src/domain/types.ts';
import { MAX_NO_WAY_MOVES, NO_WAY_MOVE, noWayMove } from '../../src/engine/no-way-move.ts';

const AT = '2026-10-21T00:00:00.000Z';
const elsewhere = { id: 'job-1', pendingAnswer: 'go on', parked: { at: AT, elsewhere: { at: AT, checkpointAt: AT, from: 'seat' } } } as Job;
const requeued = (reason: string) => ({ type: 'job.requeued', jobId: 'job-1', data: { from: 'running', reason } }) as unknown as DomainEvent;
const engine = (events: DomainEvent[]) => ({ store: { events: { recent: () => events } } }) as unknown as Parameters<typeof noWayMove>[0];

describe('noWayMove (issue #2355)', () => {
  it('a job that resumes elsewhere goes back to the queue, the machine and why in the reason', () => {
    expect(noWayMove(engine([]), elsewhere, 'host', 'no URL')).toBe(`machine host: ${NO_WAY_MOVE}: no URL`);
  });

  it(`after ${MAX_NO_WAY_MOVES} such moves it does not: the job fails as before`, () => {
    const moves = Array.from({ length: MAX_NO_WAY_MOVES - 1 }, () => requeued(`machine host: ${NO_WAY_MOVE}: no URL`));
    expect(noWayMove(engine([...moves, requeued('daemon restart')]), elsewhere, 'spare', 'no URL')).toBeDefined();
    expect(noWayMove(engine([...moves, requeued(`machine spare: ${NO_WAY_MOVE}: no URL`)]), elsewhere, 'other', 'no URL')).toBeUndefined();
  });

  it('a job that does not resume elsewhere does not', () => {
    expect(noWayMove(engine([]), { ...elsewhere, parked: { at: AT } } as Job, 'host', 'no URL')).toBeUndefined();
    expect(noWayMove(engine([]), { id: 'job-2' } as Job, 'host', 'no URL')).toBeUndefined();
  });
});
