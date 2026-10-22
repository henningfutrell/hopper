// Issue #1920: a machine a job's start found out of reach of the hopper carries that problem for a while, so the decider
// holds a new job there; then the hold ends by itself, and the next job placed there checks again.
import { describe, expect, it } from 'vitest';
import type { MachineSnapshot } from '../../src/domain/types.ts';
import { createReachHolds } from '../../src/engine/reach-holds.ts';
import { machine } from '../decider/support.ts';

const source = (machines: MachineSnapshot[]) => ({ list: async () => machines });

describe('reach holds (issue #1920)', () => {
  it('marks a held machine with its problem until the hold ends, and leaves the others as they are', async () => {
    let now = 0;
    const holds = createReachHolds({ now: () => new Date(now) }, 1000);
    const machines = holds.source(source([machine({ id: 'box' }), machine({ id: 'seat' })]));
    holds.hold('box', 'this machine cannot reach the hopper at http://h');
    const held = 'this machine cannot reach the hopper at http://h (held since 1970-01-01T00:00:00.000Z; a job placed there after 1970-01-01T00:00:01.000Z checks again)';
    expect((await machines.list()).map((m) => m.addressProblem)).toEqual([held, undefined]);
    now = 999;
    expect((await machines.list())[0]!.addressProblem).toBe(held);
    now = 1000;
    expect((await machines.list())[0]!.addressProblem).toBeUndefined();
  });

  it('keeps the problem a probe found on the machine', async () => {
    const holds = createReachHolds({ now: () => new Date(0) });
    const machines = holds.source(source([machine({ id: 'ssh', addressProblem: 'curl is not installed there' })]));
    holds.hold('ssh', 'this machine cannot reach the hopper at http://h');
    expect((await machines.list())[0]!.addressProblem).toBe('curl is not installed there');
  });
});
