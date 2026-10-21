// Issue #1511: a machine a person drained takes no new job. The job is held, not failed, with why; it starts on a
// machine that is not drained. The jobs already on the drained machine keep their lanes, and a job resuming there returns.
import { describe, expect, it } from 'vitest';
import { decide } from '../../src/decider/index.ts';
import { busy, inputs, job, machine } from './support.ts';

const seat = (o: Parameters<typeof machine>[0] = {}) => machine({ id: 'seat', drained: { person: 'Pat', via: 'ui', at: '2026-10-16T00:00:00.000Z' }, ...o });

describe('a drained machine', () => {
  it('a job goes to a machine that is not drained, even with less room', () => {
    const d = decide(inputs({ machines: [seat({ maxLanes: 4 }), machine({ id: 'host', maxLanes: 1 })], waiting: [job('a')] }), 'd1');
    expect(d.start).toEqual([expect.objectContaining({ jobId: 'a', machineId: 'host' })]);
  });

  it('only drained machines: the job is held with the reason, never failed; the machine says why it is idle', () => {
    const d = decide(inputs({ machines: [seat()], waiting: [job('a')] }), 'd1');
    expect(d.start).toEqual([]);
    expect(d.hold).toEqual([{ jobId: 'a', reason: 'seat is drained: no new job is claimed there' }]);
    expect(d.lanes.find((l) => l.machineId === 'seat')?.idle).toBe('drained: no new job is claimed there');
  });

  it('a job pinned to a drained machine is held with the reason', () => {
    const d = decide(inputs({ machines: [seat(), machine({ id: 'host' })], waiting: [job('a', { machineId: 'seat' })] }), 'd1');
    expect(d.start).toEqual([]);
    expect(d.hold).toEqual([{ jobId: 'a', reason: 'pinned machine seat is drained: no new job is claimed there' }]);
  });

  it('jobs already running there keep their lanes', () => {
    const d = decide(inputs({ machines: [seat({ maxLanes: 2 })], lanes: [busy(1, 'r', { machineId: 'seat' })], running: [job('r', { status: 'running' })] }), 'd1');
    expect(d.lanes.find((l) => l.machineId === 'seat')).toMatchObject({ drain: [] });
  });
  // Issue #2355: a job that resumes elsewhere from its checkpoint holds no pane there: it opens a new one, so it is held too.
  it('a job that resumes elsewhere goes to a machine that is not drained', () => {
    const elsewhere = job('a', { pendingAnswer: 'go on', parked: { at: '2026-10-21T00:00:00.000Z', from: 'running', elsewhere: { at: '2026-10-21T00:00:00.000Z', checkpointAt: '2026-10-21T00:00:00.000Z', from: 'box' } } });
    const d = decide(inputs({ machines: [seat({ maxLanes: 4 }), machine({ id: 'host', maxLanes: 1 })], waiting: [elsewhere] }), 'd1');
    expect(d.start).toEqual([expect.objectContaining({ jobId: 'a', machineId: 'host' })]);
    expect(decide(inputs({ machines: [seat()], waiting: [elsewhere] }), 'd1').start).toEqual([]);
  });
});
