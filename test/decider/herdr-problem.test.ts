// Issue #741: an ssh target whose herdr client its herdr server does not take fails every job start there. It takes no
// new job: the job is held with the reason, or goes to another machine, never failed there.
import { describe, expect, it } from 'vitest';
import { decide } from '../../src/decider/index.ts';
import { inputs, job, machine } from './support.ts';

const OLD = 'its herdr client 0.7.5 (protocol 17, /usr/local/bin/herdr) is not compatible with its herdr server 0.9.3 (protocol 22): install the server\'s herdr there';

describe('machines with a herdr problem', () => {
  it('a job goes to a machine whose herdr works', () => {
    const machines = [machine({ id: 'seat', maxLanes: 4, herdrProblem: OLD }), machine({ id: 'host', maxLanes: 1 })];
    const d = decide(inputs({ machines, waiting: [job('a')] }), 'd1');
    expect(d.start).toEqual([expect.objectContaining({ jobId: 'a', machineId: 'host' })]);
  });

  it('only such machines: the job is held with the reason, never failed', () => {
    const d = decide(inputs({ machines: [machine({ id: 'seat', herdrProblem: OLD })], waiting: [job('a')] }), 'd1');
    expect(d.start).toEqual([]);
    expect(d.hold).toEqual([{ jobId: 'a', reason: `no machine running executor test has a working herdr: seat: ${OLD}` }]);
  });

  it('a job pinned to such a machine is held with the reason', () => {
    const machines = [machine({ id: 'seat', herdrProblem: OLD }), machine({ id: 'host' })];
    const d = decide(inputs({ machines, waiting: [job('a', { machineId: 'seat' })] }), 'd1');
    expect(d.start).toEqual([]);
    expect(d.hold).toEqual([{ jobId: 'a', reason: `pinned machine seat: ${OLD}` }]);
  });
});
