// Issue #900: GET /api/jobs/graph answers the job graph — the jobs /api/queue holds, a partly done job whose pull request
// waits on its merge, the job it ran before, and the issues a job filed — with each job's stage and the typed edges. Real
// database and HTTP server.
import { afterEach, describe, expect, it } from 'vitest';
import type { JobGraph } from '../../src/domain/types.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

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

const PR = 'https://github.com/acme/app/pull/12';
const issue = (number: number) => ({ source: 'manual', kind: 'item', key: `https://github.com/acme/app/issues/${number}`, url: `https://github.com/acme/app/issues/${number}`, repo: 'acme/app', number, title: `issue ${number}` });

describe('GET /api/jobs/graph (issue #900)', () => {
  it('answers each job with its stage, a partly done job waiting on its merge, the run after it, and the issues a job filed', async () => {
    const a = await start();
    const part = await a.pull({ op: 'echo' }, { key: 'item-1' });
    await a.waitForStatus(part.id, 'finished');
    const next = await a.pull({ op: 'echo' }, { key: 'item-2' });
    await a.waitForStatus(next.id, 'finished');
    const { store } = a.user();
    // The first job shipped part of issue 1 (its pull request open); the second runs the rest of it, and filed issue 3.
    store.jobs.update(part.id, { source: issue(1), partlyDone: PR, sourceState: { source: { pullRequest: PR, follow: 'open', seen: { draft: false, conflicting: false, checks: 'pending' } } } });
    store.jobs.update(next.id, { source: issue(1), rerunOf: part.id, tasks: { done: 3, total: 4 } });
    store.events.append({ type: 'job.child_issue_filed', jobId: next.id, data: { parent: { repo: 'acme/app', number: 1 }, child: { repo: 'acme/app', number: 3, url: 'https://github.com/acme/app/issues/3' }, required: true, requestId: 'r1' } } as Parameters<typeof store.events.append>[0]);

    const r = await a.api<JobGraph>('GET', '/api/jobs/graph');
    expect(r.status).toBe(200);
    const g = r.body;
    const node = (id: string) => g.nodes.find((n) => n.id === id);
    expect(node(`job:${part.id}`)).toMatchObject({ stage: 'partly_done', partlyDone: { pullRequest: PR, afterMerge: 'the next part of acme/app#1 runs' }, pullRequest: { url: PR, state: 'open', checks: 'pending' } });
    expect(node(`job:${next.id}`)).toMatchObject({ stage: 'done', tasks: { done: 3, total: 4 } });
    expect(node('issue:acme/app#3')).toMatchObject({ kind: 'issue', stage: 'no_job' });
    const edges = g.edges.map((e) => `${e.from} ${e.kind} ${e.to}`);
    expect(edges).toEqual(expect.arrayContaining([
      `job:${part.id} waits_on_merge pr:${PR}`,
      `job:${part.id} next_part job:${next.id}`,
      `issue:acme/app#1 works job:${part.id}`,
      'issue:acme/app#1 parent issue:acme/app#3',
    ]));
    expect(g.trees).toHaveLength(1);
    expect(g.trees[0]).toMatchObject({ root: 'issue:acme/app#1' });
    expect(g.trees[0]!.blocking).toEqual(expect.arrayContaining([`job:${part.id}`, `pr:${PR}`, 'issue:acme/app#3']));
    expect(g.stages).toEqual({ partly_done: 1, done: 1 });
  });

  it('answers an issue no job here works from its work item: done, though its jobs are gone from the graph (issue #1895)', async () => {
    const a = await start();
    const root = await a.pull({ op: 'echo' }, { key: 'item-1' });
    await a.waitForStatus(root.id, 'finished');
    const { store } = a.user();
    store.jobs.update(root.id, { source: issue(1) });
    for (const number of [3, 4]) store.events.append({ type: 'job.child_issue_filed', jobId: root.id, data: { parent: { repo: 'acme/app', number: 1 }, child: { repo: 'acme/app', number, url: issue(number).url }, required: true, requestId: `r${number}` } } as Parameters<typeof store.events.append>[0]);
    // Issue 3's job finished days ago, out of the queue's window, and GitHub closed the issue: its item is done, and no job
    // of it is in the graph.
    const old = await a.pull({ op: 'echo' }, { key: issue(3).key });
    await a.waitForStatus(old.id, 'finished');
    store.jobs.update(old.id, { finishedAt: '2026-01-01T00:00:00.000Z' });
    store.events.append({ type: 'work_item.issue_closed', data: { key: issue(3).key, reason: 'completed', via: 'delivery' } } as Parameters<typeof store.events.append>[0]);
    expect(store.workItems.get(issue(3).key)?.state).toBe('done');

    const g = (await a.api<JobGraph>('GET', '/api/jobs/graph')).body;
    expect(g.nodes.find((n) => n.id === 'issue:acme/app#3')).toMatchObject({ stage: 'done', stageText: 'Done' });
    expect(g.nodes.find((n) => n.id === 'issue:acme/app#4')).toMatchObject({ stage: 'no_job', stageText: 'Not started' });
  });

  it('answers an open question and an open hand-off as nodes of their job', async () => {
    const a = await start();
    const asks = await a.pull({ op: 'ask', message: 'Which store should the cache use?' }, { key: 'item-5' });
    const q = await a.waitForQuestion(asks.id, (x) => x.status === 'open');
    const broke = await a.pull({ op: 'fail', message: 'HOPPER_FAILED the build fails', ms: 0 }, { key: 'item-6' });
    const { store } = a.user();
    const handoff = await waitFor(async () => store.handoffs.list({ status: 'open' }).find((h) => h.jobId === broke.id), { what: 'the failed job handed off' });

    const g = (await a.api<JobGraph>('GET', '/api/jobs/graph')).body;
    expect(g.nodes.find((n) => n.id === `question:${q.id}`)).toMatchObject({ kind: 'question', stage: 'waiting', label: 'Which store should the cache use?', jobId: asks.id });
    expect(g.nodes.find((n) => n.id === `handoff:${handoff.id}`)).toMatchObject({ kind: 'handoff', stage: 'waiting', jobId: broke.id });
    expect(g.edges.map((e) => `${e.from} ${e.kind} ${e.to}`)).toEqual(expect.arrayContaining([
      `job:${asks.id} asks question:${q.id}`, `job:${broke.id} hands_off handoff:${handoff.id}`,
    ]));
  });

  it('answers the newest job of each issue it shows, so a later finished job supersedes an earlier failure (issue #1036)', async () => {
    const a = await start();
    const { store } = a.user();
    const key = 'https://github.com/acme/app/issues/7';
    const spec = { executor: 'test', payload: {}, machineId: 'nowhere' };
    const made = (status: 'failed' | 'finished', over: object) => {
      const j = store.jobs.create(spec, 50, { source: 'github', kind: 'github', key, url: key, repo: 'acme/app', number: 7, title: 'issue 7' });
      store.jobs.update(j.id, { status, ...over });
      return j;
    };
    // The failed job ended today: the queue holds it. The job that ran the issue again merged three days ago: only the
    // newest job of the issue brings it in. Their events move the issue's work item (issue #1067).
    const failed = made('failed', { finishedAt: new Date().toISOString() });
    store.events.append({ type: 'job.queued', jobId: failed.id, data: { spec, priority: 50 } });
    store.events.append({ type: 'job.failed', jobId: failed.id, data: { error: 'boom' } });
    const done = made('finished', { rerunOf: failed.id, finishedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(), sourceState: { source: { pullRequest: PR, follow: 'merged' } } });
    store.events.append({ type: 'job.queued', jobId: done.id, data: { spec, priority: 50 } });
    store.events.append({ type: 'job.finished', jobId: done.id, data: { result: 'pull request ready for review' } });
    store.events.append({ type: 'job.pull_request_merged', jobId: done.id, data: { pullRequest: PR, part: false } });

    const g = (await a.api<JobGraph>('GET', '/api/jobs/graph')).body;
    const node = (id: string) => g.nodes.find((n) => n.id === id);
    expect(node(`job:${done.id}`)).toMatchObject({ stage: 'done' });
    expect(node(`job:${failed.id}`)).toMatchObject({ stage: 'superseded' });
    expect(node('issue:acme/app#7')).toMatchObject({ stage: 'done' });
    expect(g.stages).toEqual({ done: 1, superseded: 1 });
  });

  it('answers an empty graph for a hopper with no job', async () => {
    const a = await start();
    const r = await a.api<JobGraph>('GET', '/api/jobs/graph');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ nodes: [], edges: [], trees: [], stages: {} });
  });
});
