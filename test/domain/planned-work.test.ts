// Issues #2840, #2861: planned work — a work plan's tree of plan pieces and plan tasks, imported from GitHub's sub-issues
// (and the required children jobs filed) into a kept plan, each plan task's status rolled up from the job graph's jobs of
// its issues and the jobs linked to it, each plan piece and the work plan rolled up from what is under them, and the plan
// artifacts the store keeps. Pure.
import { describe, expect, it } from 'vitest';
import { jobGraph, type JobGraphLink } from '../../src/domain/job-graph.ts';
import { placeGraph, type IssueGraph, type ItemRef } from '../../src/domain/issue-graph.ts';
import { plannedWork, rollUpStatuses, type PlanStatus } from '../../src/domain/planned-work.ts';
import { planFromIssueGraph, type KeptPlan, type PlanArtifact, type PlanJobLink } from '../../src/domain/work-plans.ts';
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

/** The kept plan a plan sync makes of the issue graph. */
const keptOf = (root: { repo: string; number: number }, issueGraph: IssueGraph, links: JobGraphLink[] = [], jobLinks: PlanJobLink[] = []): KeptPlan => ({
  ...planFromIssueGraph(root, issueGraph, links)!, sync: 'github', createdAt: '2026-10-02T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z', jobLinks,
});
const planOf = (root: number, issueGraph: IssueGraph, jobs: Job[], links: JobGraphLink[] = [], o: { jobLinks?: PlanJobLink[]; artifacts?: PlanArtifact[] } = {}) =>
  plannedWork({ plan: keptOf({ repo: 'acme/app', number: root }, issueGraph, links, o.jobLinks), artifacts: o.artifacts ?? [], graph: jobGraph({ jobs, links, issueGraph }) });

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
    const p = plannedWork({ plan: keptOf({ repo: 'acme/app', number: 1 }, tree()), artifacts: [], graph: jobGraph({ jobs, issueGraph: tree(), items: new Map([[url(4), item]]) }) });
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
    const p = plannedWork({ plan: keptOf({ repo: 'Acme/App', number: 9 }, read(9)), artifacts: [], graph: jobGraph({ jobs: [job('a', 'finished', 9)] }) });
    expect(p).toMatchObject({ id: 'acme/app#9', status: 'done', counts: { planned: 0, running: 0, done: 1, blocked: 0 } });
    expect(p.pieces).toHaveLength(1);
    expect(p.pieces[0]!.tasks[0]!.jobs.map((j) => j.id)).toEqual(['a']);
  });

  it('shows the artifacts the store keeps: a piece\'s own on the piece, a task\'s on its task', () => {
    const at = '2026-10-03T00:00:00Z';
    const artifact = (id: string, pieceId: string, taskId?: string): PlanArtifact => ({
      id, planId: 'acme/app#1', pieceId, ...(taskId ? { taskId } : {}), type: 'link', ref: `https://example.org/${id}`, source: 'person', by: 'someone', createdAt: at, updatedAt: at,
    });
    const p = planOf(1, tree(), [], [], { artifacts: [artifact('x', 'acme/app#2'), artifact('y', 'acme/app#2', 'acme/app#5'), artifact('z', 'acme/app#3', 'acme/app#6')] });
    expect(p.pieces.map((x) => x.artifacts.map((a) => a.id))).toEqual([['x'], []]);
    expect(p.pieces.flatMap((x) => x.tasks.map((t) => t.artifacts.map((a) => a.id)))).toEqual([[], ['y'], ['z']]);
    expect(p.pieces[0]!.artifacts[0]).toEqual({ id: 'x', type: 'link', ref: 'https://example.org/x', source: 'person', by: 'someone', createdAt: at, updatedAt: at });
  });

  it('a job linked to a task in the store counts for it, though no source key ties it to the task\'s issue', () => {
    const loose = job('a', 'failed', 4, { source: undefined });
    const p = planOf(1, tree(), [loose], [], { jobLinks: [{ level: 'task', item: 'acme/app#6', jobId: 'a' }] });
    expect(p.pieces[1]!.tasks[0]!).toMatchObject({ id: 'acme/app#6', status: 'blocked' });
    expect(p.pieces[1]!.tasks[0]!.jobs.map((j) => j.id)).toEqual(['a']);
  });

  it('the issue graph not knowing the root imports nothing', () => {
    expect(planFromIssueGraph({ repo: 'acme/app', number: 99 }, tree(), [])).toBeUndefined();
  });

  it('a task\'s updatedAt is the newest of its issue\'s update and its jobs\' stage changes', () => {
    const p = planOf(1, merged(tree(), read(5, [], { updatedAt: '2026-10-05T00:00:00Z' })), [job('a', 'running', 4, { startedAt: '2026-10-09T00:00:00Z' })]);
    const [four, five] = p.pieces[0]!.tasks;
    expect(five!.updatedAt).toBe('2026-10-05T00:00:00Z');
    expect(Date.parse(four!.updatedAt!)).toBe(Date.parse('2026-10-09T00:00:00Z'));
  });
});
