// A usage reading budgets the jobs of the executors it names (design.md "Usage per executor (issue
// #140)"): a machine runs jobs of many agent frameworks, and one framework's budget must not
// throttle another's jobs. A reading naming no executors budgets every job, as before.
import { describe, expect, it } from 'vitest';
import { decide } from '../../src/decider/index.ts';
import { laneEffect } from '../../src/decider/usage.ts';
import { busy, inputs, job, machine, NOW, policy, reading } from './support.ts';

const plan = (d: ReturnType<typeof decide>, id = 'local') => d.lanes.find((l) => l.machineId === id)!;
const mixed = machine({ executors: ['claude', 'codex'] });
const claudeAt = (used: number) => reading(used, 100, { source: 'claude', executors: ['claude'] });

describe('usage per executor', () => {
  it('one framework at its hard limit: its jobs wait, the other framework\'s jobs start on the same machine', () => {
    const d = decide(inputs({
      machines: [mixed], usage: [claudeAt(96)],
      waiting: [job('c1', { executor: 'claude' }), job('x1', { executor: 'codex' })],
    }), 'd1');
    expect(d.start.map((s) => s.jobId)).toEqual(['x1']);
    expect(d.wait).toEqual([{ jobId: 'c1', reason: expect.stringContaining('usage hard limit') }]);
    expect(plan(d)).toMatchObject({ target: 1, open: 1, drain: [] });
  });

  it('the soft limit caps one executor\'s jobs only', () => {
    // claude used 0.825: floor(4 * (0.95-0.825)/(0.95-0.7)) = 2
    const waiting = [job('c1', { executor: 'claude' }), job('c2', { executor: 'claude' }), job('c3', { executor: 'claude' }), job('x1', { executor: 'codex' }), job('x2', { executor: 'codex' })];
    const d = decide(inputs({ machines: [mixed], usage: [claudeAt(82.5)], waiting }), 'd1');
    expect(d.start.map((s) => s.jobId)).toEqual(['c1', 'c2', 'x1', 'x2']);
    expect(d.wait).toEqual([{ jobId: 'c3', reason: expect.stringContaining('executor claude\'s lane cap on local is 2 (usage soft limit') }]);
  });

  it('a budget of an executor a machine does not run leaves that machine free', () => {
    const d = decide(inputs({
      machines: [machine({ executors: ['codex'] })], usage: [claudeAt(99)], waiting: [job('x1', { executor: 'codex' })],
    }), 'd1');
    expect(d.start.map((s) => s.jobId)).toEqual(['x1']);
    expect(d.reasons).toContain('local: 0% used, lane cap 4 of 4 (free)');
  });

  it('a reading naming no executors still budgets every job', () => {
    const d = decide(inputs({
      machines: [mixed], usage: [reading(96)],
      waiting: [job('c1', { executor: 'claude' }), job('x1', { executor: 'codex' })],
    }), 'd1');
    expect(d.start).toEqual([]);
  });

  it('an executor\'s cap counts its own jobs: two codex jobs running do not use up claude\'s soft cap of 2', () => {
    const lanes = [busy(1, 'x1'), busy(2, 'x2')];
    const running = [job('x1', { executor: 'codex', status: 'running' }), job('x2', { executor: 'codex', status: 'running' })];
    const waiting = [job('c1', { executor: 'claude' }), job('c2', { executor: 'claude' }), job('c3', { executor: 'claude' })];
    const d = decide(inputs({ machines: [mixed], usage: [claudeAt(82.5)], lanes, running, waiting }), 'd1');
    // 4 lanes, 2 busy: room for 2, and claude may run 2.
    expect(d.start.map((s) => s.jobId)).toEqual(['c1', 'c2']);
    expect(d.wait).toEqual([{ jobId: 'c3', reason: expect.stringContaining('executor claude\'s lane cap on local is 2 (usage soft limit') }]);
  });

  it('an executor at its hard limit has its busy lanes drained; another executor\'s lanes on the machine run on', () => {
    const lanes = [busy(1, 'c1'), busy(2, 'x1')];
    const running = [job('c1', { executor: 'claude', status: 'running' }), job('x1', { executor: 'codex', status: 'running' })];
    expect(plan(decide(inputs({ machines: [mixed], usage: [claudeAt(96)], lanes, running }), 'd1')).drain).toEqual(['local/lane-1']);
    const both = [claudeAt(96), reading(97, 100, { source: 'codex', executors: ['codex'] })];
    expect(plan(decide(inputs({ machines: [mixed], usage: both, lanes, running }), 'd2')).drain).toEqual(['local/lane-2', 'local/lane-1']);
  });

  it('a machine\'s own readings win per executor (issue #139): its own Claude account caps its Claude jobs, a budget read for every machine still caps another framework there', () => {
    const usage = [
      claudeAt(99), // this hopper's Claude account
      reading(10, 100, { source: 'claude-local', machineId: 'local', executors: ['claude'] }), // the machine's own
      reading(96, 100, { source: 'codex', executors: ['codex'] }),
    ];
    const effect = laneEffect(mixed, usage, policy, NOW);
    expect(effect.executors.map((e) => [e.executor, e.usedFrac])).toEqual([['claude', 0.1], ['codex', 0.96]]);
  });

  it('the lane effect: the machine\'s cap is its least constrained executor\'s; each executor\'s own effect beside it', () => {
    const effect = laneEffect(mixed, [claudeAt(82.5), reading(10, 100, { executors: ['codex'] })], policy, NOW);
    expect(effect).toEqual({
      usedFrac: 0.1, cap: 4, band: 'free', ignored: [], burning: [],
      executors: [
        { executor: 'claude', usedFrac: 0.825, cap: 2, band: 'soft' },
        { executor: 'codex', usedFrac: 0.1, cap: 4, band: 'free' },
      ],
    });
  });
});
