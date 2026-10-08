// Issue #372: a machine can keep some of its lanes for the jobs pinned to it. Jobs with no machine
// pin use at most `cap - reservedLanes` of its lanes; the last ones stay free for its pinned jobs,
// so those do not wait behind work that could run on any machine.
import { describe, expect, it } from 'vitest';
import { decide } from '../../src/decider/index.ts';
import { busy, inputs, job, machine } from './support.ts';

const win = machine({ id: 'win', label: 'win', reservedLanes: 1 });
const other = machine({ id: 'other', label: 'other' });

describe('reserved lanes', () => {
  it('unpinned jobs take at most cap - reservedLanes lanes; the next one waits with the reason', () => {
    const waiting = ['a', 'b', 'c', 'd'].map((id) => job(id));
    const d = decide(inputs({ machines: [win], waiting }), 'd1');
    expect(d.start.map((s) => s.jobId)).toEqual(['a', 'b', 'c']);
    expect(d.wait).toEqual([{
      jobId: 'd',
      reason: 'waiting for a lane: machine win keeps 1 of its 4 lanes for jobs pinned to it, the other 3 are in use',
    }]);
    expect(d.lanes[0]).toMatchObject({ target: 3, open: 3 });
  });

  it('a pinned job takes a reserved lane while unpinned jobs fill the rest', () => {
    const lanes = [busy(1, 'u1', { machineId: 'win' }), busy(2, 'u2', { machineId: 'win' }), busy(3, 'u3', { machineId: 'win' })];
    const running = ['u1', 'u2', 'u3'].map((id) => job(id, { status: 'running' }));
    const d = decide(inputs({ machines: [win], lanes, running, waiting: [job('u4', { priority: 90 }), job('p', { machineId: 'win' })] }), 'd1');
    expect(d.start).toEqual([expect.objectContaining({ jobId: 'p', machineId: 'win' })]);
    expect(d.wait.map((w) => w.jobId)).toEqual(['u4']);
  });

  it('pinned jobs may use every lane, the reserved ones included', () => {
    const waiting = ['p1', 'p2', 'p3', 'p4'].map((id) => job(id, { machineId: 'win' }));
    const d = decide(inputs({ machines: [win], waiting }), 'd1');
    expect(d.start.map((s) => s.jobId)).toEqual(['p1', 'p2', 'p3', 'p4']);
  });

  it('lanes held by pinned jobs do not count against what unpinned jobs may use', () => {
    const lanes = [busy(1, 'p1', { machineId: 'win' }), busy(2, 'p2', { machineId: 'win' })];
    const running = [job('p1', { machineId: 'win', status: 'running' }), job('p2', { machineId: 'win', status: 'running' })];
    const d = decide(inputs({ machines: [win], lanes, running, waiting: [job('u1'), job('u2')] }), 'd1');
    expect(d.start.map((s) => s.jobId)).toEqual(['u1', 'u2']);
  });

  it('unpinned jobs go to another machine first when the reserve leaves less room', () => {
    // win: 4 lanes, 1 reserved → room 3 for unpinned; other: 4. Ties broken by room, then id.
    const d = decide(inputs({ machines: [win, other], waiting: ['a', 'b'].map((id) => job(id)) }), 'd1');
    expect(d.start.map((s) => s.machineId)).toEqual(['other', 'other']);
  });

  it('reservedLanes at or above the cap: only pinned jobs run there', () => {
    const only = machine({ id: 'win', reservedLanes: 4 });
    const d = decide(inputs({ machines: [only, other], waiting: [job('u'), job('p', { machineId: 'win' })] }), 'd1');
    expect(d.start).toEqual(expect.arrayContaining([
      expect.objectContaining({ jobId: 'u', machineId: 'other' }),
      expect.objectContaining({ jobId: 'p', machineId: 'win' }),
    ]));
  });

  it('without reservedLanes, nothing changes: unpinned jobs use every lane', () => {
    const d = decide(inputs({ waiting: ['a', 'b', 'c', 'd'].map((id) => job(id)) }), 'd1');
    expect(d.start).toHaveLength(4);
  });
});
