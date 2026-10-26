// Issue #2840: GET /api/planned-work answers one work plan — an issue's sub-issue tree from the issue graph — with each
// plan task's jobs and statuses rolled up, the jobs' stages the same as the job graph's. Real database and HTTP server.
import { afterEach, describe, expect, it } from 'vitest';
import { placeGraph, type ItemRef } from '../../src/domain/issue-graph.ts';
import type { JobGraph } from '../../src/domain/types.ts';
import type { WorkPlan } from '../../src/domain/planned-work.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;

afterEach(async () => {
  await t?.stop();
  t = undefined;
  cleanup?.();
});

async function start(): Promise<TestApp> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  t = await startTestApp({ dbPath: db.dbPath, plugins: { machines: lanes(4) }, seams: { levels: [] } });
  return t;
}

const url = (n: number) => `https://github.com/acme/app/issues/${n}`;
const ref = (n: number): ItemRef => ({ kind: 'issue', repo: 'acme/app', number: n, url: url(n) });

/** Keep a read of issue `n` in the issue graph, as a GitHub source does: its title, sub-issues and blockers. */
function read(a: TestApp, n: number, subIssues: number[] = [], blockedBy: number[] = [], artifact?: string): void {
  a.user().store.issueGraph.record(url(n), placeGraph({
    issue: { repo: 'acme/app', number: n, url: url(n), title: `title ${n}`, state: 'OPEN', updatedAt: '2026-10-02T00:00:00Z', ...(artifact !== undefined ? { artifact } : {}) },
    owner: { login: 'acme' }, projects: [], closedBy: [], references: [], subIssues: subIssues.map(ref), blockedBy: blockedBy.map(ref),
  }), new Date().toISOString());
}

