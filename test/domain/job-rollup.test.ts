// Issue #1036: finished work rolls up on the job graph — a merged pull request is merged for every job that names it.
// Issue #1067: an issue is at its work item's state, and a failed or cancelled job whose item the ledger has moved on is
// superseded; one handed to a person waits on you. Pure.
import { describe, expect, it } from 'vitest';
import { issueNodeId, jobGraph, jobNodeId, pullRequestNodeId, type JobGraph } from '../../src/domain/job-graph.ts';
import { placeGraph } from '../../src/domain/issue-graph.ts';
import type { Job, JobStatus } from '../../src/domain/types.ts';
import type { WorkItem, WorkItemState } from '../../src/domain/work-items.ts';

const PR = (n: number) => `https://github.com/acme/app/pull/${n}`;

let made = 0;
const job = (id: string, status: JobStatus, over: Partial<Job> = {}, issue = 1): Job => ({
  id, spec: { executor: 'test', payload: {}, goal: `goal ${id}` }, priority: 50, status, approved: true, attempts: 1,
  createdAt: new Date(Date.UTC(2026, 9, 1, 0, made++)).toISOString(), updatedAt: '2026-10-02T00:00:00.000Z',
  source: { source: 'github', kind: 'issue', key: `https://github.com/acme/app/issues/${issue}`, url: `https://github.com/acme/app/issues/${issue}`, repo: 'acme/app', number: issue, title: `issue ${issue}` },
  ...over,
} as Job);
/** A work item of issue `issue`, as the ledger has it (issue #1067). */
const item = (issue: number, state: WorkItemState, jobId: string, over: Partial<WorkItem> = {}): WorkItem => ({
  key: `https://github.com/acme/app/issues/${issue}`, state, stateSince: '2026-10-02T00:00:00.000Z', eventState: state,
  eventAt: '2026-10-02T00:00:00.000Z', jobId, keptWork: [], version: 1, ...over,
});
const items = (...list: WorkItem[]): Map<string, WorkItem> => new Map(list.map((i) => [i.key, i]));
const followed = (pullRequest: string, follow: string, seen?: object) => ({ sourceState: { source: { pullRequest, follow, ...(seen ? { seen } : {}) } } });

const node = (g: JobGraph, id: string) => g.nodes.find((n) => n.id === id)!;
const kinds = (g: JobGraph) => g.edges.map((e) => `${e.from} ${e.kind} ${e.to}`).sort();

