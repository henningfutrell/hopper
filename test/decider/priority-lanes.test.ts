// Issue #535: priority lanes. A high-priority job takes a free priority lane ahead of any default or low job; while
// none waits, a priority lane stays free (keep-free) or takes a default job (share), never a low one. Under a usage
// limit, high-priority work is the last to be drained.
import { describe, expect, it } from 'vitest';
import { decide } from '../../src/decider/index.ts';
import type { PriorityLanesInput } from '../../src/domain/types.ts';
import { busy, inputs, job, lane, machine, policy, reading } from './support.ts';

const keepFree = (lanes: string[]): PriorityLanesInput => ({ lanes, highPriority: 75, whenIdle: 'keep-free' });
const share = (lanes: string[]): PriorityLanesInput => ({ lanes, highPriority: 75, whenIdle: 'share' });
const plan = (d: ReturnType<typeof decide>, id = 'local') => d.lanes.find((l) => l.machineId === id)!;

describe('priority lanes', () => {
  it('keep-free: default jobs stay off the priority lane, and the one left waits saying so', () => {
    const waiting = ['a', 'b', 'c', 'd'].map((id) => job(id));
    const d = decide(inputs({ waiting, priorityLanes: keepFree(['local/lane-1']) }), 'd1');
    expect(d.start.map((s) => [s.jobId, s.opens])).toEqual([['a', 'local/lane-2'], ['b', 'local/lane-3'], ['c', 'local/lane-4']]);
    expect(d.wait).toEqual([{
      jobId: 'd',
      reason: 'waiting for a lane: machine local keeps priority lane local/lane-1 free for high-priority jobs, the other 3 are in use',
    }]);
    expect(plan(d)).toMatchObject({ open: 3, idle: 'priority lane local/lane-1 kept free for high-priority jobs' });
  });

  it('a high-priority job takes the free priority lane ahead of a default job waiting longer', () => {
    const lanes = [busy(2, 'r2'), busy(3, 'r3'), busy(4, 'r4')];
    const running = ['r2', 'r3', 'r4'].map((id) => job(id, { status: 'running' }));
    const waiting = [job('d', { createdAt: '2026-10-02T10:00:00.000Z' }), job('h', { priority: 75 })];
    const d = decide(inputs({ lanes, running, waiting, priorityLanes: keepFree(['local/lane-1']) }), 'd1');
    expect(d.start).toEqual([expect.objectContaining({ jobId: 'h', laneId: null, opens: 'local/lane-1', reason: expect.stringContaining('priority lane local/lane-1') })]);
    expect(d.wait.map((w) => w.jobId)).toEqual(['d']);
  });

  it('a high-priority job takes an open idle priority lane, and other jobs take the other idle lanes', () => {
    const lanes = [lane(1), lane(2)];
    const waiting = [job('d'), job('h', { priority: 90 })];
    const d = decide(inputs({ lanes, waiting, priorityLanes: keepFree(['local/lane-1']) }), 'd1');
    expect(d.start.map((s) => [s.jobId, s.laneId])).toEqual([['h', 'local/lane-1'], ['d', 'local/lane-2']]);
  });

  it('a high-priority job goes to the machine holding the free priority lane', () => {
    const a = machine({ id: 'a', label: 'a' });
    const b = machine({ id: 'b', label: 'b' });
    const d = decide(inputs({ machines: [a, b], waiting: [job('h', { priority: 80 })], priorityLanes: keepFree(['b/lane-2']) }), 'd1');
    expect(d.start).toEqual([expect.objectContaining({ jobId: 'h', machineId: 'b', opens: 'b/lane-2' })]);
  });

  it('with the priority lanes busy, a high-priority job takes any other free lane', () => {
    const lanes = [busy(1, 'h1')];
    const running = [job('h1', { status: 'running', priority: 80 })];
    const d = decide(inputs({ lanes, running, waiting: [job('h2', { priority: 80 })], priorityLanes: keepFree(['local/lane-1']) }), 'd1');
    expect(d.start).toEqual([expect.objectContaining({ jobId: 'h2', opens: 'local/lane-2' })]);
  });

  it('share: a default job takes the priority lane last, once every other lane is in use', () => {
    const waiting = ['a', 'b', 'c', 'd'].map((id) => job(id));
    const d = decide(inputs({ waiting, priorityLanes: share(['local/lane-1']) }), 'd1');
    expect(d.start.map((s) => s.opens)).toEqual(['local/lane-2', 'local/lane-3', 'local/lane-4', 'local/lane-1']);
  });

  it('share: a low job never takes a priority lane', () => {
    const waiting = ['a', 'b', 'c', 'd'].map((id) => job(id, { priority: 25 }));
    const d = decide(inputs({ waiting, priorityLanes: share(['local/lane-1']) }), 'd1');
    expect(d.start).toHaveLength(3);
    expect(d.wait).toEqual([{ jobId: 'd', reason: expect.stringContaining('keeps priority lane local/lane-1 free for high-priority jobs') }]);
  });

  it('under a usage limit, the lowest-priority busy lane drains first, high-priority work last', () => {
    // used 80% between soft 70% and hard 95%: cap floor(4 × 0.15 / 0.25) = 2 of the 3 busy lanes.
    const lanes = [
      busy(1, 'low', { openedAt: '2026-10-02T10:01:00.000Z' }),
      busy(2, 'mid', { openedAt: '2026-10-02T10:02:00.000Z' }),
      busy(3, 'high', { openedAt: '2026-10-02T10:03:00.000Z' }),
    ];
    const running = [job('low', { status: 'running', priority: 50 }), job('mid', { status: 'running', priority: 50 }), job('high', { status: 'running', priority: 80 })];
    const d = decide(inputs({ lanes, running, usage: [reading(80)], policy, priorityLanes: keepFree([]) }), 'd1');
    expect(plan(d)).toMatchObject({ target: 2, drain: ['local/lane-2'] });
  });

  it('without priority lanes, placement names no lane to open', () => {
    const d = decide(inputs({ waiting: [job('a'), job('h', { priority: 90 })] }), 'd1');
    expect(d.start.every((s) => s.opens === undefined)).toBe(true);
  });
});
