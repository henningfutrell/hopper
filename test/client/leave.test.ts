// Issue #1284: a lane pod's client told to stop leaves the hopper first: it asks again and again, a failed ask too,
// until no job is left on the machine or the hopper retired it; then it stops.
import { describe, expect, it } from 'vitest';
import { drain, type LeaveAnswer } from '../../src/client/leave.ts';

describe('a client leaving', () => {
  it('asks until no job is left, trying a failed ask again', async () => {
    const answers: (LeaveAnswer | Error)[] = [{ jobs: 2, retired: false }, new Error('could not reach the hopper'), { jobs: 1, retired: false }, { jobs: 0, retired: false }];
    const asked: number[] = [];
    const lines: string[] = [];
    const end = await drain({
      leave: async () => { asked.push(asked.length); const a = answers.shift()!; if (a instanceof Error) throw a; return a; },
      everyMs: 1, log: (l) => lines.push(l),
    });
    expect(end).toEqual({ jobs: 0, retired: false });
    expect(asked).toHaveLength(4);
    expect(lines).toContain('hopper-client: leaving: 2 jobs still on this machine, no new one placed');
    expect(lines).toContain('hopper-client: leaving: could not reach the hopper');
  });

  it('stops at once when the hopper retired the machine', async () => {
    let asked = 0;
    expect(await drain({ leave: async () => { asked++; return { jobs: 0, retired: true }; }, everyMs: 1 })).toEqual({ jobs: 0, retired: true });
    expect(asked).toBe(1);
  });
});
