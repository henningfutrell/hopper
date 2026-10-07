import { describe, expect, it } from 'vitest';
import { decide } from '../../src/decider/index.ts';
import { busy, inputs, job, lane, machine, reading } from './support.ts';

const plan = (d: ReturnType<typeof decide>, id = 'local') => d.lanes.find((l) => l.machineId === id)!;

describe('lane scaling', () => {
  it('scales up from 0 lanes when jobs wait', () => {
    const d = decide(inputs({ waiting: [job('a'), job('b'), job('c')] }), 'd1');
    expect(d.start.map((s) => s.jobId)).toEqual(['a', 'b', 'c']);
    expect(d.start.every((s) => s.laneId === null)).toBe(true);
    expect(plan(d)).toMatchObject({ current: 0, target: 3, open: 3 });
  });

  it('caps starts at maxLanes; the rest wait for a lane', () => {
    const waiting = ['a', 'b', 'c', 'd', 'e'].map((id) => job(id));
    const d = decide(inputs({ waiting }), 'd1');
    expect(d.start).toHaveLength(4);
    expect(d.wait).toEqual([{ jobId: 'e', reason: expect.stringContaining('lane cap is 4') }]);
  });

  it('closes an idle lane past the grace period', () => {
    const l = lane(1, { idleSince: '2026-10-02T11:59:50.000Z' });
    const d = decide(inputs({ lanes: [l] }), 'd1');
    expect(plan(d)).toMatchObject({ current: 1, target: 0, open: 0, close: [l.id] });
  });

  it('keeps an idle lane within the grace period', () => {
    const l = lane(1, { idleSince: '2026-10-02T11:59:58.000Z' });
    const d = decide(inputs({ lanes: [l] }), 'd1');
    expect(plan(d).close).toEqual([]);
  });

  it('uses an existing idle lane instead of opening one', () => {
    const l = lane(1);
    const d = decide(inputs({ lanes: [l], waiting: [job('a')] }), 'd1');
    expect(d.start[0]!).toMatchObject({ jobId: 'a', laneId: l.id });
    expect(plan(d)).toMatchObject({ open: 0, close: [] });
  });

  it('open equals the number of starts with laneId null', () => {
    const lanes = [lane(1), busy(2, 'r1')];
    const running = [job('r1', { status: 'running' })];
    const d = decide(inputs({ lanes, running, waiting: [job('a'), job('b'), job('c')] }), 'd1');
    const nulls = d.start.filter((s) => s.laneId === null).length;
    expect(nulls).toBe(2);
    expect(plan(d).open).toBe(nulls);
    expect(d.start).toHaveLength(3);
  });

  it('does not keep idle lanes beyond the cap', () => {
    const lanes = [busy(1, 'r1'), lane(2, { idleSince: '2026-10-02T11:59:59.000Z' })];
    const d = decide(inputs({ machines: [machine({ maxLanes: 1 })], lanes, running: [job('r1', { status: 'running' })] }), 'd1');
    expect(plan(d).close).toEqual(['local/lane-2']);
  });

  it('treats a lane with no idleSince as past grace', () => {
    const d = decide(inputs({ lanes: [lane(1, { idleSince: undefined })] }), 'd1');
    expect(plan(d).close).toEqual(['local/lane-1']);
  });
});

