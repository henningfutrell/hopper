// Issue #1569: a job moved off a lost machine resumes elsewhere, and is not placed back on the machine it left while the
// agent it left there may still run. Once that agent is ended (the mark lifted), it may go back there.
import { describe, expect, it } from 'vitest';
import { decide } from '../../src/decider/index.ts';
import type { Job } from '../../src/domain/types.ts';
import { inputs, job, machine } from './support.ts';

/** A job the lost-machine move picked up to resume elsewhere, off `seat`. `lost`: the agent it left there may still run. */
const moved = (lost: boolean): Job => ({
  ...job('a'), pendingAnswer: 'go on',
  parked: { at: '2026-10-17T00:00:00.000Z', from: 'running', auto: true, why: 'machine seat did not reconnect', elsewhere: { at: '2026-10-17T00:00:01.000Z', checkpointAt: '2026-10-17T00:00:00.000Z', from: 'seat', ...(lost ? { lost: true as const } : {}) } },
});

describe('a job moved off a lost machine', () => {
  it('goes to another machine, even with less room', () => {
    const d = decide(inputs({ machines: [machine({ id: 'seat', maxLanes: 4 }), machine({ id: 'host', maxLanes: 1 })], waiting: [moved(true)] }), 'd1');
    expect(d.start).toEqual([expect.objectContaining({ jobId: 'a', machineId: 'host' })]);
  });

  it('with no other machine: held with why, never failed', () => {
    const d = decide(inputs({ machines: [machine({ id: 'seat' })], waiting: [moved(true)] }), 'd1');
    expect(d.start).toEqual([]);
    expect(d.hold).toEqual([{ jobId: 'a', reason: 'it moved off seat when that machine was lost: it waits for another machine, or for the agent it left there to end' }]);
  });

  it('once the agent it left is ended, it may go back to that machine', () => {
    const d = decide(inputs({ machines: [machine({ id: 'seat' })], waiting: [moved(false)] }), 'd1');
    expect(d.start).toEqual([expect.objectContaining({ jobId: 'a', machineId: 'seat' })]);
  });
});