describe('finished work rolls up (issue #1036)', () => {
  const closedIssue = (number: number, stateReason?: string) => placeGraph({
    issue: { repo: 'acme/app', number, url: `https://github.com/acme/app/issues/${number}`, title: `issue ${number}`, state: 'closed', ...(stateReason ? { stateReason } : {}), updatedAt: '2026-10-01T00:00:00Z' },
    owner: { login: 'acme' }, projects: [], references: [], closedBy: [], subIssues: [],
  });

  it('a pull request a later job saw merge is merged for every job that names it, with no checks or conflicts', () => {
    const old = job('old', 'finished', { partlyDone: PR(5), sourceState: { source: { pullRequest: PR(5), follow: 'reworked', seen: { checks: 'failing', conflicting: true } } } });
    const pr = job('pr', 'finished', { sourceState: { source: { pullRequest: PR(6), follow: 'tended', seen: { checks: 'pending', conflicting: true }, tended: { pullRequest: PR(6), step: 'rebase', nextJobId: 'tend' } } } }, 2);
    const tend = job('tend', 'finished', { rerunOf: 'pr', ...followed(PR(6), 'merged') }, 2);
    const rework = job('rework', 'finished', { rerunOf: 'old', ...followed(PR(5), 'merged') });
    const g = jobGraph({ jobs: [old, pr, tend, rework] });
    for (const id of ['old', 'pr', 'tend', 'rework']) {
      expect(node(g, jobNodeId(id)).stage).toBe('done');
      expect(node(g, jobNodeId(id)).stageText).toBe('Merged');
    }
    expect(node(g, jobNodeId('old')).pullRequest).toEqual({ url: PR(5), state: 'merged' });
    expect(node(g, jobNodeId('pr')).pullRequest).toEqual({ url: PR(6), state: 'merged' });
    expect(node(g, pullRequestNodeId(PR(6)))).toMatchObject({ stage: 'done', pullRequest: { url: PR(6), state: 'merged' } });
    expect(kinds(g)).toContain(`${jobNodeId('old')} opened ${pullRequestNodeId(PR(5))}`);
  });

  it('a pull request the issue graph has as merged is merged, whatever the jobs last saw', () => {
    const issueGraph = placeGraph({
      issue: { repo: 'acme/app', number: 1, url: 'https://github.com/acme/app/issues/1', title: 'Root', state: 'OPEN', updatedAt: '2026-10-01T00:00:00Z' },
      owner: { login: 'acme' }, projects: [], references: [], subIssues: [],
      closedBy: [{ kind: 'pull_request', repo: 'acme/app', number: 8, url: PR(8), state: 'MERGED' }],
    });
    const g = jobGraph({ jobs: [job('a', 'finished', followed(PR(8), 'tended', { checks: 'pending' }))], issueGraph });
    expect(node(g, jobNodeId('a'))).toMatchObject({ stage: 'done', pullRequest: { url: PR(8), state: 'merged' } });
  });

  it('an open pull request shows what its newest follower saw of it', () => {
    const a = job('a', 'finished', { sourceState: { source: { pullRequest: PR(5), follow: 'tended', seen: { checks: 'failing', conflicting: true }, tended: { pullRequest: PR(5), step: 'rebase', nextJobId: 'b' } } } });
    const b = job('b', 'finished', { rerunOf: 'a', ...followed(PR(5), 'open', { checks: 'passing', conflicting: false }) });
    const g = jobGraph({ jobs: [a, b] });
    expect(node(g, pullRequestNodeId(PR(5))).pullRequest).toMatchObject({ state: 'open', checks: 'passing', conflicting: false });
    expect(node(g, jobNodeId('a')).pullRequest).toMatchObject({ state: 'tended', checks: 'passing', conflicting: false });
  });

  // Where each issue stands, and whether a failure is still one, is the work-item ledger's (issue #1067): the graph reads it.
  it('an issue the ledger has done (closed as completed) is done, and the failed or cancelled jobs of it are superseded', () => {
    const g = jobGraph({ jobs: [job('first', 'cancelled'), job('second', 'failed')], issueGraph: closedIssue(1, 'completed'), items: items(item(1, 'done', 'second', { issueState: 'closed', issueReason: 'completed' })) });
    expect(node(g, issueNodeId('acme/app', 1))).toMatchObject({ stage: 'done', stageText: 'Done' });
    expect(node(g, jobNodeId('first'))).toMatchObject({ stage: 'superseded', stageText: 'Superseded' });
    expect(node(g, jobNodeId('second')).stage).toBe('superseded');
    expect(g.stages).toEqual({ superseded: 2 });
    expect(g.trees[0]!.blocking).toEqual([]);
  });

  it('an issue closed as not planned is dropped, not done: its job shows cancelled, no failure', () => {
    const g = jobGraph({ jobs: [job('a', 'failed')], issueGraph: closedIssue(1, 'not_planned'), items: items(item(1, 'dropped', 'a', { issueState: 'closed', issueReason: 'not_planned' })) });
    expect(node(g, issueNodeId('acme/app', 1)).stage).toBe('cancelled');
    expect(node(g, jobNodeId('a')).stage).toBe('cancelled');
    expect(g.stages.failed).toBeUndefined();
  });

  it('an issue a later job finished is done: the cancelled or failed jobs before it are superseded', () => {
    const g = jobGraph({ jobs: [
      job('cancelled', 'cancelled'), job('done', 'finished', { rerunOf: 'cancelled', ...followed(PR(3), 'merged') }),
      job('failed', 'failed', {}, 2), job('rerun', 'running', { rerunOf: 'failed' }, 2),
    ], items: items(item(1, 'done', 'done'), item(2, 'working', 'rerun')) });
    expect(node(g, issueNodeId('acme/app', 1)).stage).toBe('done');
    expect(node(g, jobNodeId('cancelled')).stage).toBe('superseded');
    expect(node(g, jobNodeId('failed')).stage).toBe('superseded');
    expect(node(g, issueNodeId('acme/app', 2)).stage).toBe('running');
    expect(g.stages).toEqual({ superseded: 2, done: 1, running: 1 });
  });

  it('a cancelled tend of a pull request that merged does not undo the issue: it is superseded', () => {
    const issueGraph = placeGraph({
      issue: { repo: 'acme/app', number: 1, url: 'https://github.com/acme/app/issues/1', title: 'issue 1', state: 'open', updatedAt: '2026-10-01T00:00:00Z' },
      owner: { login: 'acme' }, projects: [], references: [], subIssues: [],
      closedBy: [{ kind: 'pull_request', repo: 'acme/app', number: 3, url: PR(3), state: 'merged' }],
    });
    const done = job('done', 'finished', { sourceState: { source: { pullRequest: PR(3), follow: 'tended', tended: { pullRequest: PR(3), step: 'rebase', nextJobId: 'tend' } } } });
    const g = jobGraph({ jobs: [done, job('tend', 'cancelled', { rerunOf: 'done' })], issueGraph, items: items(item(1, 'done', 'tend', { pullRequest: PR(3), pullRequestState: 'merged' })) });
    expect(node(g, jobNodeId('done')).stage).toBe('done');
    expect(node(g, issueNodeId('acme/app', 1)).stage).toBe('done');
    expect(node(g, jobNodeId('tend')).stage).toBe('superseded');
  });

  it('a run again that failed after a finished job stays failed: nothing took its place', () => {
    const g = jobGraph({ jobs: [job('done', 'finished'), job('again', 'failed', { rerunOf: 'done' })], items: items(item(1, 'failed', 'again', { failedJobId: 'again' })) });
    expect(node(g, jobNodeId('again')).stage).toBe('failed');
    expect(node(g, issueNodeId('acme/app', 1)).stage).toBe('failed');
    expect(g.stages.failed).toBe(1);
  });

  it('a dismissed failed job is superseded: it counts as no failure', () => {
    const g = jobGraph({ jobs: [job('a', 'failed', { dismissedAt: '2026-10-03T00:00:00.000Z' })], items: items(item(1, 'dropped', 'a')) });
    expect(node(g, jobNodeId('a'))).toMatchObject({ stage: 'superseded', stageText: 'Dismissed' });
    expect(g.trees[0]!.stages).toEqual({ superseded: 1 });
    expect(g.trees[0]!.summary).not.toContain('failed');
  });

  it('a failed job handed to a person waits on you: no failure counted', () => {
    const g = jobGraph({ jobs: [job('a', 'failed')], items: items(item(1, 'needs_you', 'a', { failedJobId: 'a', waitingOn: 'a hand-off' })) });
    expect(node(g, jobNodeId('a'))).toMatchObject({ stage: 'waiting', handedOff: true, waitsOnYou: true, stageText: 'Waiting on you: take it over' });
    expect(node(g, issueNodeId('acme/app', 1)).stage).toBe('waiting');
    expect(g.stages).toEqual({ waiting: 1 });
  });

  it('a partly done job of an issue the ledger has done waits on nothing', () => {
    const g = jobGraph({ jobs: [job('part', 'finished', { partlyDone: PR(4), ...followed(PR(4), 'open') })], issueGraph: closedIssue(1, 'completed'), items: items(item(1, 'done', 'part', { issueState: 'closed' })) });
    expect(node(g, jobNodeId('part')).stage).toBe('done');
    expect(node(g, issueNodeId('acme/app', 1)).stage).toBe('done');
  });

  it('with no ledger item (a job of no source), a job keeps its own stage', () => {
    const g = jobGraph({ jobs: [job('a', 'failed', { dismissedAt: '2026-10-03T00:00:00.000Z' })] });
    expect(node(g, jobNodeId('a')).stage).toBe('failed');
  });
});
