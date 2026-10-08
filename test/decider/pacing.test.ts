// Usage pacing (issue #373): the burn window before a week window's reset, reset-aware placement,
// and one lane over the cap for a critical job.
import { describe, expect, it } from 'vitest';
import { decide } from '../../src/decider/index.ts';
import { laneEffect } from '../../src/decider/usage.ts';
import { busy, inputs, job, lane, machine, NOW, policy, reading } from './support.ts';

const H = 3_600_000;
const inHours = (h: number): string => new Date(Date.parse(NOW) + h * H).toISOString();
const week = (used: number, resetInHours: number, machineId?: string) =>
  reading(used, 100, { window: 'week', resetsAt: inHours(resetInHours), ...(machineId ? { machineId } : {}) });
const pacing = { burnWindowMs: 0, resetAwarePlacement: false, criticalPriority: 0 };
const paced = (over: Partial<typeof pacing>) => ({ ...policy, pacing: { ...pacing, ...over } });
const burning = paced({ burnWindowMs: 18 * H });

describe('burn window (issue #373)', () => {
  it('a week window inside its burn window and not spent stops throttling: the job starts', () => {
    const d = decide(inputs({ usage: [week(96, 10)], waiting: [job('a')], policy: burning }), 'd1');
    expect(d.start.map((s) => s.jobId)).toEqual(['a']);
    expect(d.reasons.join('\n')).toContain('local: usage window week of fake is in its burn window');
  });

  it('without a burn window the same reading stops the machine', () => {
    const d = decide(inputs({ usage: [week(96, 10)], waiting: [job('a')] }), 'd1');
    expect(d.start).toEqual([]);
    expect(d.wait[0]!.reason).toContain('usage hard limit');
  });

  it('a burn window of 0 is off', () => {
    const d = decide(inputs({ usage: [week(96, 10)], waiting: [job('a')], policy: paced({}) }), 'd1');
    expect(d.start).toEqual([]);
  });

  it('a spent week window still stops the machine inside its burn window', () => {
    const d = decide(inputs({ usage: [week(100, 10)], waiting: [job('a')], policy: burning }), 'd1');
    expect(d.start).toEqual([]);
  });

  it('a week window further from its reset than the burn window still throttles', () => {
    const d = decide(inputs({ usage: [week(96, 30)], waiting: [job('a')], policy: burning }), 'd1');
    expect(d.start).toEqual([]);
  });

  it('a session window never burns', () => {
    const session = reading(96, 100, { window: 'session', resetsAt: inHours(2) });
    const d = decide(inputs({ usage: [session, week(50, 10)], waiting: [job('a')], policy: burning }), 'd1');
    expect(d.start).toEqual([]);
  });

  it('a reading whose window has reset since it was read no longer throttles', () => {
    const d = decide(inputs({ usage: [week(96, -1)], waiting: [job('a')] }), 'd1');
    expect(d.start.map((s) => s.jobId)).toEqual(['a']);
  });

  it('the lane effect reads the clock: a burning window shows as not throttling', () => {
    const effect = laneEffect(machine(), [week(96, 10)], burning, NOW);
    expect(effect).toMatchObject({ cap: 4, band: 'free' });
    expect(laneEffect(machine(), [week(96, 10)], burning, inHours(-20))).toMatchObject({ cap: 0, band: 'hard' });
  });
});

describe('reset-aware placement (issue #373)', () => {
  const machines = [machine({ id: 'a-far', label: 'a-far' }), machine({ id: 'b-near', label: 'b-near' })];

  it('prefers the machine whose account has the most week headroom per hour left before its reset', () => {
    const usage = [week(20, 96, 'a-far'), week(20, 11, 'b-near')];
    const lanes = [busy(1, 'x', { machineId: 'b-near' }), busy(2, 'y', { machineId: 'b-near' })];
    const d = decide(inputs({ machines, usage, lanes, waiting: [job('j')], policy: paced({ resetAwarePlacement: true }) }), 'd1');
    expect(d.start[0]).toMatchObject({ jobId: 'j', machineId: 'b-near' });
    expect(d.start[0]!.reason).toContain('placement pressure');
  });

  it('a burning window counts its headroom to 100%', () => {
    const usage = [week(96, 10, 'a-far'), week(60, 96, 'b-near')];
    const p = paced({ resetAwarePlacement: true, burnWindowMs: 18 * H });
    const d = decide(inputs({ machines, usage, waiting: [job('j')], policy: p }), 'd1');
    expect(d.start[0]).toMatchObject({ jobId: 'j', machineId: 'a-far' });
  });

  it('off: the most room, then the lowest machine id', () => {
    const usage = [week(20, 96, 'a-far'), week(20, 11, 'b-near')];
    const lanes = [busy(1, 'x', { machineId: 'b-near' })];
    const d = decide(inputs({ machines, usage, lanes, waiting: [job('j')] }), 'd1');
    expect(d.start[0]).toMatchObject({ jobId: 'j', machineId: 'a-far' });
  });
});

