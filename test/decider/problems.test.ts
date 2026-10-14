// Open problems in the Decision (issue #509): a problem scoped to a machine keeps new jobs off it — redirected to
// another machine that runs their executor, held when none does or they are pinned to it; a problem scoped to
// no machine holds every job of its executor (or every job). The hold names the problem. A resuming job returns
// to its pane.
import { describe, expect, it } from 'vitest';
import { decide } from '../../src/decider/index.ts';
import { inputs, job, machine } from './support.ts';

const disk = { id: 'p1', title: 'Disk full on a', machineId: 'a' };

describe('open problems', () => {
  it('redirect: a new job goes to another machine', () => {
    const d = decide(inputs({ machines: [machine({ id: 'a' }), machine({ id: 'b', maxLanes: 1 })], waiting: [job('j')], problems: [disk] }), 'd1');
    expect(d.start.map((s) => s.machineId)).toEqual(['b']);
  });

  it('held when no other machine runs it, naming the problem', () => {
    const d = decide(inputs({ machines: [machine({ id: 'a' }), machine({ id: 'b', executors: ['codex'] })], waiting: [job('j')], problems: [disk] }), 'd1');
    expect(d.start).toEqual([]);
    expect(d.wait).toEqual([]);
    expect(d.hold).toEqual([{ jobId: 'j', reason: 'held by problem: Disk full on a' }]);
  });

  it('a job pinned to the machine is held', () => {
    const d = decide(inputs({ machines: [machine({ id: 'a' }), machine({ id: 'b' })], waiting: [job('j', { machineId: 'a' })], problems: [disk] }), 'd1');
    expect(d.hold).toEqual([{ jobId: 'j', reason: 'held by problem: Disk full on a' }]);
  });

  it('a problem of one executor leaves the machine to the others', () => {
    const login = { id: 'p2', title: 'Login expired on a', machineId: 'a', executor: 'codex' };
    const d = decide(inputs({
      machines: [machine({ id: 'a', executors: ['test', 'codex'] })], waiting: [job('t'), job('c', { executor: 'codex' })], problems: [login],
    }), 'd1');
    expect(d.start.map((s) => s.jobId)).toEqual(['t']);
    expect(d.hold).toEqual([{ jobId: 'c', reason: 'held by problem: Login expired on a' }]);
  });

  it('a problem on no machine holds every job of its scope', () => {
    const general = { id: 'p3', title: 'Recurring: the build tool crashed' };
    const d = decide(inputs({ machines: [machine({ id: 'a' })], waiting: [job('j')], problems: [general] }), 'd1');
    expect(d.hold).toEqual([{ jobId: 'j', reason: 'held by problem: Recurring: the build tool crashed' }]);
  });

  it('a job resuming on that machine returns to its pane', () => {
    const d = decide(inputs({ machines: [machine({ id: 'a' })], waiting: [job('r', { pendingAnswer: 'yes', resumeOn: 'a' })], problems: [disk] }), 'd1');
    expect(d.start.map((s) => s.machineId)).toEqual(['a']);
  });

  it('no problems: as before', () => {
    expect(decide(inputs({ waiting: [job('j')], problems: [] }), 'd1').start).toHaveLength(1);
  });
});
