// Issue #2840: planned work — a work plan's tree of plan pieces and plan tasks, read from GitHub's sub-issues (and the
// required children jobs filed), each plan task's status rolled up from the job graph's jobs of its issue, and each plan
// piece and the work plan rolled up from what is under them. Pure.
import { describe, expect, it } from 'vitest';
import { jobGraph, type JobGraphLink } from '../../src/domain/job-graph.ts';
import { placeGraph, type IssueGraph, type ItemRef } from '../../src/domain/issue-graph.ts';
import { pieceArtifactOf, plannedWork, rollUpStatuses, type PlanStatus } from '../../src/domain/planned-work.ts';
import type { Job, JobStatus } from '../../src/domain/types.ts';
import type { WorkItem } from '../../src/domain/work-items.ts';

const url = (n: number) => `https://github.com/acme/app/issues/${n}`;
const ref = (n: number): ItemRef => ({ kind: 'issue', repo: 'acme/app', number: n, url: url(n) });

let made = 0;
const job = (id: string, status: JobStatus, issue: number, over: Partial<Job> = {}): Job => ({
  id, spec: { executor: 'test', payload: {}, goal: `goal ${id}` }, priority: 50, status, approved: true, attempts: 1,
  createdAt: new Date(Date.UTC(2026, 9, 1, 0, made++)).toISOString(), updatedAt: '2026-10-02T00:00:00.000Z',
  source: { source: 'github', kind: 'issue', key: url(issue), url: url(issue), repo: 'acme/app', number: issue, title: `issue ${issue}` },
  ...over,
} as Job);

/** One read of an issue: its title, its sub-issues and the issues that block it. */
const read = (n: number, subIssues: number[] = [], over: { blockedBy?: number[]; state?: string; stateReason?: string; parent?: number; artifact?: string; updatedAt?: string } = {}): IssueGraph => placeGraph({
  issue: {
    repo: 'acme/app', number: n, url: url(n), title: `title ${n}`, state: over.state ?? 'OPEN', ...(over.stateReason ? { stateReason: over.stateReason } : {}),
    updatedAt: over.updatedAt ?? '2026-10-02T00:00:00Z', ...(over.artifact !== undefined ? { artifact: over.artifact } : {}),
  },
  owner: { login: 'acme' }, projects: [], closedBy: [], references: [], subIssues: subIssues.map(ref),
  ...(over.parent ? { parent: ref(over.parent) } : {}), ...(over.blockedBy ? { blockedBy: over.blockedBy.map(ref) } : {}),
});
const merged = (...reads: IssueGraph[]): IssueGraph => {
  const nodes = new Map<string, IssueGraph['nodes'][number]>();
  for (const r of reads) for (const n of r.nodes) nodes.set(n.id, { ...n, attrs: { ...nodes.get(n.id)?.attrs, ...n.attrs } });
  const edges = new Map(reads.flatMap((r) => r.edges).map((e) => [`${e.from} ${e.kind} ${e.to}`, e]));
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
};

const planOf = (root: number, issueGraph: IssueGraph, jobs: Job[], links: JobGraphLink[] = []) =>
  plannedWork({ root: { repo: 'acme/app', number: root }, issueGraph, links, graph: jobGraph({ jobs, links, issueGraph }) });

describe('the roll-up of statuses (issue #2840)', () => {
  it.each<[PlanStatus[], PlanStatus]>([
    [[], 'planned'], [['planned', 'planned'], 'planned'], [['done', 'done'], 'done'],
    [['done', 'running'], 'running'], [['done', 'planned'], 'running'], [['running', 'blocked'], 'blocked'], [['done', 'blocked'], 'blocked'],
  ])('%j rolls up to %s', (statuses, status) => { expect(rollUpStatuses(statuses)).toBe(status); });
});