describe('usage limits', () => {
  it('soft limit scales the cap linearly', () => {
    // used 0.825: floor(4 * (0.95-0.825)/(0.95-0.7)) = floor(2) = 2
    const d = decide(inputs({ usage: [reading(82.5)], waiting: ['a', 'b', 'c'].map((i) => job(i)) }), 'd1');
    expect(d.start).toHaveLength(2);
    expect(plan(d).target).toBe(2);
    expect(d.wait[0]!.reason).toContain('lane cap is 2 (usage soft limit');
  });

  it('below soft keeps maxLanes; max over readings applies; machine-scoped readings only hit that machine', () => {
    const d = decide(inputs({
      machines: [machine(), machine({ id: 'other', label: 'other' })],
      usage: [reading(10), reading(99, 100, { machineId: 'other' })],
      waiting: [job('a')],
    }), 'd1');
    expect(d.start[0]!.machineId).toBe('local');
    expect(plan(d, 'other').target).toBe(0);
  });

  it('a machine with readings of its own (its own account) is not capped by the readings of every machine', () => {
    const d = decide(inputs({
      machines: [machine(), machine({ id: 'laptop', label: 'laptop' })],
      usage: [reading(99), reading(10, 100, { machineId: 'laptop' }), reading(99, 100, { machineId: 'laptop', informational: true })],
      waiting: [job('a')],
    }), 'd1');
    expect(plan(d).target).toBe(0);
    expect(d.start[0]!.machineId).toBe('laptop');
  });

  it('hard limit: cap 0, idle closed, busy drained, nothing starts, the wait names usage', () => {
    const lanes = [lane(1), busy(2, 'r1'), busy(3, 'r2')];
    const running = [job('r1', { status: 'running' }), job('r2', { status: 'running' })];
    const d = decide(inputs({ usage: [reading(96)], lanes, running, waiting: [job('a')] }), 'd1');
    expect(d.start).toEqual([]);
    expect(d.wait[0]!.reason).toMatch(/usage hard limit/);
    expect(plan(d)).toMatchObject({ target: 0, open: 0, close: ['local/lane-1'], drain: ['local/lane-3', 'local/lane-2'] });
  });

  it('an informational reading (a window of one model) never throttles lanes', () => {
    const fable = reading(99, 100, { window: 'week (Fable)', informational: true, unit: '%' });
    const d = decide(inputs({ usage: [fable], waiting: ['a', 'b', 'c'].map((i) => job(i)) }), 'd1');
    expect(d.start).toHaveLength(3);
    expect(plan(d).target).toBe(3);
  });

  it('a session reading at 80% scales lanes down while an informational one at 99% is ignored', () => {
    // used 0.8: floor(4 * (0.95-0.8)/(0.95-0.7)) = floor(2.4) = 2
    const usage = [
      reading(80, 100, { window: 'session', unit: '%' }),
      reading(30, 100, { window: 'week', unit: '%' }),
      reading(99, 100, { window: 'week (Fable)', informational: true, unit: '%' }),
    ];
    const d = decide(inputs({ usage, waiting: ['a', 'b', 'c', 'd'].map((i) => job(i)) }), 'd1');
    expect(d.start).toHaveLength(2);
    expect(plan(d).target).toBe(2);
    expect(d.wait[0]!.reason).toContain('lane cap is 2 (usage soft limit');
  });

  it('ignores readings with limit <= 0 and says so', () => {
    const d = decide(inputs({ usage: [reading(5, 0, { source: 'broken' })], waiting: [job('a')] }), 'd1');
    expect(d.start).toHaveLength(1);
    expect(d.reasons.join('\n')).toContain('broken');
  });
});

describe('draining', () => {
  it('counts draining lanes as occupied: no repeated drain on identical input', () => {
    const lanes = [busy(1, 'r1'), busy(2, 'r2', { state: 'draining' })];
    const running = [job('r1', { status: 'running' }), job('r2', { status: 'running' })];
    const d = decide(inputs({ usage: [reading(96)], lanes, running }), 'd1');
    // cap 0, occupied 2, one already draining -> drain exactly the other busy one
    expect(plan(d).drain).toEqual(['local/lane-1']);
    const lanes2 = [busy(1, 'r1', { state: 'draining' }), busy(2, 'r2', { state: 'draining' })];
    const d2 = decide(inputs({ usage: [reading(96)], lanes: lanes2, running }), 'd2');
    expect(plan(d2).drain).toEqual([]);
    expect(plan(d2).current).toBe(2);
  });

  it('a draining lane takes room: no start beyond cap', () => {
    const lanes = [busy(1, 'r1', { state: 'draining' })];
    const d = decide(inputs({ machines: [machine({ maxLanes: 1 })], lanes, running: [job('r1', { status: 'running' })], waiting: [job('a')] }), 'd1');
    expect(d.start).toEqual([]);
    expect(d.wait[0]!.reason).toContain('lane cap is 1, all 1 in use');
  });
});
