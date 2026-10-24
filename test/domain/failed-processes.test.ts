// No misleading state after a failed process (issue #2722 part 6): a job that ended well, but whose reap read a process
// of it that failed — a heap abort, a core dump, an OOM kill — or a scope that did not stop, does not say only "Done".
// Pure.
import { describe, expect, it } from 'vitest';
import { failedProcessHeader, failedProcessNote, scopeNotStopped } from '../../src/domain/failed-processes.ts';
import { jobBom } from '../../src/domain/job-bom.ts';
import type { DomainEvent, Job, JobStatus } from '../../src/domain/types.ts';

let seq = 0;
const event = (type: string, data: Record<string, unknown> = {}): DomainEvent =>
  ({ seq: ++seq, schemaVersion: 1, id: `e${seq}`, type, at: '2026-10-24T11:00:00.000Z', jobId: 'j1', machineId: 'm1', data } as DomainEvent);

const job = (status: JobStatus): Job => ({
  id: 'j1', spec: { executor: 'test', payload: {}, goal: 'Make the cache faster' }, priority: 50, status, approved: true, attempts: 1,
  createdAt: '2026-10-24T09:00:00.000Z', updatedAt: '2026-10-24T11:00:00.000Z', startedAt: '2026-10-24T09:10:00.000Z',
} as Job);

const bom = (status: JobStatus, events: DomainEvent[]) => jobBom({ job: job(status), events, questions: [], artifacts: [], related: [], now: '2026-10-24T12:00:00.000Z' });

describe('a job that ended well does not say only "Done" when a process of it failed (issue #2722 part 6)', () => {
  it('its header names each failed process, and asks to make sure that its checks ran', () => {
    const b = bom('finished', [event('job.heap_aborted', { command: 'tsc --noEmit -p .' }), event('job.core_dumped', { command: 'cc1plus big.cpp', signal: 'SIGSEGV' })]);
    expect(b.header.stands).toBe('Done, but a process of the job failed: tsc ran out of heap; cc1plus dumped core (SIGSEGV)');
    expect(b.header.next).toBe('Make sure that its checks ran and passed: a failed process can make a check look green.');
  });

  it('an OOM kill too; a job with none, or a failed job, is as before', () => {
    expect(bom('finished', [event('job.oom_killed', { command: 'tsc' })]).header.stands).toBe('Done, but a process of the job failed: tsc was killed: out of memory');
    expect(bom('finished', []).header).toMatchObject({ stands: 'Done', next: 'Nothing: it is done.' });
    const failed = bom('failed', [event('job.heap_aborted', { command: 'tsc' })]);
    expect(failed.header.stands).not.toContain('a process of the job failed');
  });

  it('a scope that did not stop is said, but asks nothing of the checks', () => {
    const b = bom('finished', [event('job.scope_not_stopped', { state: 'failed', processes: 2 })]);
    expect(b.header).toMatchObject({ stands: 'Done, but its scope did not stop (failed, 2 processes in it)', next: 'Nothing: it is done.' });
  });

  it('the header is the job\'s own when no part failed so', () => {
    const header = { asked: 'x', stands: 'Merged', next: 'Nothing: it is done.' };
    expect(failedProcessHeader('finished', [], header)).toBe(header);
  });
});

describe('a scope that did not stop (issue #2722 part 6)', () => {
  it('is a failed part under machines: its state, the processes in it, and that the sweep reaps it again', () => {
    expect(scopeNotStopped([event('job.scope_not_stopped', { state: 'deactivating', processes: 1 })])).toMatchObject([{
      group: 'machines', kind: 'scope_not_stopped', status: 'failed', label: 'Its scope did not stop (deactivating, 1 process in it)',
      detail: 'The reap could not stop the job\'s scope on m1: the sweep reaps it again while it is there.', href: '#machines',
    }]);
    expect(scopeNotStopped([event('job.scope_not_stopped', { state: 'failed' })])[0]?.label).toBe('Its scope did not stop (failed)');
    expect(scopeNotStopped([])).toEqual([]);
  });
});

describe('the note a job that ended well keeps for its cards (issue #2722 part 7)', () => {
  it('says each failed process and a scope that did not stop, as its header says them', () => {
    const events = [event('job.heap_aborted', { command: 'tsc --noEmit' }), event('job.oom_killed', { command: 'node' }), event('job.scope_not_stopped', { state: 'failed' })];
    const note = failedProcessNote('finished', events);
    expect(note).toEqual({ said: 'a process of the job failed: tsc ran out of heap; node was killed: out of memory, and its scope did not stop (failed)', processes: 2 });
    expect(bom('finished', events).header.stands).toBe(`Done, but ${note?.said}`);
    expect(failedProcessNote('finished', [event('job.scope_not_stopped', { state: 'failed' })])).toEqual({ said: 'its scope did not stop (failed)', processes: 0 });
  });

  it('is none for a job with none, and for a job that did not end well', () => {
    expect(failedProcessNote('finished', [event('job.resources_used', { memoryPeakBytes: 1 })])).toBeUndefined();
    expect(failedProcessNote('failed', [event('job.heap_aborted', { command: 'tsc' })])).toBeUndefined();
  });
});
