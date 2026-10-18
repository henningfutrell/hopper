// Issue #1860: two machines can share one Claude account. A machine's own usage limits let one of them give way: the
// secondary's lane cap falls first and reaches 0 before the primary loses a lane. Absent, the user's usage limits apply.
import { describe, expect, it } from 'vitest';
import { decide } from '../../src/decider/index.ts';
import { laneEffect } from '../../src/decider/usage.ts';
import { inputs, job, machine, NOW, policy, reading } from './support.ts';

const primary = machine({ id: 'win', executors: ['test'] });
const secondary = machine({ id: 'seat', executors: ['test'], usageLimits: { soft: 0.5, hard: 0.7 } });
// One account, read on each machine: the same numbers.
const usage = (used: number) => [reading(used, 100, { machineId: 'win' }), reading(used, 100, { machineId: 'seat' })];

describe('a machine\'s own usage limits (issue #1860)', () => {
  it('in the soft band the secondary\'s lane cap falls first and reaches 0 before the primary loses a lane', () => {
    for (const used of [50, 55, 60, 65, 69]) {
      expect(laneEffect(primary, usage(used), policy, NOW)).toMatchObject({ cap: 4, band: 'free' });
    }
    expect(laneEffect(secondary, usage(40), policy, NOW)).toMatchObject({ cap: 4, band: 'free' });
    expect(laneEffect(secondary, usage(60), policy, NOW)).toMatchObject({ cap: 2, band: 'soft' });
    expect(laneEffect(secondary, usage(70), policy, NOW)).toMatchObject({ cap: 0, band: 'hard' });
    expect(laneEffect(primary, usage(80), policy, NOW)).toMatchObject({ cap: 2, band: 'soft' });
  });

  it('the Decision starts new jobs on the primary only once the secondary is at its own hard limit', () => {
    const d = decide(inputs({ machines: [primary, secondary], usage: usage(69), waiting: ['a', 'b', 'c', 'd', 'e'].map((id) => job(id)) }), 'd1');
    expect(d.reasons).toEqual(expect.arrayContaining([
      'win: 69% used, lane cap 4 of 4 (free)',
      'seat: 69% used, lane cap 0 of 4 (soft), its own usage limits 50% / 70%',
    ]));
    expect(d.start.map((s) => s.machineId)).toEqual(['win', 'win', 'win', 'win']);
  });

  it('without them, the machine takes the user\'s usage limits', () => {
    expect(laneEffect(primary, usage(80), { ...policy, softLimit: 0.5, hardLimit: 0.7 }, NOW)).toMatchObject({ cap: 0, band: 'hard' });
  });
});
