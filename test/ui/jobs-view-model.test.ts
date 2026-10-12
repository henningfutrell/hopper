// Issues #434, #900: the Jobs view's model — which job rows and trees show for a filter, in what order, the filter's
// choices, the counts per stage, each job's last event, a tree's layout, and a pull request in a few words.
import { describe, expect, it } from 'vitest';
import { jobGraph } from '../../src/domain/job-graph.ts';
import type { DomainEvent, Job, JobStatus } from '../../src/domain/types.ts';
import { filterChoices, jobRows, lastEvents, layoutTree, NO_FILTER, NODE_W, pullRequestText, shownTrees, stageCounts } from '../../ui/src/model/jobs-view.ts';

const job = (id: string, status: JobStatus, repo: string | null, at: string, over: Partial<Job> = {}): Job => ({
  id, spec: { executor: 'test', payload: {}, goal: `goal ${id}` }, priority: 50, status, approved: false,
  createdAt: at, updatedAt: at, startedAt: at, finishedAt: at, attempts: 0,
  ...(repo ? { source: { source: 'github', kind: 'issue', key: `${repo}#${id}`, repo, number: id.charCodeAt(0) } } : {}),
  ...over,
} as Job);
const event = (seq: number, jobId: string, type = 'job.started'): DomainEvent =>
  ({ seq, schemaVersion: 1, id: `e${seq}`, type, at: '2026-10-01T00:00:00Z', jobId, data: {} } as DomainEvent);

const graph = jobGraph({ jobs: [
  job('a', 'running', 'acme/widgets', '2026-10-01T10:00:00Z'),
  job('b', 'queued', 'acme/site', '2026-10-01T12:00:00Z'),
  job('c', 'finished', 'acme/widgets', '2026-10-01T11:00:00Z', { partlyDone: 'https://github.com/acme/widgets/pull/4' }),
  job('d', 'running', null, '2026-10-01T09:00:00Z'),
] });
const ids = (rows: { jobId?: string }[]) => rows.map((r) => r.jobId);

describe('jobRows', () => {
  it('shows every job with no filter, the latest stage change first', () => {
    expect(ids(jobRows(graph, NO_FILTER))).toEqual(['b', 'c', 'a', 'd']);
  });

  it('shows only the jobs of the stage and repository chosen', () => {
    expect(ids(jobRows(graph, { ...NO_FILTER, stage: 'running' }))).toEqual(['a', 'd']);
    expect(ids(jobRows(graph, { ...NO_FILTER, stage: 'partly_done' }))).toEqual(['c']);
    expect(ids(jobRows(graph, { ...NO_FILTER, repo: 'acme/widgets' }))).toEqual(['c', 'a']);
    expect(ids(jobRows(graph, { stage: 'running', repo: 'acme/widgets' }))).toEqual(['a']);
  });
});

describe('filterChoices and stageCounts', () => {
  it('offer the stages in their order and the repositories sorted, each once', () => {
    expect(filterChoices(graph)).toEqual({ stages: ['queued', 'running', 'partly_done'], repos: ['acme/site', 'acme/widgets'] });
  });

  it('count the jobs per stage, of one repository or all', () => {
    expect(stageCounts(graph, null)).toEqual({ queued: 1, running: 2, partly_done: 1 });
    expect(stageCounts(graph, 'acme/widgets')).toEqual({ running: 1, partly_done: 1 });
  });
});

describe('shownTrees', () => {
  it('shows the trees with a matching job, the blocked ones first', () => {
    const roots = shownTrees(graph, NO_FILTER).map((t) => t.root);
    expect(roots).toHaveLength(4);
    expect(shownTrees(graph, { ...NO_FILTER, stage: 'partly_done' }).map((t) => t.root)).toEqual([roots.find((r) => r.includes('acme/widgets#99'))]);
  });
});

describe('layoutTree', () => {
  it('gives every node of a tree a place, the root at the left', () => {
    const g = jobGraph({ jobs: [
      job('p', 'finished', 'acme/app', '2026-10-01T10:00:00Z', { partlyDone: 'https://github.com/acme/app/pull/4' }),
      job('q', 'running', 'acme/app', '2026-10-01T11:00:00Z', { rerunOf: 'p', source: { source: 'github', kind: 'issue', key: 'k', repo: 'acme/app', number: 'p'.charCodeAt(0) } }),
    ] });
    const t = g.trees[0]!;
    const layout = layoutTree(g, t);
    expect(layout.placed.map((p) => p.id).sort()).toEqual([...t.nodes].sort());
    const root = layout.placed.find((p) => p.id === t.root)!;
    expect(root.x).toBe(0);
    expect(layout.width).toBeGreaterThan(NODE_W);
    for (const p of layout.placed) expect(p.y).toBeGreaterThanOrEqual(0);
  });

  it('places a question, a hand-off and a blocking issue too, and lists only jobs as rows (issue #900)', () => {
    const g = jobGraph({
      jobs: [job('w', 'waiting_answer', 'acme/app', '2026-10-01T10:00:00Z')],
      questions: [{ id: 'q1', jobId: 'w', text: 'Which one?', since: '2026-10-01T10:30:00Z' }],
      handoffs: [{ id: 'h1', jobId: 'w', text: 'Needs a person.', since: '2026-10-01T10:40:00Z' }],
    });
    const t = g.trees[0]!;
    expect(layoutTree(g, t).placed.map((p) => p.id).sort()).toEqual([...t.nodes].sort());
    expect(t.nodes).toEqual(expect.arrayContaining(['question:q1', 'handoff:h1']));
    expect(jobRows(g, NO_FILTER).map((n) => n.id)).toEqual(['job:w']);
    expect(stageCounts(g, null)).toEqual({ waiting: 1 });
  });
});

describe('pullRequestText', () => {
  it('says where a pull request is and how its checks are', () => {
    expect(pullRequestText({ url: 'u', state: 'open', checks: 'failing', conflicting: true })).toBe('open · conflicts · checks failing');
    expect(pullRequestText({ url: 'u', state: 'open', checks: 'none' })).toBe('open · no checks');
    expect(pullRequestText({ url: 'u', state: 'merged', checks: 'passing' })).toBe('merged');
    expect(pullRequestText({ url: 'u', state: 'open', draft: true })).toBe('draft');
  });
});

describe('lastEvents', () => {
  it('keeps the newest event of each job over every list, by seq', () => {
    const last = lastEvents([event(3, 'a'), event(1, 'b')], [event(5, 'a', 'job.finished'), event(2, 'b')]);
    expect(last.get('a')?.type).toBe('job.finished');
    expect(last.get('b')?.seq).toBe(2);
  });

  it('skips events with no job', () => {
    const none = { ...event(9, 'x'), jobId: undefined } as DomainEvent;
    expect(lastEvents([none]).size).toBe(0);
  });
});
