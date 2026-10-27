// Issues #2840, #2861: planned work from the plan store. POST /ui/api/planned-work/import keeps a work plan from an
// issue's sub-issue tree as the issue graph holds it; GET /api/planned-work answers it from the store, each plan task's
// jobs and statuses rolled up, the jobs' stages the same as the job graph's; the plan stays with its sync off; artifacts
// are records; and `hopper plan` answers what the API does. Real database and HTTP server.
import { afterEach, describe, expect, it } from 'vitest';
import { perform, sender } from '../../src/cli-operator-call.ts';
import { planCall } from '../../src/cli-operator-plan.ts';
import { placeGraph, type ItemRef } from '../../src/domain/issue-graph.ts';
import type { JobGraph } from '../../src/domain/types.ts';
import type { PlanArtifactView, WorkPlan, WorkPlanSummary } from '../../src/domain/planned-work.ts';
import { syncWorkPlans } from '../../src/engine/plan-sync.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;

afterEach(async () => {
  await t?.stop();
  t = undefined;
  cleanup?.();
});

async function start(): Promise<{ a: TestApp; token: string }> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  t = await startTestApp({ dbPath: db.dbPath, plugins: { machines: lanes(4) }, seams: { levels: [] } });
  return { a: t, token: await t.login() };
}

const url = (n: number) => `https://github.com/acme/app/issues/${n}`;
const ref = (n: number): ItemRef => ({ kind: 'issue', repo: 'acme/app', number: n, url: url(n) });

/** Keep a read of issue `n` in the issue graph, as a GitHub source does: its title, sub-issues and blockers. */
function read(a: TestApp, n: number, subIssues: number[] = [], blockedBy: number[] = []): void {
  a.user().store.issueGraph.record(url(n), placeGraph({
    issue: { repo: 'acme/app', number: n, url: url(n), title: `title ${n}`, state: 'OPEN', updatedAt: '2026-10-02T00:00:00Z' },
    owner: { login: 'acme' }, projects: [], closedBy: [], references: [], subIssues: subIssues.map(ref), blockedBy: blockedBy.map(ref),
  }), new Date().toISOString());
}

const spec = { executor: 'test', payload: {}, machineId: 'nowhere' };
/** A job of issue `n` that ended: finished with its pull request (`pr`), or failed. */
function ended(a: TestApp, n: number, how: { pr?: string; follow?: string; failed?: boolean; ago?: number }) {
  const { store } = a.user();
  const j = store.jobs.create(spec, 50, { source: 'github', kind: 'github', key: url(n), url: url(n), repo: 'acme/app', number: n, title: `title ${n}` });
  const at = new Date(Date.now() - (how.ago ?? 0)).toISOString();
  store.jobs.update(j.id, how.failed ? { status: 'failed', finishedAt: at }
    : { status: 'finished', finishedAt: at, ...(how.pr ? { sourceState: { source: { pullRequest: how.pr, follow: how.follow ?? 'open' } } } : {}) });
  store.events.append({ type: 'job.queued', jobId: j.id, data: { spec, priority: 50 } });
  store.events.append(how.failed ? { type: 'job.failed', jobId: j.id, data: { error: 'boom' } } : { type: 'job.finished', jobId: j.id, data: { result: 'pull request ready for review' } });
  return j;
}

const q = (id: string) => `plan=${encodeURIComponent(id)}`;

