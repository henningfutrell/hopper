// Issue #365: an ssh or client target whose home is not known yet cannot resolve `~` in a work tree.
// No job is placed there until a probe finds its home; a burst of jobs would otherwise fail on it at once.
import { describe, expect, it } from 'vitest';
import { decide } from '../../src/decider/index.ts';
import { inputs, job, lane, machine } from './support.ts';

const homeless = machine({ id: 'win', label: 'win', client: { current: true } });
const housed = machine({ id: 'win', label: 'win', client: { current: true }, home: 'C:/Users/far' });
const ssh = machine({ id: 'box', label: 'box', ssh: 'box' });

describe('a machine whose home is not known yet', () => {
  it('a client target: jobs not placed there, held with the reason', () => {
    const d = decide(inputs({ machines: [homeless], waiting: [job('a'), job('b')] }), 'd1');
    expect(d.start).toEqual([]);
    expect(d.hold).toEqual([
      { jobId: 'a', reason: 'no machine that runs executor test has its home known yet: win has not answered a probe' },
      { jobId: 'b', reason: 'no machine that runs executor test has its home known yet: win has not answered a probe' },
    ]);
  });

  it('an ssh target likewise; jobs go to another machine whose home is known', () => {
    const d = decide(inputs({ machines: [ssh, machine()], lanes: [lane(1)], waiting: [job('a')] }), 'd1');
    expect(d.start.map((s) => s.machineId)).toEqual(['local']);
  });

  it('a job pinned there is held until its home is known', () => {
    const d = decide(inputs({ machines: [homeless, machine()], waiting: [job('a', { machineId: 'win' })] }), 'd1');
    expect(d.hold).toEqual([{ jobId: 'a', reason: 'pinned machine win: its home is not known yet (it has not answered a probe)' }]);
  });

  it('once its home is known, jobs go there', () => {
    const d = decide(inputs({ machines: [housed], waiting: [job('a')] }), 'd1');
    expect(d.start.map((s) => s.machineId)).toEqual(['win']);
  });

  it('this machine and a container target need no probed home', () => {
    const box = machine({ id: 'box', label: 'box', docker: 'box' });
    const d = decide(inputs({ machines: [box], waiting: [job('a')] }), 'd1');
    expect(d.start.map((s) => s.machineId)).toEqual(['box']);
  });
});

// Issue #365: a client target resting at 0 lanes stays a machine; it takes no jobs.
describe('a machine with 0 lanes', () => {
  it('jobs wait for a lane; nothing starts there', () => {
    const d = decide(inputs({ machines: [machine({ maxLanes: 0 })], waiting: [job('a')] }), 'd1');
    expect(d.start).toEqual([]);
    expect(d.wait).toEqual([{ jobId: 'a', reason: 'waiting for a lane: machine local\'s lane cap is 0, all 0 in use' }]);
  });
});
