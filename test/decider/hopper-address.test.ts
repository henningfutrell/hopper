// Issue #698: a machine whose jobs cannot reach the hopper takes no new job. Its jobs would have no GitHub proxy and
// no git, and a job once fell back to a device sign-in. The job is held with the reason, never failed there.
import { describe, expect, it } from 'vitest';
import { decide } from '../../src/decider/index.ts';
import { inputs, job, machine } from './support.ts';

const UNREACHED = 'the hopper cannot be reached from it: http://hopper:4790 (no connection)';

describe('machines whose jobs cannot reach the hopper', () => {
  it('a job goes to a machine that reaches the hopper', () => {
    const machines = [machine({ id: 'box', maxLanes: 4, addressProblem: UNREACHED }), machine({ id: 'host', maxLanes: 1 })];
    const d = decide(inputs({ machines, waiting: [job('a')] }), 'd1');
    expect(d.start).toEqual([expect.objectContaining({ jobId: 'a', machineId: 'host' })]);
  });

  it('only such machines: the job is held with the reason, never failed', () => {
    const d = decide(inputs({ machines: [machine({ id: 'box', addressProblem: UNREACHED })], waiting: [job('a')] }), 'd1');
    expect(d.start).toEqual([]);
    expect(d.hold).toEqual([{ jobId: 'a', reason: `no machine running executor test reaches the hopper: box is off-network: ${UNREACHED}` }]);
  });

  it('a job pinned to such a machine is held with the reason', () => {
    const machines = [machine({ id: 'box', addressProblem: UNREACHED }), machine({ id: 'host' })];
    const d = decide(inputs({ machines, waiting: [job('a', { machineId: 'box' })] }), 'd1');
    expect(d.start).toEqual([]);
    expect(d.hold).toEqual([{ jobId: 'a', reason: `pinned machine box is off-network: ${UNREACHED}` }]);
  });

  // Issue #711: the reason carries the command that joins the machine to the hopper's network.
  it('the reason names the fix when the machine has one', () => {
    const fix = 'podman network connect hopper_default box';
    const pinned = decide(inputs({ machines: [machine({ id: 'box', addressProblem: UNREACHED, addressFix: fix })], waiting: [job('a', { machineId: 'box' })] }), 'd1');
    expect(pinned.hold).toEqual([{ jobId: 'a', reason: `pinned machine box is off-network: ${UNREACHED}. Fix: ${fix}` }]);
    const any = decide(inputs({ machines: [machine({ id: 'box', addressProblem: UNREACHED, addressFix: fix })], waiting: [job('a')] }), 'd1');
    expect(any.hold).toEqual([{ jobId: 'a', reason: `no machine running executor test reaches the hopper: box is off-network: ${UNREACHED}. Fix: ${fix}` }]);
  });
  // Issue #2355: a job that resumes elsewhere from its checkpoint holds no pane there, and needs the hopper to restore it.
  it('a job that resumes elsewhere goes to a machine that reaches the hopper', () => {
    const machines = [machine({ id: 'box', maxLanes: 4, addressProblem: UNREACHED }), machine({ id: 'host', maxLanes: 1 })];
    const elsewhere = job('a', { pendingAnswer: 'go on', parked: { at: '2026-10-21T00:00:00.000Z', from: 'running', elsewhere: { at: '2026-10-21T00:00:00.000Z', checkpointAt: '2026-10-21T00:00:00.000Z', from: 'seat' } } });
    expect(decide(inputs({ machines, waiting: [elsewhere] }), 'd1').start).toEqual([expect.objectContaining({ jobId: 'a', machineId: 'host' })]);
    const only = decide(inputs({ machines: [machine({ id: 'box', addressProblem: UNREACHED })], waiting: [elsewhere] }), 'd1');
    expect(only.start).toEqual([]);
  });
});
