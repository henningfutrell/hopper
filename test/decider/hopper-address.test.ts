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
    expect(d.hold).toEqual([{ jobId: 'a', reason: `no machine running executor test reaches the hopper: box: ${UNREACHED}` }]);
  });

  it('a job pinned to such a machine is held with the reason', () => {
    const machines = [machine({ id: 'box', addressProblem: UNREACHED }), machine({ id: 'host' })];
    const d = decide(inputs({ machines, waiting: [job('a', { machineId: 'box' })] }), 'd1');
    expect(d.start).toEqual([]);
    expect(d.hold).toEqual([{ jobId: 'a', reason: `pinned machine box: ${UNREACHED}` }]);
  });
});
