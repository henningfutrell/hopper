// Issue #2919: a usage source that throttles a machine's executors but has no reading now (its read failed, or it is
// stale) leaves that machine's usage unknown. Unknown is never 0%: the lane effect's band is `unknown`, and the machine
// keeps only its soft lanes until a reading comes back. Readings, when there are any, set the band as before.
import { describe, expect, it } from 'vitest';
import { decide } from '../../src/decider/index.ts';
import { laneEffect, unreadUsageOf } from '../../src/decider/usage.ts';
import { inputs, job, machine, NOW, policy, reading } from './support.ts';

const six = machine({ id: 'm', maxLanes: 6, executors: ['claude', 'command'] });
const limits = { ...policy, softLimit: 0.7, hardLimit: 0.99, softLanes: 1 };
const unread = [{ source: 'claude-m', machineId: 'm', executors: ['claude'] }];

describe('unread usage sources (issue #2919)', () => {
  it('a source with no readings and a problem is unread on the machine it names', () => {
    expect(unreadUsageOf([
      { name: 'claude-m', readings: [], state: { problem: 'usage unavailable: x', executors: ['claude'], account: { service: 'claude', detail: { machine: 'm' } } } },
      { name: 'ok', readings: [reading(10, 100, { source: 'ok', machineId: 'm' })], state: { problem: 'stale: x' } },
      { name: 'quiet', readings: [], state: { refreshedAt: NOW } },
      { name: 'global', readings: [], state: { problem: 'not read yet' } },
    ])).toEqual([{ source: 'claude-m', machineId: 'm', executors: ['claude'] }, { source: 'global' }]);
  });

  it('no reading of an executor whose source is unread: band unknown, the soft lanes, never free', () => {
    const effect = laneEffect(six, [], limits, NOW, unread);
    expect(effect.executors[0]).toMatchObject({ executor: 'claude', cap: 1, band: 'unknown', unknown: ['claude-m'] });
    // The other executor's jobs are not limited by that source: the machine keeps its lanes for them.
    expect(effect.executors[1]).toMatchObject({ executor: 'command', cap: 6, band: 'free' });
    expect(effect).toMatchObject({ cap: 6, band: 'free' });
  });

  it('a machine whose every executor is unread: the machine itself is unknown', () => {
    const one = machine({ id: 'm', maxLanes: 6, executors: ['claude'] });
    expect(laneEffect(one, [], limits, NOW, unread)).toMatchObject({ cap: 1, band: 'unknown', unknown: ['claude-m'] });
    expect(laneEffect(one, [], limits, NOW, [{ source: 'all' }])).toMatchObject({ cap: 1, band: 'unknown', unknown: ['all'] });
    // An unread source of another machine does not touch this one.
    expect(laneEffect(one, [], limits, NOW, [{ source: 'x', machineId: 'other' }])).toMatchObject({ cap: 6, band: 'free' });
    expect(laneEffect({ ...one, online: false }, [], limits, NOW, unread)).toMatchObject({ cap: 0, band: 'offline' });
  });

  it('a reading that throttles the executor wins over the unread source', () => {
    const one = machine({ id: 'm', maxLanes: 6, executors: ['claude'] });
    const week = reading(20, 100, { source: 'other', machineId: 'm', window: 'week', executors: ['claude'] });
    expect(laneEffect(one, [week], limits, NOW, unread)).toMatchObject({ cap: 6, band: 'free', usedFrac: 0.2 });
  });

  it('the decider starts only the soft lanes and says the usage is unknown, not 0%', () => {
    const one = machine({ id: 'm', maxLanes: 6, executors: ['claude'] });
    const d = decide(inputs({
      machines: [one], usage: [], unreadUsage: unread, policy: limits,
      waiting: [job('a', { executor: 'claude' }), job('b', { executor: 'claude' })],
    }), 'd1');
    expect(d.start).toHaveLength(1);
    expect(d.reasons).toContain('m: usage unknown (claude-m has no reading), lane cap 1 of 6 (unknown)');
  });
});
