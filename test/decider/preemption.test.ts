// Issue #1525: preemption. When a job of strictly higher priority waits for a lane and every lane it may use is busy, the
// decider names one running job of lower priority to park: the lowest priority, then the one started last (it loses the
// least work). Never a job of equal priority, never one that has run less than the minimum run time, never one whose
// executor cannot park or that has no agent session to resume, and nothing while preemption is off. A job preempted is
// queued again at its own priority, with no resume boost, ahead of the other jobs of that priority.
import { describe, expect, it } from 'vitest';
import { decide } from '../../src/decider/index.ts';
import type { Job, PreemptionInput } from '../../src/domain/types.ts';
import { NOW, busy, inputs, job, machine } from './support.ts';

const MINUTE = 60_000;
const on: PreemptionInput = { minRunMs: 10 * MINUTE, parkingExecutors: ['test'] };
const ago = (minutes: number): string => new Date(new Date(NOW).getTime() - minutes * MINUTE).toISOString();
const run = (id: string, priority: number, startedMinutesAgo: number, over: Partial<Job> = {}): Job =>
  job(id, { status: 'running', priority, startedAt: ago(startedMinutesAgo), agentSession: `session-${id}`, laneId: `local/lane-${id}`, ...over });
/** One machine of two lanes, both busy with r1 and r2. */
const full = (r1: Job, r2: Job) => ({
  machines: [machine({ maxLanes: 2 })],
  lanes: [busy(1, r1.id), busy(2, r2.id)],
  running: [{ ...r1, laneId: 'local/lane-1' }, { ...r2, laneId: 'local/lane-2' }],
});

describe('preemption', () => {
  it('with all lanes busy on low-priority jobs, a high-priority job preempts one of them', () => {
    const d = decide(inputs({ ...full(run('r1', 50, 30), run('r2', 50, 20)), waiting: [job('high', { priority: 75 })], preemption: on }), 'd1');
    expect(d.start).toEqual([]);
    expect(d.preempt).toEqual([expect.objectContaining({ jobId: 'r2', laneId: 'local/lane-2', machineId: 'local', by: 'high', priority: 50, byPriority: 75 })]);
    expect(d.preempt![0]!.reason).toContain('priority 75');
    expect(d.reasons.join('\n')).toContain('preempts r2');
  });

  it('takes the lowest priority first, then the job started last', () => {
    const low = decide(inputs({ ...full(run('r1', 25, 30), run('r2', 50, 20)), waiting: [job('high', { priority: 75 })], preemption: on }), 'd1');
    expect(low.preempt?.map((p) => p.jobId)).toEqual(['r1']);
    const tie = decide(inputs({ ...full(run('r1', 50, 20), run('r2', 50, 30)), waiting: [job('high', { priority: 75 })], preemption: on }), 'd1');
    expect(tie.preempt?.map((p) => p.jobId)).toEqual(['r1']);
  });

  it('equal priority never preempts', () => {
    const d = decide(inputs({ ...full(run('r1', 75, 30), run('r2', 75, 30)), waiting: [job('next', { priority: 75 })], preemption: on }), 'd1');
    expect(d.preempt).toBeUndefined();
    expect(d.wait.map((w) => w.jobId)).toEqual(['next']);
  });

  it('a resume boost or a router boost does not make a job preempt: only its own priority counts', () => {
    const d = decide(inputs({ ...full(run('r1', 60, 30), run('r2', 60, 30)), waiting: [job('back', { priority: 50, pendingAnswer: 'go on' })], preemption: on }), 'd1');
    expect(d.preempt).toBeUndefined();
  });

  it('honours the minimum run time: a job that started less than it ago is not preempted', () => {
    const young = decide(inputs({ ...full(run('r1', 50, 5), run('r2', 50, 9)), waiting: [job('high', { priority: 75 })], preemption: on }), 'd1');
    expect(young.preempt).toBeUndefined();
    const mixed = decide(inputs({ ...full(run('r1', 50, 30), run('r2', 50, 5)), waiting: [job('high', { priority: 75 })], preemption: on }), 'd1');
    expect(mixed.preempt?.map((p) => p.jobId)).toEqual(['r1']);
  });

  it('is off without the preemption input', () => {
    const d = decide(inputs({ ...full(run('r1', 50, 30), run('r2', 50, 30)), waiting: [job('high', { priority: 75 })] }), 'd1');
    expect(d.preempt).toBeUndefined();
  });

  it('never preempts a job whose executor cannot park, or one with no agent session to resume', () => {
    const noPark = decide(inputs({ ...full(run('r1', 50, 30), run('r2', 50, 30)), waiting: [job('high', { priority: 75 })], preemption: { ...on, parkingExecutors: [] } }), 'd1');
    expect(noPark.preempt).toBeUndefined();
    const fresh = decide(inputs({ ...full(run('r1', 50, 30, { agentSession: undefined }), run('r2', 50, 30, { agentSession: undefined })), waiting: [job('high', { priority: 75 })], preemption: on }), 'd1');
    expect(fresh.preempt).toBeUndefined();
  });

  it('a preemption in flight is not made again, and its job is not taken twice', () => {
    const r2 = run('r2', 50, 20, { preempted: { at: ago(0.1), by: 'high', byPriority: 75, priority: 50, machineId: 'local' } });
    const d = decide(inputs({ ...full(run('r1', 50, 30), r2), waiting: [job('high', { priority: 75 })], preemption: on }), 'd1');
    expect(d.preempt).toBeUndefined();
    const two = decide(inputs({ ...full(run('r1', 50, 30), r2), waiting: [job('high', { priority: 75 }), job('other', { priority: 80 })], preemption: on }), 'd1');
    expect(two.preempt?.map((p) => [p.jobId, p.by])).toEqual([['r1', 'other']]);
  });

  it('one waiting job preempts one running job; two preempt two', () => {
    const waiting = [job('h1', { priority: 75 }), job('h2', { priority: 76 })];
    const d = decide(inputs({ ...full(run('r1', 50, 30), run('r2', 40, 30)), waiting, preemption: on }), 'd1');
    expect(d.preempt?.map((p) => [p.jobId, p.by])).toEqual([['r2', 'h2'], ['r1', 'h1']]);
  });

  it('never preempts on a machine the waiting job may not use', () => {
    const d = decide(inputs({ ...full(run('r1', 50, 30), run('r2', 50, 30)), waiting: [job('high', { priority: 75, executor: 'other' })], preemption: { ...on, parkingExecutors: ['test', 'other'] } }), 'd1');
    expect(d.preempt).toBeUndefined();
  });

  it('a job preempted waits at its own priority, with no resume boost, ahead of the other jobs of that priority', () => {
    const back = job('back', { priority: 50, pendingAnswer: 'go on', createdAt: '2026-10-02T11:30:00.000Z', preempted: { at: ago(1), by: 'high', byPriority: 75, priority: 50, machineId: 'local' } });
    const older = job('older', { priority: 50 });
    const higher = job('higher', { priority: 60 });
    const d = decide(inputs({ machines: [machine({ maxLanes: 1 })], waiting: [older, back, higher] }), 'd1');
    expect(d.start.map((s) => [s.jobId, s.effectivePriority])).toEqual([['higher', 60]]);
    const after = decide(inputs({ machines: [machine({ maxLanes: 1 })], waiting: [older, back] }), 'd1');
    expect(after.start.map((s) => [s.jobId, s.effectivePriority])).toEqual([['back', 50]]);
  });
});
