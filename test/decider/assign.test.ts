import { describe, expect, it } from 'vitest';
import { decide } from '../../src/decider/index.ts';
import { inputs, job, machine } from './support.ts';

describe('assignment and native holds', () => {
  it('offline machine: cap 0, jobs held', () => {
    const d = decide(inputs({ machines: [machine({ online: false })], waiting: [job('a')] }), 'd1');
    expect(d.start).toEqual([]);
    expect(d.hold).toHaveLength(1);
    expect(d.lanes[0]).toMatchObject({ target: 0, open: 0 });
  });

  it('orders by priority desc, then createdAt asc, then id', () => {
    const waiting = [
      job('z', { priority: 50, createdAt: '2026-10-02T11:00:00.000Z' }),
      job('b', { priority: 50, createdAt: '2026-10-02T10:00:00.000Z' }),
      job('a', { priority: 50, createdAt: '2026-10-02T10:00:00.000Z' }),
      job('hi', { priority: 90 }),
    ];
    const d = decide(inputs({ waiting }), 'd1');
    expect(d.start.map((s) => s.jobId)).toEqual(['hi', 'a', 'b', 'z']);
  });

  it('holds a job whose executor no online machine runs', () => {
    const d = decide(inputs({ waiting: [job('a', { executor: 'nope' })] }), 'd1');
    expect(d.start).toEqual([]);
    expect(d.hold[0].reason).toContain('nope');
  });

  it('honours a pinned machine, holds when it is unknown or offline', () => {
    const machines = [machine(), machine({ id: 'm2', label: 'm2' }), machine({ id: 'm3', label: 'm3', online: false })];
    const d = decide(inputs({
      machines,
      waiting: [job('p', { machineId: 'm2' }), job('u', { machineId: 'ghost' }), job('o', { machineId: 'm3' })],
    }), 'd1');
    expect(d.start).toHaveLength(1);
    expect(d.start[0]).toMatchObject({ jobId: 'p', machineId: 'm2' });
    expect(d.hold.map((h) => h.jobId).sort()).toEqual(['o', 'u']);
    expect(d.hold.find((h) => h.jobId === 'u')!.reason).toContain('ghost');
  });

  it('spreads over machines by most remaining room, tie by machine id', () => {
    const machines = [machine({ id: 'b', maxLanes: 2 }), machine({ id: 'a', maxLanes: 2 })];
    const d = decide(inputs({ machines, waiting: [job('1'), job('2'), job('3')] }), 'd1');
    expect(d.start.map((s) => s.machineId)).toEqual(['a', 'b', 'a']);
    for (const p of d.lanes) {
      expect(p.open).toBe(d.start.filter((s) => s.machineId === p.machineId && s.laneId === null).length);
    }
  });
});

describe('decision shape', () => {
  it('is deterministic, carries inputs verbatim, and has reasons', () => {
    const i = inputs({ waiting: [job('a'), job('b')], jevMode: 'active' });
    const snapshot = structuredClone(i);
    const d1 = decide(i, 'd1');
    const d2 = decide(i, 'd1');
    expect(d2).toEqual(d1);
    expect(d1.inputs).toEqual(snapshot);
    expect(i).toEqual(snapshot);
    expect(d1).toMatchObject({ id: 'd1', at: i.at, trigger: 'tick', jevMode: 'active' });
    expect(d1.reasons.length).toBeGreaterThan(0);
    expect(d1.reasons.every((r) => r.length > 0)).toBe(true);
    expect(d1.lanes.every((l) => l.reason.length > 0)).toBe(true);
  });

  it('an empty queue still yields a reason and a plan per machine', () => {
    const d = decide(inputs(), 'd1');
    expect(d.reasons.length).toBeGreaterThan(0);
    expect(d.lanes).toHaveLength(1);
  });
});
