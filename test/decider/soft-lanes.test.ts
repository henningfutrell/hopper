// Issue #2091: from the soft limit to the hard limit a machine keeps a fixed number of lanes, the soft lanes (default 1,
// capped by its maxLanes), with no scale-down between the limits; at the hard limit nothing new starts.
import { describe, expect, it } from 'vitest';
import { decide } from '../../src/decider/index.ts';
import { laneEffect } from '../../src/decider/usage.ts';
import { inputs, job, machine, NOW, policy, reading } from './support.ts';

const six = machine({ maxLanes: 6 });
// The issue's case: soft 70%, hard 97%.
const limits = { ...policy, softLimit: 0.7, hardLimit: 0.97 };
const at = (used: number, p = limits, m = six) => laneEffect(m, [reading(used)], p, NOW);

describe('the soft lanes (issue #2091)', () => {
  it('below soft every lane is open', () => {
    expect(at(0)).toMatchObject({ cap: 6, band: 'free' });
    expect(at(69.9)).toMatchObject({ cap: 6, band: 'free' });
  });

  it('from soft up to just under hard the cap is the soft lanes, 1 when none are set', () => {
    for (const used of [70, 80, 93, 96.9]) expect(at(used)).toMatchObject({ cap: 1, band: 'soft' });
    for (const used of [70, 93, 96.9]) expect(at(used, { ...limits, softLanes: 3 })).toMatchObject({ cap: 3, band: 'soft' });
  });

  it('at hard nothing new starts, whatever the soft lanes', () => {
    expect(at(97, { ...limits, softLanes: 3 })).toMatchObject({ cap: 0, band: 'hard' });
    expect(at(100)).toMatchObject({ cap: 0, band: 'hard' });
  });

  it('0 soft lanes: nothing new starts from soft', () => {
    expect(at(80, { ...limits, softLanes: 0 })).toMatchObject({ cap: 0, band: 'soft' });
  });

  it('the soft lanes are capped by maxLanes', () => {
    expect(at(80, { ...limits, softLanes: 10 })).toMatchObject({ cap: 6, band: 'soft' });
    expect(at(80, { ...limits, softLanes: 10 }, machine({ maxLanes: 2 }))).toMatchObject({ cap: 2, band: 'soft' });
  });

  it('a machine\'s own soft lanes win over the user\'s; with none of its own, the user\'s apply', () => {
    const own = machine({ maxLanes: 6, usageLimits: { soft: 0.5, hard: 0.9, softLanes: 2 } });
    expect(at(60, { ...limits, softLanes: 4 }, own)).toMatchObject({ cap: 2, band: 'soft' });
    const limitsOnly = machine({ maxLanes: 6, usageLimits: { soft: 0.5, hard: 0.9 } });
    expect(at(60, { ...limits, softLanes: 4 }, limitsOnly)).toMatchObject({ cap: 4, band: 'soft' });
  });

  it('the Decision starts as many jobs as the soft lanes, and the wait names the soft limit', () => {
    const d = decide(inputs({ machines: [six], policy: { ...limits, softLanes: 2 }, usage: [reading(93)], waiting: ['a', 'b', 'c'].map((id) => job(id)) }), 'd1');
    expect(d.start).toHaveLength(2);
    expect(d.wait[0]!.reason).toContain('lane cap is 2 (usage soft limit');
  });
});
