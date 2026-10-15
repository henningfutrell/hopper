// Issue #1284: a machine that is leaving — a lane pod told to stop — takes no new job. The job is held, not failed,
// with why; it starts on a machine that stays. The jobs already on the leaving machine keep their lanes.
import { describe, expect, it } from 'vitest';
import { decide } from '../../src/decider/index.ts';
import { busy, inputs, job, machine } from './support.ts';

const pod = (o: Parameters<typeof machine>[0] = {}) => machine({ id: 'pod', leaving: true, ...o });

describe('a machine that is leaving', () => {
  it('a job goes to a machine that stays, even with less room', () => {
    const d = decide(inputs({ machines: [pod({ maxLanes: 4 }), machine({ id: 'host', maxLanes: 1 })], waiting: [job('a')] }), 'd1');
    expect(d.start).toEqual([expect.objectContaining({ jobId: 'a', machineId: 'host' })]);
  });

  it('only leaving machines: the job is held with the reason, never failed; the machine says why it is idle', () => {
    const d = decide(inputs({ machines: [pod()], waiting: [job('a')] }), 'd1');
    expect(d.start).toEqual([]);
    expect(d.hold).toEqual([{ jobId: 'a', reason: 'pod is leaving: no new job is claimed there' }]);
    expect(d.lanes.find((l) => l.machineId === 'pod')?.idle).toBe('leaving: no new job is claimed there');
  });

  it('a job pinned to a leaving machine is held with the reason', () => {
    const d = decide(inputs({ machines: [pod(), machine({ id: 'host' })], waiting: [job('a', { machineId: 'pod' })] }), 'd1');
    expect(d.start).toEqual([]);
    expect(d.hold).toEqual([{ jobId: 'a', reason: 'pinned machine pod is leaving: no new job is claimed there' }]);
  });

  it('jobs already running there keep their lanes', () => {
    const d = decide(inputs({ machines: [pod({ maxLanes: 2 })], lanes: [busy(1, 'r', { machineId: 'pod' })], running: [job('r', { status: 'running' })] }), 'd1');
    expect(d.lanes.find((l) => l.machineId === 'pod')).toMatchObject({ drain: [] });
  });
});