describe('GET /api/planned-work (issue #2840)', () => {
  it('answers the work plan of a sub-issue tree, each plan task\'s status from its jobs as the job graph has them', async () => {
    const a = await start();
    const { store } = a.user();
    // Plan 1: pieces 2 and 3. Piece 2: tasks 4 and 5 (5 waits on 4); piece 3: tasks 6 and 7.
    read(a, 1, [2, 3]); read(a, 2, [4, 5]); read(a, 3, [6, 7]); read(a, 4); read(a, 5, [], [4]); read(a, 6); read(a, 7);
    const spec = { executor: 'test', payload: {}, machineId: 'nowhere' };
    const made = (n: number) => store.jobs.create(spec, 50, { source: 'github', kind: 'github', key: url(n), url: url(n), repo: 'acme/app', number: n, title: `title ${n}` });
    // Task 4's job merged three days ago, out of the queue's window: only the plan's own read of its issue brings it in.
    const done = made(4);
    store.jobs.update(done.id, { status: 'finished', finishedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(), sourceState: { source: { pullRequest: 'https://github.com/acme/app/pull/40', follow: 'merged' } } });
    store.events.append({ type: 'job.queued', jobId: done.id, data: { spec, priority: 50 } });
    store.events.append({ type: 'job.finished', jobId: done.id, data: { result: 'pull request ready for review' } });
    // Task 6's job failed today; task 7's pull request is open.
    const failed = made(6);
    store.jobs.update(failed.id, { status: 'failed', finishedAt: new Date().toISOString() });
    store.events.append({ type: 'job.queued', jobId: failed.id, data: { spec, priority: 50 } });
    store.events.append({ type: 'job.failed', jobId: failed.id, data: { error: 'boom' } });
    const open = made(7);
    store.jobs.update(open.id, { status: 'finished', finishedAt: new Date().toISOString(), sourceState: { source: { pullRequest: 'https://github.com/acme/app/pull/70', follow: 'open' } } });
    store.events.append({ type: 'job.queued', jobId: open.id, data: { spec, priority: 50 } });
    store.events.append({ type: 'job.finished', jobId: open.id, data: { result: 'pull request ready for review' } });

    const r = await a.api<WorkPlan>('GET', `/api/planned-work?issue=${encodeURIComponent('acme/app#1')}`);
    expect(r.status).toBe(200);
    const p = r.body;
    expect(p).toMatchObject({ id: 'acme/app#1', title: 'title 1', status: 'blocked', counts: { planned: 1, running: 1, done: 1, blocked: 1 } });
    expect(p.pieces.map((x) => [x.id, x.status])).toEqual([['acme/app#2', 'running'], ['acme/app#3', 'blocked']]);
    const tasks = p.pieces.flatMap((x) => x.tasks);
    expect(tasks.map((x) => [x.id, x.status, x.jobs.map((j) => j.id), x.dependsOn])).toEqual([
      ['acme/app#4', 'done', [done.id], []], ['acme/app#5', 'planned', [], ['acme/app#4']],
      ['acme/app#6', 'blocked', [failed.id], []], ['acme/app#7', 'running', [open.id], []],
    ]);
    // The numbers are the Jobs view's: each job's stage is the job graph's.
    const g = (await a.api<JobGraph>('GET', '/api/jobs/graph')).body;
    for (const j of [failed, open]) {
      const job = tasks.flatMap((x) => x.jobs).find((x) => x.id === j.id);
      expect(job?.stage).toBe(g.nodes.find((n) => n.id === `job:${j.id}`)?.stage);
    }
    // The issue's URL names it too.
    expect((await a.api<WorkPlan>('GET', `/api/planned-work?issue=${encodeURIComponent(url(1))}`)).body.counts).toEqual(p.counts);
  });

  it('exports the work plan as CSV, one row per plan task, and as the nested JSON (issue #2840)', async () => {
    const a = await start();
    read(a, 1, [2]); read(a, 2, [4, 5], [], 'a screenshot of the result'); read(a, 4); read(a, 5);
    const q = `issue=${encodeURIComponent('acme/app#1')}`;
    const plan = (await a.api<WorkPlan>('GET', `/api/planned-work?${q}`)).body;
    expect(plan.pieces[0]!.artifact).toBe('a screenshot of the result');
    const csv = await fetch(`${a.url}/api/planned-work/export?${q}&format=csv`);
    expect(csv.status).toBe(200);
    expect(csv.headers.get('content-type')).toMatch(/^text\/csv/);
    expect(csv.headers.get('content-disposition')).toBe('attachment; filename="planned-work-acme-app-1.csv"');
    const lines = (await csv.text()).trimEnd().split('\n');
    expect(lines[0]).toBe('plan_id,plan_title,piece_id,piece_title,piece_status,task_id,task_status,job_ids,job_statuses,artifact,updated_at');
    expect(lines.slice(1).map((l) => l.split(',').slice(0, 7).join(','))).toEqual([
      'acme/app#1,title 1,acme/app#2,title 2,planned,acme/app#4,planned', 'acme/app#1,title 1,acme/app#2,title 2,planned,acme/app#5,planned',
    ]);
    const json = await a.api<{ plan_id: string; pieces: { artifact: string; tasks: { task_id: string }[] }[] }>('GET', `/api/planned-work/export?${q}&format=json`);
    expect(json.body).toMatchObject({ plan_id: 'acme/app#1', pieces: [{ artifact: 'a screenshot of the result', tasks: [{ task_id: 'acme/app#4' }, { task_id: 'acme/app#5' }] }] });
    expect((await a.api('GET', `/api/planned-work/export?${q}&format=xml`)).status).toBe(400);
  });

  it('refuses what is not an issue (400) and an issue it does not know (404)', async () => {
    const a = await start();
    expect((await a.api('GET', '/api/planned-work?issue=nothing')).status).toBe(400);
    expect((await a.api('GET', `/api/planned-work?issue=${encodeURIComponent('acme/app#99')}`)).status).toBe(404);
  });
});
