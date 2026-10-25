// What a delivery hold holds, read from the user's store (issue #2775 part 7): a job's hold for yolo mode's merge, and the
// pull requests of one repository for the batch runner and the stable move. A hand-made store at the `Pick` seam.
//
// Feature: the store's holds
//   Scenario: a held job's wait is read from its own hold and release events
//   Scenario: the held pull requests of a repository: the job's own, else its track's; a released one is not held
import { describe, expect, it } from 'vitest';
import type { DomainEvent, EventType, Job } from '../../src/domain/types.ts';
import { heldPullRequests, jobHoldWhy } from '../../src/users/delivery-holds.ts';

let seq = 0;
const ev = (type: EventType, jobId: string): DomainEvent =>
  ({ seq: ++seq, schemaVersion: 1, id: `e${seq}`, type, at: '2026-10-25T10:00:00.000Z', jobId, data: { by: 'ana', step: 'landing', ...(type === 'delivery_track.held' ? { owner: 'hopper' } : {}) } });
const EVENTS = [ev('delivery_track.held', 'a'), ev('delivery_track.held', 'b'), ev('delivery_track.held', 'c'), ev('delivery_track.released', 'c')].reverse();

const store = {
  events: { recent: (_limit?: number, types?: EventType[], jobId?: string) => EVENTS.filter((e) => (!types || types.includes(e.type)) && (!jobId || e.jobId === jobId)) },
  jobs: { get: (id: string) => (id === 'a' ? { id, sourceState: { source: { pullRequest: 'https://github.com/octo/shed/pull/12' } } } as unknown as Job : undefined) },
  keptTracks: { get: (id: string) => (id === 'b' || id === 'c' ? { marks: { pr: `https://github.com/octo/shed/pull/${id === 'b' ? 14 : 16}` } } : undefined) },
} as unknown as Parameters<typeof heldPullRequests>[0];

describe("the store's holds (issue #2775 part 7)", () => {
  it("a held job's wait is read from its own hold and release events", () => {
    expect(jobHoldWhy(store, 'a')).toBe('its delivery is held: paused at landing since 2026-10-25T10:00:00.000Z; a release lets it go on');
    expect(jobHoldWhy(store, 'c')).toBeUndefined();
    expect(jobHoldWhy(store, 'z')).toBeUndefined();
  });

  it("the held pull requests of a repository: the job's own, else its track's; a released one is not held", () => {
    expect([...heldPullRequests(store, 'Octo/Shed')].sort()).toEqual([12, 14]);
    expect(heldPullRequests(store, 'octo/other').size).toBe(0);
  });
});
