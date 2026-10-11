// Issue #434: the Jobs view's model — which cards show for a filter, in what order, the filter's choices, and each
// job's last event from the events the UI holds.
import { describe, expect, it } from 'vitest';
import type { DomainEvent, Job, JobStatus } from '../../src/domain/types.ts';
import { filterChoices, jobCards, lastEvents, NO_FILTER } from '../../ui/src/model/jobs-view.ts';

const job = (id: string, status: JobStatus, repo: string | null, updatedAt: string): Job => ({
  id, spec: { executor: 'test', payload: {}, goal: `goal ${id}` }, priority: 50, status, approved: false,
  createdAt: '2026-10-01T00:00:00Z', updatedAt, attempts: 0,
  ...(repo ? { source: { source: 'github', kind: 'issue', key: `${repo}#1`, repo, number: 1 } } : {}),
} as Job);
const event = (seq: number, jobId: string, type = 'job.started'): DomainEvent =>
  ({ seq, schemaVersion: 1, id: `e${seq}`, type, at: '2026-10-01T00:00:00Z', jobId, data: {} } as DomainEvent);

const jobs = [
  job('a', 'running', 'acme/widgets', '2026-10-01T10:00:00Z'),
  job('b', 'queued', 'acme/site', '2026-10-01T12:00:00Z'),
  job('c', 'finished', 'acme/widgets', '2026-10-01T11:00:00Z'),
  job('d', 'running', null, '2026-10-01T09:00:00Z'),
];

describe('jobCards', () => {
  it('shows every job with no filter, the latest change first', () => {
    expect(jobCards(jobs, NO_FILTER).map((j) => j.id)).toEqual(['b', 'c', 'a', 'd']);
  });

  it('shows only the jobs of the status chosen', () => {
    expect(jobCards(jobs, { ...NO_FILTER, status: 'running' }).map((j) => j.id)).toEqual(['a', 'd']);
  });

  it('shows only the jobs of the repository chosen; a job with no repository is in none', () => {
    expect(jobCards(jobs, { ...NO_FILTER, repo: 'acme/widgets' }).map((j) => j.id)).toEqual(['c', 'a']);
  });

  it('applies both filters together', () => {
    expect(jobCards(jobs, { status: 'running', repo: 'acme/widgets' }).map((j) => j.id)).toEqual(['a']);
  });
});

describe('filterChoices', () => {
  it('offers the statuses and the repositories the jobs have, each once, in a fixed order', () => {
    expect(filterChoices(jobs)).toEqual({ statuses: ['queued', 'running', 'finished'], repos: ['acme/site', 'acme/widgets'] });
  });
});

describe('lastEvents', () => {
  it('keeps the newest event of each job across every list, and skips events with no job', () => {
    const fetched = [event(3, 'a'), event(5, 'b', 'job.queued')];
    const held = [event(9, 'a', 'job.finished'), event(4, 'b'), { ...event(10, 'x'), jobId: undefined } as DomainEvent];
    const last = lastEvents(fetched, held);
    expect(last.get('a')?.seq).toBe(9);
    expect(last.get('b')?.seq).toBe(5);
    expect(last.size).toBe(2);
  });
});
