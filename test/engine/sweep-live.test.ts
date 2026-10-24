// The sweep never stops a job whose agent may still run (issue #2707): a job queued or held with an answer pending keeps
// its pane, and a job that started after the pass read the jobs is read again before its reap. What it stops of a job not
// ended is recorded, and a failure of the agent after it names the sweep, not the agent.
import { describe, expect, it } from 'vitest';
import type { DomainEvent, Job } from '../../src/domain/types.ts';
import { planSweep } from '../../src/engine/sweep.ts';
import { sweptError } from '../../src/engine/outcome.ts';
import { matchCause } from '../../src/failures/causes.ts';
import { day, job, none, rig } from './sweep-rig.ts';

describe('a job whose agent may still run (issue #2707)', () => {
  const pending = (id: string, status: Job['status']): Job => ({ ...job(id, status), pendingAnswer: 'the answer' });

  it('queued or held with an answer pending: its pane is kept, so its processes are never stopped; a parked one\'s are', () => {
    const jobs = new Map([
      ['answered', pending('answered', 'queued')], ['held', pending('held', 'held')], ['park', pending('park', 'parked')],
      ['queued', job('queued', 'queued')],
    ]);
    expect(planSweep({ ...none, processes: ['answered', 'held', 'park', 'queued'] }, (id) => jobs.get(id), new Set(), day))
      .toEqual([{ jobId: 'park' }, { jobId: 'queued' }]);
  });

  it('a job that started after the pass read the jobs is read again before its reap: never stopped', async () => {
    const queued = job('started', 'queued');
    const r = rig({ others: [queued], found: { ...none, processes: ['started'] }, onSurvey: (jobs) => { jobs[jobs.findIndex((j) => j.id === 'started')] = { ...queued, status: 'running' }; } });
    await r.sweep.run(true);
    expect(r.reaps).toEqual([]);
    expect(r.events.filter((e) => e.type === 'job.processes_stopped')).toEqual([]);
  });

  it('what it stops of a job not ended is recorded with the job\'s status and said in the log; an ended job\'s is not recorded', async () => {
    const r = rig({ others: [job('queued', 'queued')], found: { ...none, processes: ['done', 'queued'] } });
    await r.sweep.run(true);
    expect(r.reaps).toEqual([{ jobId: 'done' }, { jobId: 'queued' }]);
    expect(r.events.filter((e) => e.type === 'job.processes_stopped')).toEqual([{ type: 'job.processes_stopped', jobId: 'queued', machineId: 'm', data: { machineId: 'm', status: 'queued' } }]);
    expect(r.logs).toContain('hopper: the sweep stopped the processes of job queued on m: it is queued, so nothing of it may run there');
  });
});

describe('a failure after the sweep stopped the job (issue #2707)', () => {
  const exited = 'claude exited (exit code 143, signal 15): (it printed nothing)';
  const store = (types: string[]) => ({
    events: { recent: (_n: number, _t: string[], _id: string) => types.map((type) => ({ type, data: { machineId: 'm1', status: 'queued' } }) as unknown as DomainEvent).reverse() },
  }) as never;

  it('names the sweep, the machine and the status it read: the known cause Stopped by the sweep, never the agent\'s exit', () => {
    const text = sweptError({ store: store(['job.processes_stopped']) }, { id: 'j' }, exited);
    expect(text).toBe(`the hopper's sweep stopped its processes on m1 while it was queued: ${exited}`);
    expect(matchCause(text, '', [])).toMatchObject({ id: 'swept', cls: 'transient', decision: 'retry' });
  });

  it('a failure since the stop, or a failure that is no exit, says only what it says', () => {
    expect(sweptError({ store: store(['job.processes_stopped', 'job.failed']) }, { id: 'j' }, exited)).toBe(exited);
    expect(sweptError({ store: store([]) }, { id: 'j' }, exited)).toBe(exited);
    expect(sweptError({ store: store(['job.processes_stopped']) }, { id: 'j' }, 'not complete: open')).toBe('not complete: open');
  });
});
