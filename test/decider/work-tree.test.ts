// Issue #361: the decider never picks a machine whose work tree cannot be made usable. The job is held,
// not failed, with why; it starts on a machine that can take it.
import { describe, expect, it } from 'vitest';
import { decide } from '../../src/decider/index.ts';
import { busy, inputs, job, machine } from './support.ts';

const BROKEN = 'its work tree /home/owner/work cannot be made: Permission denied';

describe('machines whose work tree is not usable', () => {
  it('a job goes to the machine whose work tree is usable, even with less room', () => {
    const machines = [machine({ id: 'box', maxLanes: 4, workTreeProblem: BROKEN }), machine({ id: 'host', maxLanes: 1 })];
    const d = decide(inputs({ machines, waiting: [job('a')] }), 'd1');
    expect(d.start).toEqual([expect.objectContaining({ jobId: 'a', machineId: 'host' })]);
  });

  it('only such machines: the job is held with the reason, never failed', () => {
    const d = decide(inputs({ machines: [machine({ id: 'box', workTreeProblem: BROKEN })], waiting: [job('a')] }), 'd1');
    expect(d.start).toEqual([]);
    expect(d.hold).toEqual([{ jobId: 'a', reason: `no machine running executor test has a usable work tree: box: ${BROKEN}` }]);
  });

  it('a job pinned to such a machine is held with the reason', () => {
    const machines = [machine({ id: 'box', workTreeProblem: BROKEN }), machine({ id: 'host' })];
    const d = decide(inputs({ machines, waiting: [job('a', { machineId: 'box' })] }), 'd1');
    expect(d.start).toEqual([]);
    expect(d.hold).toEqual([{ jobId: 'a', reason: `pinned machine box: ${BROKEN}` }]);
  });

  it('the host\'s lanes are full: the job waits for them, never goes to the box', () => {
    const machines = [machine({ id: 'box', maxLanes: 2, workTreeProblem: BROKEN }), machine({ id: 'host', maxLanes: 1 })];
    const d = decide(inputs({ machines, lanes: [busy(1, 'r', { machineId: 'host' })], running: [job('r', { status: 'running' })], waiting: [job('a')] }), 'd1');
    expect(d.start).toEqual([]);
    expect(d.hold[0]).toMatchObject({ jobId: 'a', reason: expect.stringContaining('all lanes busy') });
  });

  it('jobs already running there keep their lanes', () => {
    const machines = [machine({ id: 'box', maxLanes: 2, workTreeProblem: BROKEN })];
    const d = decide(inputs({ machines, lanes: [busy(1, 'r', { machineId: 'box' })], running: [job('r', { status: 'running' })] }), 'd1');
    expect(d.lanes.find((l) => l.machineId === 'box')).toMatchObject({ drain: [] });
  });
});
