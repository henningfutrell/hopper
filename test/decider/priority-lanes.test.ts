// Issue #535: priority lanes. A high-priority job takes a free priority lane ahead of any default or low job. Issue
// #788: a priority lane is held only while a high-priority job still to be placed needs it (keep-free; in share, only
// from low jobs); with none, any job takes it, last. Under a usage limit, high-priority work is the last to be drained.
import { describe, expect, it } from 'vitest';
import { decide } from '../../src/decider/index.ts';
import type { PriorityLanesInput } from '../../src/domain/types.ts';
import { busy, inputs, job, lane, machine, policy, reading } from './support.ts';

const keepFree = (lanes: string[]): PriorityLanesInput => ({ lanes, highPriority: 75, whenIdle: 'keep-free' });
const share = (lanes: string[]): PriorityLanesInput => ({ lanes, highPriority: 75, whenIdle: 'share' });
const plan = (d: ReturnType<typeof decide>, id = 'local') => d.lanes.find((l) => l.machineId === id)!;

describe('priority lanes', () => {
  it('keep-free: with no high-priority job waiting, default jobs take the priority lane last', () => {
    const waiting = ['a', 'b', 'c', 'd', 'e'].map((id) => job(id));
    const d = decide(inputs({ waiting, priorityLanes: keepFree(['local/lane-1']) }), 'd1');
    expect(d.start.map((s) => [s.jobId, s.opens])).toEqual([['a', 'local/lane-2'], ['b', 'local/lane-3'], ['c', 'local/lane-4'], ['d', 'local/lane-1']]);
    expect(d.wait.map((w) => w.jobId)).toEqual(['e']);
  });

  it('every lane a priority lane, only default and low jobs waiting: they all run', () => {
    const all = ['local/lane-1', 'local/lane-2', 'local/lane-3', 'local/lane-4'];
    const waiting = [job('a'), job('b'), job('c', { priority: 25 }), job('d', { priority: 25 })];
    for (const pl of [keepFree(all), share(all)]) {
      const d = decide(inputs({ waiting, priorityLanes: pl }), 'd1');
      expect(d.start.map((s) => s.jobId)).toEqual(['a', 'b', 'c', 'd']);
      expect(d.wait).toEqual([]);
    }
  });

  it('a priority lane a high-priority job left goes back to default jobs', () => {
    const lanes = [lane(1), busy(2, 'r2'), busy(3, 'r3'), busy(4, 'r4')];
    const running = ['r2', 'r3', 'r4'].map((id) => job(id, { status: 'running' }));
    const d = decide(inputs({ lanes, running, waiting: [job('d')], priorityLanes: keepFree(['local/lane-1']) }), 'd1');
    expect(d.start).toEqual([expect.objectContaining({ jobId: 'd', laneId: 'local/lane-1' })]);
  });

  it('keep-free: a default job ahead in the queue order leaves the priority lane to a high-priority job after it', () => {
    const lanes = [busy(2, 'r2'), busy(3, 'r3'), busy(4, 'r4')];
    const running = ['r2', 'r3', 'r4'].map((id) => job(id, { status: 'running' }));
    const waiting = [job('d'), job('h', { priority: 80 })];
    const d = decide(inputs({ lanes, running, waiting, priorityLanes: keepFree(['local/lane-1']), queueOrder: { sorter: 'oldest', jobIds: ['d', 'h'] } }), 'd1');
    expect(d.start).toEqual([expect.objectContaining({ jobId: 'h', opens: 'local/lane-1' })]);
    expect(d.wait).toEqual([{
      jobId: 'd',
      reason: 'waiting for a lane: machine local holds priority lane local/lane-1 for high-priority jobs still to be placed, the other 3 are in use',
    }]);
  });

  it('keep-free: default jobs leave only as many priority lanes as high-priority jobs still to be placed', () => {
    const all = ['local/lane-1', 'local/lane-2', 'local/lane-3', 'local/lane-4'];
    const waiting = [job('a'), job('b'), job('c'), job('d'), job('h', { priority: 80 })];
    const d = decide(inputs({ waiting, priorityLanes: keepFree(all), queueOrder: { sorter: 'oldest', jobIds: ['a', 'b', 'c', 'd', 'h'] } }), 'd1');
    expect(d.start.map((s) => s.jobId)).toEqual(['a', 'b', 'c', 'h']);
    expect(d.wait.map((w) => w.jobId)).toEqual(['d']);
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

  it('share: a low job leaves the priority lane to a high-priority job still to be placed, a default job does not', () => {
    const lanes = [busy(2, 'r2'), busy(3, 'r3'), busy(4, 'r4')];
    const running = ['r2', 'r3', 'r4'].map((id) => job(id, { status: 'running' }));
    const order = (first: string) => ({ sorter: 'oldest' as const, jobIds: [first, 'h'] });
    const low = decide(inputs({ lanes, running, waiting: [job('l', { priority: 25 }), job('h', { priority: 80 })], priorityLanes: share(['local/lane-1']), queueOrder: order('l') }), 'd1');
    expect(low.start.map((s) => s.jobId)).toEqual(['h']);
    expect(low.wait).toEqual([{ jobId: 'l', reason: expect.stringContaining('holds priority lane local/lane-1 for high-priority jobs') }]);
    const def = decide(inputs({ lanes, running, waiting: [job('d'), job('h', { priority: 80 })], priorityLanes: share(['local/lane-1']), queueOrder: order('d') }), 'd1');
    expect(def.start.map((s) => s.jobId)).toEqual(['d']);
  });

  it('under a usage limit, the lowest-priority busy lane drains first, high-priority work last', () => {
    // used 80% between soft 70% and hard 95%: cap 2 (the soft lanes) of the 3 busy lanes.
    const lanes = [
      busy(1, 'low', { openedAt: '2026-10-02T10:01:00.000Z' }),
      busy(2, 'mid', { openedAt: '2026-10-02T10:02:00.000Z' }),
      busy(3, 'high', { openedAt: '2026-10-02T10:03:00.000Z' }),
    ];
    const running = [job('low', { status: 'running', priority: 50 }), job('mid', { status: 'running', priority: 50 }), job('high', { status: 'running', priority: 80 })];
    const d = decide(inputs({ lanes, running, usage: [reading(80)], policy: { ...policy, softLanes: 2 }, priorityLanes: keepFree([]) }), 'd1');
    expect(plan(d)).toMatchObject({ target: 2, drain: ['local/lane-2'] });
  });

  it('without priority lanes, placement names no lane to open', () => {
    const d = decide(inputs({ waiting: [job('a'), job('h', { priority: 90 })] }), 'd1');
    expect(d.start.every((s) => s.opens === undefined)).toBe(true);
  });
});
