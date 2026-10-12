// Issue #900: GET /api/jobs/graph answers the job graph — the jobs /api/queue holds, a partly done job whose pull request
// waits on its merge, the job it ran before, and the issues a job filed — with each job's stage and the typed edges. Real
// database and HTTP server.
import { afterEach, describe, expect, it } from 'vitest';
import type { JobGraph } from '../../src/domain/types.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';

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
  t = await startTestApp({ dbPath: db.dbPath });
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

  it('answers an empty graph for a hopper with no job', async () => {
    const a = await start();
    const r = await a.api<JobGraph>('GET', '/api/jobs/graph');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ nodes: [], edges: [], trees: [], stages: {} });
  });
});