describe('planned work (issue #2840)', () => {
  // Plan 1: pieces 2 and 3. Piece 2: tasks 4 and 5; piece 3: task 6. Task 5 depends on task 4.
  const tree = () => merged(read(1, [2, 3]), read(2, [4, 5]), read(3, [6]), read(4), read(5, [], { blockedBy: [4] }), read(6));

  it('reads the tree from the sub-issues: plan, pieces, tasks, with titles and what each task depends on', () => {
    const p = planOf(1, tree(), []);
    expect(p).toMatchObject({ id: 'acme/app#1', title: 'title 1', url: url(1), status: 'planned' });
    expect(p.pieces.map((x) => x.id)).toEqual(['acme/app#2', 'acme/app#3']);
    expect(p.pieces[0]!.tasks.map((t) => [t.id, t.title, t.status, t.dependsOn])).toEqual([
      ['acme/app#4', 'title 4', 'planned', []], ['acme/app#5', 'title 5', 'planned', ['acme/app#4']],
    ]);
    expect(p.counts).toEqual({ planned: 3, running: 0, done: 0, blocked: 0 });
  });

  it('a task with no job is planned; a running, a queued or a PR-open job runs it; all done is done', () => {
    const p = planOf(1, tree(), [
      job('a', 'finished', 4), job('b', 'running', 5), job('c', 'queued', 6),
    ]);
    const [two, three] = p.pieces;
    expect(two!.tasks.map((t) => t.status)).toEqual(['done', 'running']);
    expect(two!.status).toBe('running');
    expect(three!.tasks[0]!.status).toBe('running');
    expect(p.status).toBe('running');
    expect(two!.tasks[1]!.jobs).toEqual([expect.objectContaining({ id: 'b', status: 'running', stage: 'running' })]);
    expect(p.counts).toEqual({ planned: 0, running: 2, done: 1, blocked: 0 });
  });

  it('a failed job, or one that waits on a person, blocks its task, its piece and the plan', () => {
    const failed = planOf(1, tree(), [job('a', 'failed', 4), job('b', 'running', 5)]);
    expect(failed.pieces[0]!.tasks[0]!.status).toBe('blocked');
    expect(failed.pieces[0]!.status).toBe('blocked');
    expect(failed.status).toBe('blocked');
    const asks = planOf(1, tree(), [job('a', 'waiting_answer', 6)]);
    expect(asks.pieces[1]!.tasks[0]!.status).toBe('blocked');
  });

  it('a failure a later job of its issue took the place of blocks nothing: the work-item ledger says so', () => {
    const jobs = [job('a', 'failed', 4), job('b', 'finished', 4, { rerunOf: 'a' })];
    const item = { key: url(4), state: 'done', stateSince: '2026-10-02T00:00:00Z', eventState: 'done', eventAt: '2026-10-02T00:00:00Z', jobId: 'b' } as WorkItem;
    const p = plannedWork({ root: { repo: 'acme/app', number: 1 }, issueGraph: tree(), links: [], graph: jobGraph({ jobs, issueGraph: tree(), items: new Map([[url(4), item]]) }) });
    expect(p.pieces[0]!.tasks[0]!.status).toBe('done');
    expect(p.pieces[0]!.tasks[0]!.jobs.map((j) => [j.id, j.stage, j.planStatus])).toEqual([['a', 'superseded', undefined], ['b', 'done', 'done']]);
  });

  it('all tasks done is a done piece; all pieces done is a done plan', () => {
    const p = planOf(1, tree(), [job('a', 'finished', 4), job('b', 'finished', 5), job('c', 'finished', 6)]);
    expect(p.pieces.map((x) => x.status)).toEqual(['done', 'done']);
    expect(p.status).toBe('done');
  });

  it('a task closed as completed with no job is done', () => {
    const p = planOf(1, merged(tree(), read(6, [], { state: 'CLOSED', stateReason: 'COMPLETED' })), []);
    expect(p.pieces[1]!.tasks[0]!.status).toBe('done');
  });

  it('a piece with no sub-issues is its own one task', () => {
    const p = planOf(1, merged(read(1, [2]), read(2)), [job('a', 'running', 2)]);
    expect(p.pieces[0]!.tasks.map((t) => [t.id, t.status, t.jobs.map((j) => j.id)])).toEqual([['acme/app#2', 'running', ['a']]]);
    expect(p.pieces[0]!.jobs).toEqual([]);
  });

  it('a piece\'s own jobs count beside its tasks', () => {
    const p = planOf(1, tree(), [job('a', 'failed', 3), job('b', 'finished', 6)]);
    expect(p.pieces[1]!.jobs.map((j) => j.id)).toEqual(['a']);
    expect(p.pieces[1]!.status).toBe('blocked');
  });

  it('a sub-issue known only from its own read, and a required child a job filed, are in the tree', () => {
    const links: JobGraphLink[] = [{ parent: { repo: 'acme/app', number: 3 }, child: { repo: 'acme/app', number: 7, url: url(7) }, required: true }];
    const p = planOf(1, merged(read(1, [2]), read(3, [], { parent: 1 })), [job('a', 'running', 7)], links);
    expect(p.pieces.map((x) => x.id)).toEqual(['acme/app#2', 'acme/app#3']);
    expect(p.pieces[1]!.tasks.map((t) => [t.id, t.status])).toEqual([['acme/app#7', 'running']]);
  });

  it('a deeper sub-issue\'s jobs count in its task, and a cycle ends', () => {
    const p = planOf(1, merged(read(1, [2]), read(2, [4]), read(4, [8]), read(8, [1])), [job('a', 'failed', 8)]);
    expect(p.pieces[0]!.tasks[0]!).toMatchObject({ id: 'acme/app#4', status: 'blocked' });
    expect(p.pieces[0]!.tasks[0]!.jobs.map((j) => j.id)).toEqual(['a']);
  });

  it('an issue with no sub-issues is a plan of one piece and one task; the case of the repository does not matter', () => {
    const p = plannedWork({ root: { repo: 'Acme/App', number: 9 }, issueGraph: read(9), links: [], graph: jobGraph({ jobs: [job('a', 'finished', 9)] }) });
    expect(p).toMatchObject({ id: 'acme/app#9', status: 'done', counts: { planned: 0, running: 0, done: 1, blocked: 0 } });
    expect(p.pieces).toHaveLength(1);
    expect(p.pieces[0]!.tasks[0]!.jobs.map((j) => j.id)).toEqual(['a']);
  });

  it('a piece\'s artifact is the Artifact line of its issue, as the issue graph keeps it; a line taken away leaves none', () => {
    const p = planOf(1, merged(tree(), read(2, [4, 5], { artifact: 'a screenshot of the result' }), read(3, [6], { artifact: 'https://github.com/acme/app/pull/9' })), []);
    expect(p.pieces.map((x) => x.artifact)).toEqual(['a screenshot of the result', 'https://github.com/acme/app/pull/9']);
    const after = planOf(1, merged(tree(), read(2, [4, 5], { artifact: 'old' }), read(2, [4, 5], { artifact: '' })), []);
    expect(after.pieces[0]!.artifact).toBeUndefined();
  });

  it('a task\'s updatedAt is the newest of its issue\'s update and its jobs\' stage changes', () => {
    const p = planOf(1, merged(tree(), read(5, [], { updatedAt: '2026-10-05T00:00:00Z' })), [job('a', 'running', 4, { startedAt: '2026-10-09T00:00:00Z' })]);
    const [four, five] = p.pieces[0]!.tasks;
    expect(five!.updatedAt).toBe('2026-10-05T00:00:00Z');
    expect(Date.parse(four!.updatedAt!)).toBe(Date.parse('2026-10-09T00:00:00Z'));
  });
});

describe('a piece\'s artifact line (issue #2840)', () => {
  it.each<[string, string]>([
    ['Some text\n\nArtifact: a screenshot of the result\nMore', 'a screenshot of the result'],
    ['**Artifact:** https://github.com/acme/app/pull/9', 'https://github.com/acme/app/pull/9'],
    ['- artifact: the report  ', 'the report'],
    ['No line here', ''],
    ['Artifact:', ''],
  ])('%j gives %j', (body, artifact) => { expect(pieceArtifactOf(body)).toBe(artifact); });

  it('keeps at most 300 characters', () => { expect(pieceArtifactOf(`Artifact: ${'x'.repeat(400)}`)).toHaveLength(300); });
});
