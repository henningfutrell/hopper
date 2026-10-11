// Specialty jobs elbow in (issue #762): only a job designated specialty starts a lane past the machine's lane cap,
// at most the machine's elbow-ins over it at once; never at a usage hard limit or under resource pressure.
import { describe, expect, it } from 'vitest';
import { decide } from '../../src/decider/index.ts';
import type { Job } from '../../src/domain/types.ts';
import { busy, inputs, job, machine, reading } from './support.ts';

const full = [busy(1, 'x'), busy(2, 'y'), busy(3, 'z'), busy(4, 'w')];
const specialty = (id: string, over: Partial<Job> = {}): Job => {
  const j = job(id, over);
  return { ...j, spec: { ...j.spec, specialty: true } };
};
const running = (id: string, over: Partial<Job> = {}): Job => ({ ...job(id, over), status: 'running' });

describe('specialty jobs elbow in (issue #762)', () => {
  it('a specialty job that fits nowhere starts one lane past the cap; the lane plan keeps it', () => {
    const d = decide(inputs({ lanes: full, waiting: [specialty('s')] }), 'd1');
    expect(d.start).toEqual([expect.objectContaining({ jobId: 's', laneId: null, opens: 'local/lane-5', machineId: 'local' })]);
    expect(d.start[0]!.reason).toContain('specialty: elbows in over the lane cap 4');
    expect(d.lanes[0]).toMatchObject({ open: 1, target: 5, drain: [] });
  });

  it('an ordinary job never goes past the cap, whatever its priority', () => {
    const d = decide(inputs({ lanes: full, waiting: [job('o', { priority: 100 })] }), 'd1');
    expect(d.start).toEqual([]);
    expect(d.wait.map((w) => w.jobId)).toEqual(['o']);
  });

  it('takes a lane inside the cap first, when one is free', () => {
    const d = decide(inputs({ lanes: full.slice(0, 3), waiting: [specialty('s')] }), 'd1');
    expect(d.start[0]!.reason).not.toContain('elbows in');
    expect(d.lanes[0]).toMatchObject({ target: 4 });
  });

  it('one elbow-in at a time per machine by default: a second specialty job waits', () => {
    const d = decide(inputs({ lanes: full, waiting: [specialty('s1'), specialty('s2')] }), 'd1');
    expect(d.start.map((s) => s.jobId)).toEqual(['s1']);
    expect(d.wait.map((w) => w.jobId)).toEqual(['s2']);
  });

  it('the machine\'s elbow-ins bound how many lanes go past the cap at once', () => {
    const d = decide(inputs({ machines: [machine({ elbowIns: 2 })], lanes: full, waiting: [specialty('s1'), specialty('s2'), specialty('s3')] }), 'd1');
    expect(d.start.map((s) => s.jobId)).toEqual(['s1', 's2']);
    expect(d.lanes[0]).toMatchObject({ open: 2, target: 6 });
  });

  it('elbow-ins 0: no specialty job goes past the cap there', () => {
    const d = decide(inputs({ machines: [machine({ elbowIns: 0 })], lanes: full, waiting: [specialty('s')] }), 'd1');
    expect(d.start).toEqual([]);
  });

  it('a machine already its elbow-ins over the cap takes no more', () => {
    const lanes = [...full, busy(5, 's0')];
    const d = decide(inputs({ lanes, running: [{ ...running('s0'), spec: { executor: 'test', payload: {}, specialty: true } }], waiting: [specialty('s')] }), 'd1');
    expect(d.start).toEqual([]);
  });

  it('never at a usage hard limit', () => {
    const d = decide(inputs({ usage: [reading(96)], waiting: [specialty('s')] }), 'd1');
    expect(d.start).toEqual([]);
  });

  it('never under resource pressure: memory or CPU', () => {
    const mem = { cores: 8, cpuBusyFrac: 0.2, memTotalBytes: 100, memAvailableBytes: 5 };
    const cpu = { cores: 8, cpuBusyFrac: 0.97, memTotalBytes: 100, memAvailableBytes: 50 };
    for (const resources of [mem, cpu]) {
      const d = decide(inputs({ machines: [machine({ resources })], lanes: full, waiting: [specialty('s')] }), 'd1');
      expect(d.start).toEqual([]);
    }
  });

  it('never off its pin, nor on a machine that takes no new job', () => {
    const machines = [machine(), machine({ id: 'm2', label: 'm2' })];
    const lanes = [...full, ...[1, 2, 3, 4].map((n) => busy(n, `m2-${n}`, { machineId: 'm2' }))];
    const pinned = decide(inputs({ machines, lanes, waiting: [specialty('s', { spec: { executor: 'test', payload: {}, machineId: 'm2' } })] }), 'd1');
    expect(pinned.start).toEqual([expect.objectContaining({ jobId: 's', machineId: 'm2' })]);
    const low = decide(inputs({ machines: [machine({ disk: { freeBytes: 1, totalBytes: 100, low: true } })], lanes: full, waiting: [specialty('s')] }), 'd1');
    expect(low.start).toEqual([]);
  });

  it('over the cap, the specialty job\'s lane drains first: the overflow clears when it ends', () => {
    const lanes = [busy(1, 's0'), busy(2, 'x'), busy(3, 'y'), busy(4, 'z'), busy(5, 'w')];
    const s0 = { ...running('s0', { priority: 90 }), spec: { executor: 'test', payload: {}, specialty: true as const } };
    const d = decide(inputs({ lanes, running: [s0, running('x'), running('y'), running('z'), running('w')] }), 'd1');
    expect(d.lanes[0]).toMatchObject({ target: 4, drain: ['local/lane-1'] });
  });
});