describe('planned work from the plan store (issues #2840, #2861)', () => {
  it('imports a work plan from a sub-issue tree, each plan task\'s status from its jobs as the job graph has them', async () => {
    const { a, token } = await start();
    // Plan 1: pieces 2 and 3. Piece 2: tasks 4 and 5 (5 waits on 4); piece 3: tasks 6 and 7.
    read(a, 1, [2, 3]); read(a, 2, [4, 5]); read(a, 3, [6, 7]); read(a, 4); read(a, 5, [], [4]); read(a, 6); read(a, 7);
    // Task 4's job merged three days ago, out of the queue's window: only the plan's own read of its issue brings it in.
    const done = ended(a, 4, { pr: 'https://github.com/acme/app/pull/40', follow: 'merged', ago: 3 * 86_400_000 });
    const failed = ended(a, 6, { failed: true });
    const open = ended(a, 7, { pr: 'https://github.com/acme/app/pull/70' });

    expect((await a.api('GET', `/api/planned-work?${q('acme/app#1')}`)).status).toBe(404);
    const imported = await a.ui<WorkPlan>('/ui/api/planned-work/import', { issue: 'acme/app#1' }, { token });
    expect(imported.status).toBe(200);
    const r = await a.api<WorkPlan>('GET', `/api/planned-work?${q('acme/app#1')}`);
    expect(r.status).toBe(200);
    const p = r.body;
    expect(p).toEqual(imported.body);
    expect(p).toMatchObject({ id: 'acme/app#1', title: 'title 1', status: 'blocked', sync: 'github', counts: { planned: 1, running: 1, done: 1, blocked: 1 } });
    expect(p.pieces.map((x) => [x.id, x.status])).toEqual([['acme/app#2', 'running'], ['acme/app#3', 'blocked']]);
    const tasks = p.pieces.flatMap((x) => x.tasks);
    expect(tasks.map((x) => [x.id, x.status, x.jobs.map((j) => j.id), x.dependsOn])).toEqual([
      ['acme/app#4', 'done', [done.id], []], ['acme/app#5', 'planned', [], ['acme/app#4']],
      ['acme/app#6', 'blocked', [failed.id], []], ['acme/app#7', 'running', [open.id], []],
    ]);
    // The jobs' pull requests are artifacts of their tasks, recorded by the sync.
    expect(tasks.map((x) => x.artifacts.map((y) => [y.type, y.ref, y.jobId, y.source]))).toEqual([
      [['pull_request', 'https://github.com/acme/app/pull/40', done.id, 'sync']], [], [], [['pull_request', 'https://github.com/acme/app/pull/70', open.id, 'sync']],
    ]);
    // The numbers are the Jobs view's: each job's stage is the job graph's.
    const g = (await a.api<JobGraph>('GET', '/api/jobs/graph')).body;
    for (const j of [failed, open]) {
      expect(tasks.flatMap((x) => x.jobs).find((x) => x.id === j.id)?.stage).toBe(g.nodes.find((n) => n.id === `job:${j.id}`)?.stage);
    }
    // The issue's URL names it too; the list has it.
    expect((await a.api<WorkPlan>('GET', `/api/planned-work?${q(url(1))}`)).body.counts).toEqual(p.counts);
    const list = (await a.api<{ plans: WorkPlanSummary[] }>('GET', '/api/planned-work/plans')).body.plans;
    expect(list).toEqual([expect.objectContaining({ id: 'acme/app#1', status: 'blocked', counts: p.counts, pieces: 2, tasks: 4, sync: 'github' })]);
  });

  it('keeps the plan as it is with its GitHub sync off; with it on, the sync takes new sub-issues in', async () => {
    const { a, token } = await start();
    read(a, 1, [2]); read(a, 2, [4]); read(a, 4);
    await a.ui('/ui/api/planned-work/import', { issue: 'acme/app#1', sync: 'off' }, { token });
    // GitHub changes the tree: with its sync off, the pass leaves the plan as the store keeps it.
    read(a, 2, [4, 5]); read(a, 5);
    expect(syncWorkPlans(a.user().store, new Date())).toBe(0);
    const kept = (await a.api<WorkPlan>('GET', `/api/planned-work?${q('acme/app#1')}`)).body;
    expect(kept).toMatchObject({ sync: 'off', title: 'title 1' });
    expect(kept.pieces[0]!.tasks.map((x) => x.id)).toEqual(['acme/app#4']);
    // Turned on, it syncs at once, and the pass syncs it from then on.
    const on = await a.ui<WorkPlan>('/ui/api/planned-work/sync', { plan: 'acme/app#1', sync: 'github' }, { token });
    expect(on.status).toBe(200);
    expect(on.body.pieces[0]!.tasks.map((x) => x.id)).toEqual(['acme/app#4', 'acme/app#5']);
    read(a, 2, [4, 5, 6]); read(a, 6);
    expect(syncWorkPlans(a.user().store, new Date())).toBe(1);
    const synced = (await a.api<WorkPlan>('GET', `/api/planned-work?${q('acme/app#1')}`)).body;
    expect(synced).toMatchObject({ sync: 'github' });
    expect(synced.pieces[0]!.tasks.map((x) => x.id)).toEqual(['acme/app#4', 'acme/app#5', 'acme/app#6']);
    expect(synced.syncedAt).toBeDefined();
  });

  it('keeps artifacts as records: added, exported, kept over a sync, and removed', async () => {
    const { a, token } = await start();
    read(a, 1, [2]); read(a, 2, [4, 5]); read(a, 4); read(a, 5);
    await a.ui('/ui/api/planned-work/import', { issue: 'acme/app#1' }, { token });
    const add = (body: Record<string, unknown>) => a.ui<PlanArtifactView>('/ui/api/planned-work/artifacts', { plan: 'acme/app#1', piece: 'acme/app#2', ...body }, { token });
    const shot = await add({ type: 'screenshot', ref: 'https://example.org/board.png' });
    expect(shot.status).toBe(200);
    expect(shot.body).toMatchObject({ type: 'screenshot', ref: 'https://example.org/board.png', source: 'person' });
    expect((await add({ task: 'acme/app#5', type: 'report', ref: 'report-1' })).status).toBe(200);
    expect((await add({ task: 'acme/app#9', type: 'link', ref: 'https://example.org' })).status).toBe(400);
    expect((await add({ piece: 'acme/app#8', type: 'link', ref: 'https://example.org' })).status).toBe(404);
    expect((await add({ type: 'link', ref: 'not a ref' })).status).toBe(400);
    syncWorkPlans(a.user().store, new Date());

    const plan = (await a.api<WorkPlan>('GET', `/api/planned-work?${q('acme/app#1')}`)).body;
    expect(plan.pieces[0]!.artifacts.map((x) => x.ref)).toEqual(['https://example.org/board.png']);
    expect(plan.pieces[0]!.tasks.map((x) => x.artifacts.map((y) => y.ref))).toEqual([[], ['report-1']]);
    const csv = await fetch(`${a.url}/api/planned-work/export?${q('acme/app#1')}&format=csv`);
    expect(csv.status).toBe(200);
    expect(csv.headers.get('content-type')).toMatch(/^text\/csv/);
    expect(csv.headers.get('content-disposition')).toBe('attachment; filename="planned-work-acme-app-1.csv"');
    const lines = (await csv.text()).trimEnd().split('\n');
    expect(lines[0]).toBe('plan_id,plan_title,piece_id,piece_title,piece_status,task_id,task_status,job_ids,job_statuses,piece_artifacts,task_artifacts,updated_at');
    expect(lines.slice(1).map((l) => l.split(',').slice(0, 11).join(','))).toEqual([
      'acme/app#1,title 1,acme/app#2,title 2,planned,acme/app#4,planned,,,https://example.org/board.png,',
      'acme/app#1,title 1,acme/app#2,title 2,planned,acme/app#5,planned,,,https://example.org/board.png,report-1',
    ]);
    const json = await a.api<{ plan_id: string; pieces: { artifacts: { ref: string }[]; tasks: { task_id: string; artifacts: { ref: string }[] }[] }[] }>('GET', `/api/planned-work/export?${q('acme/app#1')}&format=json`);
    expect(json.body).toMatchObject({ plan_id: 'acme/app#1', pieces: [{ artifacts: [{ ref: 'https://example.org/board.png' }], tasks: [{ task_id: 'acme/app#4', artifacts: [] }, { task_id: 'acme/app#5', artifacts: [{ ref: 'report-1' }] }] }] });
    expect((await a.api('GET', `/api/planned-work/export?${q('acme/app#1')}&format=xml`)).status).toBe(400);

    expect((await a.ui('/ui/api/planned-work/artifacts/remove', { plan: 'acme/app#1', id: shot.body.id }, { token })).status).toBe(200);
    expect((await a.ui('/ui/api/planned-work/artifacts/remove', { plan: 'acme/app#1', id: shot.body.id }, { token })).status).toBe(404);
    expect((await a.api<WorkPlan>('GET', `/api/planned-work?${q('acme/app#1')}`)).body.pieces[0]!.artifacts).toEqual([]);
    expect((await a.ui('/ui/api/planned-work/remove', { plan: 'acme/app#1' }, { token })).status).toBe(200);
    expect((await a.api('GET', `/api/planned-work?${q('acme/app#1')}`)).status).toBe(404);
  });

  it('hopper plan list, show and export answer what the API answers', async () => {
    const { a, token } = await start();
    read(a, 1, [2]); read(a, 2, [4]); read(a, 4);
    ended(a, 4, { pr: 'https://github.com/acme/app/pull/40' });
    const out: string[] = [];
    const send = sender(new URL(a.url), { 'x-hopper-session': token, origin: a.url });
    const cli = async (args: string[]) => { out.length = 0; expect(await perform(planCall(args), send, { out: (s) => out.push(s) })).toBe(0); return out.join(''); };
    expect(JSON.parse(await cli(['import', 'acme/app#1']))).toMatchObject({ id: 'acme/app#1' });
    expect(JSON.parse(await cli(['list']))).toEqual((await a.api('GET', '/api/planned-work/plans')).body);
    expect(JSON.parse(await cli(['show', 'acme/app#1']))).toEqual((await a.api('GET', `/api/planned-work?${q('acme/app#1')}`)).body);
    expect(JSON.parse(await cli(['export', url(1), '--format', 'json']))).toEqual((await a.api('GET', `/api/planned-work/export?${q('acme/app#1')}&format=json`)).body);
    expect(await cli(['export', 'acme/app#1', '--format', 'csv'])).toBe(await (await fetch(`${a.url}/api/planned-work/export?${q('acme/app#1')}&format=csv`)).text());
  });

  it('refuses what is not an issue (400), a plan the store does not keep and an issue the issue graph does not know (404)', async () => {
    const { a, token } = await start();
    expect((await a.api('GET', '/api/planned-work?plan=nothing')).status).toBe(400);
    expect((await a.api('GET', `/api/planned-work?${q('acme/app#99')}`)).status).toBe(404);
    expect((await a.ui('/ui/api/planned-work/import', { issue: 'acme/app#99' }, { token })).status).toBe(404);
    expect((await a.ui('/ui/api/planned-work/sync', { plan: 'acme/app#99' }, { token })).status).toBe(404);
  });
});
