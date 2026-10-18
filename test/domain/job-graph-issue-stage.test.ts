// Issue #1895: an issue node with no job here reads its stage from the issue itself first — closed as completed is done,
// closed as not planned is closed —, then from its work item, and only an open issue with neither is "Not started".
import { describe, expect, it } from 'vitest';
import type { GraphNode } from '../../src/domain/issue-graph.ts';
import { issueNodeId, jobGraph, type JobGraph } from '../../src/domain/job-graph.ts';
import type { Job } from '../../src/domain/types.ts';
import type { WorkItem, WorkItemState } from '../../src/domain/work-items.ts';

const url = (n: number) => `https://github.com/acme/app/issues/${n}`;
const root: Job = {
  id: 'root', spec: { executor: 'test', payload: {}, goal: 'root work' }, priority: 50, status: 'running', approved: true, attempts: 1,
  createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
  source: { source: 'github', kind: 'issue', key: url(1), url: url(1), repo: 'acme/app', number: 1, title: 'root' },
} as Job;
/** Issue 1, whose job runs, and its children 2 to 6, which no job here works. */
const links = [2, 3, 4, 5, 6].map((number) => ({ parent: { repo: 'acme/app', number: 1 }, child: { repo: 'acme/app', number }, required: true }));
const issue = (number: number, state: string, stateReason?: string): GraphNode =>
  ({ id: url(number), kind: 'issue', attrs: { repo: 'acme/app', number, title: `issue ${number}`, state, ...(stateReason ? { stateReason } : {}) } });
const item = (number: number, state: WorkItemState, over: Partial<WorkItem> = {}): WorkItem => ({
  key: url(number), state, stateSince: '2026-10-02T00:00:00.000Z', eventState: state, eventAt: '2026-10-02T00:00:00.000Z',
  jobId: `old-${number}`, keptWork: [], version: 1, ...over,
});
const node = (g: JobGraph, n: number) => g.nodes.find((x) => x.id === issueNodeId('acme/app', n))!;

describe('the stage of an issue no job here works (issue #1895)', () => {
  const g = jobGraph({
    jobs: [root], links,
    issueGraph: {
      nodes: [issue(2, 'closed', 'completed'), issue(3, 'closed', 'not_planned'), issue(4, 'open'), issue(5, 'open'), issue(6, 'closed', 'duplicate')],
      edges: [],
    },
    // Issue 5: the graph's read of it is older than its close; the ledger has its item done, its job not in the graph.
    items: new Map([[url(5), item(5, 'done', { pullRequestState: 'merged', issueState: 'open' })]]),
  });

  it('closed as completed is done', () => {
    expect(node(g, 2)).toMatchObject({ stage: 'done', stageText: 'Done' });
  });

  it('closed as not planned, or as a duplicate, is closed', () => {
    expect(node(g, 3)).toMatchObject({ stage: 'cancelled', stageText: 'Closed', closed: true });
    expect(node(g, 6)).toMatchObject({ stage: 'cancelled', stageText: 'Closed', closed: true });
  });

  it('an open issue with no job and no work item is not started', () => {
    expect(node(g, 4)).toMatchObject({ stage: 'no_job', stageText: 'Not started' });
  });

  it('an issue whose work item is done is done, though no job of it is here', () => {
    expect(node(g, 5)).toMatchObject({ stage: 'done', stageText: 'Done' });
  });

  it('the group summary counts them so', () => {
    expect(g.trees.find((t) => t.root === issueNodeId('acme/app', 1))!.summary).toBe('2 of 6 pieces shipped, 1 in progress, 2 closed, nothing waiting on you.');
  });

  it('the issue\'s own close comes before its work item', () => {
    const closed = jobGraph({
      jobs: [root], links,
      issueGraph: { nodes: [issue(2, 'closed', 'completed')], edges: [] },
      items: new Map([[url(2), item(2, 'failed', { issueState: 'closed', issueReason: 'completed' })]]),
    });
    expect(node(closed, 2).stage).toBe('done');
  });

  it('the ledger\'s word on the issue comes before an older read of the graph', () => {
    const reopened = jobGraph({
      jobs: [root], links,
      issueGraph: { nodes: [issue(2, 'closed', 'completed')], edges: [] },
      items: new Map([[url(2), item(2, 'queued', { issueState: 'open' })]]),
    });
    expect(node(reopened, 2).stage).toBe('queued');
  });
});
