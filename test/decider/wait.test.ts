// Issue #381: a job that only lacks a free lane is not held — nobody held it. It stays queued and
// the Decision says why it waits, naming the limit that binds (the machine's lane cap or its
// executor's) with its real number. Holds stay for the router, the queue gate and native holds.
import { describe, expect, it } from 'vitest';
import { decide } from '../../src/decider/index.ts';
import { busy, inputs, job, machine, reading } from './support.ts';

const mixed = machine({ executors: ['claude', 'codex'] });
const claudeAt = (used: number) => reading(used, 100, { source: 'claude', executors: ['claude'] });

describe('waiting for a lane', () => {
  it('a job past the machine\'s lane cap waits, not held, and the reason names the machine cap', () => {
    const waiting = ['a', 'b', 'c', 'd', 'e'].map((id) => job(id));
    const d = decide(inputs({ waiting }), 'd1');
    expect(d.hold).toEqual([]);
    expect(d.wait).toEqual([{ jobId: 'e', reason: 'waiting for a lane: machine local\'s lane cap is 4, all 4 in use' }]);
  });

  it('when the executor\'s cap binds, the reason names the executor cap with its number, not the machine\'s', () => {
    // claude used 0.825: its lane cap is 2; the machine's stays 4 (codex is free).
    const lanes = [busy(1, 'c1'), busy(2, 'c2')];
    const running = [job('c1', { executor: 'claude', status: 'running' }), job('c2', { executor: 'claude', status: 'running' })];
    const d = decide(inputs({ machines: [mixed], usage: [claudeAt(82.5)], lanes, running, waiting: [job('c3', { executor: 'claude' })] }), 'd1');
    expect(d.hold).toEqual([]);
    expect(d.wait).toEqual([{ jobId: 'c3', reason: 'waiting for a lane: executor claude\'s lane cap on local is 2 (usage soft limit, used 83%), all 2 in use' }]);
  });

  it('an executor at its hard limit: the job waits, and the reason names the hard limit', () => {
    const d = decide(inputs({ machines: [mixed], usage: [claudeAt(96)], waiting: [job('c1', { executor: 'claude' })] }), 'd1');
    expect(d.wait).toEqual([{ jobId: 'c1', reason: 'waiting for a lane: usage hard limit stops executor claude on local (used 96%)' }]);
  });

  it('a native hold is still a hold', () => {
    const d = decide(inputs({ waiting: [job('a', { executor: 'nowhere' })] }), 'd1');
    expect(d.wait).toEqual([]);
    expect(d.hold).toEqual([{ jobId: 'a', reason: 'no online machine runs executor nowhere' }]);
  });
});
