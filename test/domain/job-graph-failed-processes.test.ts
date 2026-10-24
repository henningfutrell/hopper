// Issue #2722 part 7: a job that ended well, with a process of it that failed (`Job.failedProcesses`), says it on the
// job graph after where it stands. Pure.
import { describe, expect, it } from 'vitest';
import { issueNodeId, jobGraph, jobNodeId, type JobGraph } from '../../src/domain/job-graph.ts';
import type { Job, JobStatus } from '../../src/domain/types.ts';

const job = (id: string, status: JobStatus, over: Partial<Job> = {}, issue = 1): Job => ({
  id, spec: { executor: 'test', payload: {}, goal: `goal ${id}` }, priority: 50, status, approved: true, attempts: 1,
  createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z',
  source: { source: 'github', kind: 'issue', key: `https://github.com/acme/app/issues/${issue}`, url: `https://github.com/acme/app/issues/${issue}`, repo: 'acme/app', number: issue, title: `issue ${issue}` },
  ...over,
} as Job);
const node = (g: JobGraph, id: string) => g.nodes.find((n) => n.id === id)!;

describe('a job that ended well, with a process of it that failed (issue #2722 part 7)', () => {
  it('says it after where it stands, on its node and its issue\'s', () => {
    const note = { said: 'a process of the job failed: tsc ran out of heap', processes: 1 };
    const g = jobGraph({ jobs: [job('j', 'finished', { failedProcesses: note }, 3), job('k', 'failed', { failedProcesses: note }, 4)] });
    expect(node(g, jobNodeId('j'))).toMatchObject({ stage: 'done', failedProcesses: note, stageText: `Done, but ${note.said}` });
    expect(node(g, issueNodeId('acme/app', 3)).stageText).toBe(`Done, but ${note.said}`);
    expect(node(g, jobNodeId('k')).failedProcesses).toBeUndefined();
  });

  it('a job with no such note says only where it stands', () => {
    const g = jobGraph({ jobs: [job('j', 'finished', {}, 3)] });
    expect(node(g, jobNodeId('j')).failedProcesses).toBeUndefined();
    expect(node(g, jobNodeId('j')).stageText).toBe('Done');
  });
});
