// Issue #1248: a machine whose job user holds credentials (a kube config, cloud CLI credentials, an ssh key, a token
// variable) is not ready and takes no new job: a job there could use them. The job is held with the reason, never failed
// there; once the machine's probe finds none, it takes jobs again.
import { describe, expect, it } from 'vitest';
import { decide } from '../../src/decider/index.ts';
import { inputs, job, machine } from './support.ts';

const NOT_READY = 'is not ready: its job user holds credentials a job could use (.kube, .aws). Run its jobs as a dedicated user that holds none';

describe('machines whose job user holds credentials', () => {
  it('a job goes to a machine whose job user holds none', () => {
    const machines = [machine({ id: 'box', maxLanes: 4, infraCredentials: ['.kube', '.aws'] }), machine({ id: 'host', maxLanes: 1, infraCredentials: [] })];
    const d = decide(inputs({ machines, waiting: [job('a')] }), 'd1');
    expect(d.start).toEqual([expect.objectContaining({ jobId: 'a', machineId: 'host' })]);
  });

  it('only such machines: the job is held with the reason, never failed', () => {
    const d = decide(inputs({ machines: [machine({ id: 'box', infraCredentials: ['.kube', '.aws'] })], waiting: [job('a')] }), 'd1');
    expect(d.start).toEqual([]);
    expect(d.hold).toEqual([{ jobId: 'a', reason: `no machine running executor test is ready: box ${NOT_READY}` }]);
  });

  it('a job pinned to such a machine is held with the reason', () => {
    const machines = [machine({ id: 'box', infraCredentials: ['.kube', '.aws'] }), machine({ id: 'host' })];
    const d = decide(inputs({ machines, waiting: [job('a', { machineId: 'box' })] }), 'd1');
    expect(d.start).toEqual([]);
    expect(d.hold).toEqual([{ jobId: 'a', reason: `pinned machine box ${NOT_READY}` }]);
  });

  it('a job resuming there returns to the pane it holds', () => {
    const machines = [machine({ id: 'box', infraCredentials: ['.kube'] })];
    const d = decide(inputs({ machines, waiting: [job('a', { pendingAnswer: 'yes', resumeOn: 'box' })] }), 'd1');
    expect(d.hold).toEqual([]);
  });

  it('once its probe finds none, the machine takes the job', () => {
    const d = decide(inputs({ machines: [machine({ id: 'box', infraCredentials: [] })], waiting: [job('a')] }), 'd1');
    expect(d.start).toEqual([expect.objectContaining({ jobId: 'a', machineId: 'box' })]);
  });
});