describe('critical priority (issue #373)', () => {
  const full = [busy(1, 'x'), busy(2, 'y'), busy(3, 'z'), busy(4, 'w')];
  const critical = paced({ criticalPriority: 100 });

  it('a critical job that fits nowhere takes one lane over the cap; the lane plan keeps it', () => {
    const d = decide(inputs({ lanes: full, waiting: [job('c', { priority: 100 })], policy: critical }), 'd1');
    expect(d.start).toEqual([expect.objectContaining({ jobId: 'c', laneId: null, machineId: 'local' })]);
    expect(d.start[0]!.reason).toContain('critical priority: one lane over the cap');
    expect(d.lanes[0]).toMatchObject({ open: 1, target: 5, drain: [] });
  });

  it('one extra lane per machine: a second critical job waits', () => {
    const d = decide(inputs({ lanes: full, waiting: [job('c1', { priority: 100 }), job('c2', { priority: 100 })], policy: critical }), 'd1');
    expect(d.start.map((s) => s.jobId)).toEqual(['c1']);
    expect(d.wait.map((w) => w.jobId)).toEqual(['c2']);
  });

  it('a machine already over its cap takes no extra lane', () => {
    const over = [...full, busy(5, 'v')];
    const d = decide(inputs({ lanes: over, waiting: [job('c', { priority: 100 })], policy: critical }), 'd1');
    expect(d.start).toEqual([]);
  });

  it('below the critical priority, or with it off, the job waits', () => {
    expect(decide(inputs({ lanes: full, waiting: [job('c', { priority: 99 })], policy: critical }), 'd1').start).toEqual([]);
    expect(decide(inputs({ lanes: full, waiting: [job('c', { priority: 100 })] }), 'd1').start).toEqual([]);
  });

  it('never on a machine at its hard limit, nor off its pin', () => {
    const hard = decide(inputs({ lanes: [], usage: [reading(96)], waiting: [job('c', { priority: 100 })], policy: critical }), 'd1');
    expect(hard.start).toEqual([]);
    const machines = [machine(), machine({ id: 'm2', label: 'm2' })];
    const lanes = [...full, ...[1, 2, 3, 4].map((n) => busy(n, `m2-${n}`, { machineId: 'm2' }))];
    const pinned = decide(inputs({ machines, lanes, waiting: [job('c', { priority: 100, machineId: 'm2' })], policy: critical }), 'd1');
    expect(pinned.start).toEqual([expect.objectContaining({ jobId: 'c', machineId: 'm2' })]);
  });

  it('may take a reserved lane, inside the machine\'s cap', () => {
    const lanes = full.slice(0, 3);
    const d = decide(inputs({ machines: [machine({ reservedLanes: 1 })], lanes, waiting: [job('c', { priority: 100 })], policy: critical }), 'd1');
    expect(d.start).toEqual([expect.objectContaining({ jobId: 'c', machineId: 'local' })]);
    expect(d.start[0]!.reason).toContain('past the executor\'s lane cap or the reserved lanes');
    expect(d.lanes[0]).toMatchObject({ open: 1, target: 4 });
  });

  it('takes an idle lane left over the cap before opening one', () => {
    // 75% → soft band, cap 3: three busy, and an idle lane the cap leaves no room for.
    const lanes = [...full.slice(0, 3), lane(4)];
    const d = decide(inputs({ lanes, usage: [reading(75)], waiting: [job('c', { priority: 100 })], policy: critical }), 'd1');
    expect(d.start).toEqual([expect.objectContaining({ jobId: 'c', laneId: 'local/lane-4' })]);
    expect(d.lanes[0]).toMatchObject({ open: 0, target: 4, close: [], drain: [] });
  });
});
