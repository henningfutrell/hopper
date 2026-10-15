// Issue #1072: a running job asks the hopper where a pull request stands (`pr status`), not GitHub. The daemon, store and
// HTTP edge are real; GitHub is a fake on loopback (test/support/fake-forges.ts); the job runs the real `hopper-gh`
// script against the hopper, as in github-proxy.test.ts.
//
// Feature: pr status through the hopper
//   Scenario: a job asks the hopper where a pull request stands, not GitHub
//     Given a pull request the hopper follows, as the Pull requests list shows it
//     When a job runs `sh "$HOPPER_GH" pr status N --repo octo/tools`
//     Then the hopper answers from its records (`source: hopper`), as the Pull requests list says, and GitHub is not asked
//     And a pull request it does not know is read on GitHub once (`source: github`), then from the repo-query cache (`source: cache`)
//   Scenario: a job waits on its pull request's checks on its job stream, not by asking again (part 2)
//     Given a pull request the hopper follows, its checks running
//     When a job runs `sh "$HOPPER_GH" pr wait N --repo octo/tools`
//     Then the hopper opens a watch on the job's stream, and the job waits on it
//     When the hopper sees the checks end
//     Then the wait ends with the pull request's status, the job asked once, and GitHub was not asked
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DomainEvent, Job } from '../../src/domain/types.ts';
import { ADMIN_ID } from '../../src/domain/types.ts';
import { createFakeGitHub } from '../support/fake-forges.ts';
import { connectGitHub } from '../support/github-account.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { holder, hopperGh, type Run } from '../support/job-holder.ts';
import { waitFor } from '../support/wait.ts';

const apps: TestApp[] = [];
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) await c();
});

const json = (r: Run): Record<string, unknown> => JSON.parse(r.stdout) as Record<string, unknown>;

async function start() {
  const github = await createFakeGitHub({ clientId: 'gh-client-id' });
  cleanups.push(() => github.close());
  github.tokens.set('test-account-token', 'owner');
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const root = mkdtempSync(join(tmpdir(), 'hopper-pr-status-machine-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const h = holder(root);
  cleanups.push(() => { for (const j of h.held.values()) j.end(); });
  const app = await startTestApp({
    dbPath: db.dbPath,
    seams: { executors: [h.executor] },
    plugins: { executors: [{ name: 'test', plugin: 'test' }] },
    env: { HOPPER_GITHUB_URL: github.url, HOPPER_GITHUB_CLIENT_ID: 'gh-client-id', HOPPER_GITHUB_APP_SLUG: 'hopper-test' },
  });
  apps.push(app);
  connectGitHub(app, ['octo/tools', 'octo/site']);
  return { app, github, root, held: h.held, reach: h.reach };
}

/** A job of the user's own, running in the holder: its id and variables. */
async function running(t: Awaited<ReturnType<typeof start>>, repo = 'octo/tools', userId = ADMIN_ID, number?: number): Promise<{ job: Job; env: Record<string, string> }> {
  const job = await t.app.pull({}, { executor: 'holder', repo, ...(number !== undefined ? { number } : {}) }, userId);
  const env = await waitFor(async () => t.held.get(job.id)?.env, { what: `job ${job.id} to run` });
  return { job, env };
}

const eventsOf = (a: TestApp, userId: string, type: string): DomainEvent[] =>
  a.user(userId).store.events.recent(1000).filter((e) => e.type === type);

describe('pr status through the hopper (issue #1072)', () => {
  it('answers pr status from what the hopper knows; one it does not know is read on GitHub once, then kept', async () => {
    const t = await start();
    // A done job of octo/tools#9 whose pull request #10 the hopper follows: its checks still run.
    const followed = await running(t, 'octo/tools', ADMIN_ID, 9);
    t.held.get(followed.job.id)!.end();
    await t.app.waitForStatus(followed.job.id, 'finished');
    const pr10 = `${t.github.url}/octo/tools/pull/10`;
    t.app.user().store.jobs.update(followed.job.id, { sourceState: { source: { pullRequest: pr10, follow: 'open', seen: {
      draft: false, conflicting: false, checks: 'pending', base: 'dev', headRef: 'issue-9',
    } } } });
    const { env } = await running(t);
    const before = t.github.requests.length;

    const known = await hopperGh(t.root, env, ['pr', 'status', '10', '--repo', 'octo/tools']);
    expect(known.code).toBe(0);
    expect(json(known)).toMatchObject({
      ok: true, op: 'pr.status', source: 'hopper', number: 10, url: pr10, state: 'open', checks: 'pending', mergeable: 'mergeable', draft: false,
      base: 'dev', head: 'issue-9', waits: 'yolo off', failedChecks: [],
    });
    expect(t.github.requests.length).toBe(before);
    // The same answer the Pull requests list gives a person.
    const list = await t.app.api<{ repos: { pullRequests: { pullRequest?: { number: number }; checks: string; waits?: string }[] }[] }>('GET', '/api/pull-requests');
    const card = list.body.repos.flatMap((r) => r.pullRequests).find((c) => c.pullRequest?.number === 10);
    expect(card).toMatchObject({ checks: json(known).checks, waits: json(known).waits });

    const opened = String(json(await hopperGh(t.root, env, ['pr', 'create', '--repo', 'octo/tools', '--head', 'issue-7-faster', '--title', 'Faster', '--body', 'Closes #7'])).number);
    const reads = () => t.github.requests.filter((r) => r.method === 'GET' && r.path.includes('/octo/tools/')).length;
    const readsBefore = reads();
    const read = await hopperGh(t.root, env, ['pr', 'status', opened, '--repo', 'octo/tools']);
    expect(json(read)).toMatchObject({ ok: true, source: 'github', number: Number(opened), state: 'open', draft: false, checks: 'none', head: 'issue-7-faster', base: 'dev' });
    const readsAfter = reads();
    expect(readsAfter).toBeGreaterThan(readsBefore);
    expect(json(await hopperGh(t.root, env, ['pr', 'status', opened, '--repo', 'octo/tools']))).toMatchObject({ source: 'cache', number: Number(opened) });
    expect(reads()).toBe(readsAfter);
    expect(eventsOf(t.app, ADMIN_ID, 'github_proxy.done').filter((e) => e.data.op === 'pr.status').map((e) => e.data.source).reverse()).toEqual(['hopper', 'github', 'cache']);
  });

  it('pr wait: the job waits on its stream until the hopper sees the checks end; one ask, no GitHub read', async () => {
    const t = await start();
    const followed = await running(t, 'octo/tools', ADMIN_ID, 9);
    t.held.get(followed.job.id)!.end();
    await t.app.waitForStatus(followed.job.id, 'finished');
    const pr10 = `${t.github.url}/octo/tools/pull/10`;
    const following = (checks: 'pending' | 'passing') => ({ sourceState: { source: { pullRequest: pr10, follow: 'open', seen: {
      draft: false, conflicting: false, checks, base: 'dev', headRef: 'issue-9',
    } } } });
    t.app.user().store.jobs.update(followed.job.id, following('pending'));
    const { job, env } = await running(t);
    const before = t.github.requests.length;

    const waiting = hopperGh(t.root, env, ['pr', 'wait', '10', '--repo', 'octo/tools', '--timeout', '60']);
    const watch = await waitFor(() => t.app.user().store.jobStream.openWatches(job.id)[0], { what: 'the watch on pull request 10' });
    expect(watch.body).toEqual({ owner: 'github', repo: 'octo/tools', number: '10' });
    // The hopper sees the checks pass: what following found, and its event.
    t.app.user().store.jobs.update(followed.job.id, following('passing'));
    t.app.user().store.events.append({ type: 'job.pull_request_seen', jobId: followed.job.id, data: { pullRequest: pr10, wait: 'merge' } });

    const done = await waiting;
    expect(done.code).toBe(0);
    expect(json(done)).toMatchObject({ number: 10, url: pr10, state: 'open', checks: 'passing', head: 'issue-9' });
    expect(t.github.requests.length).toBe(before);
    expect(eventsOf(t.app, ADMIN_ID, 'github_proxy.done').filter((e) => e.jobId === job.id).map((e) => e.data.wait)).toEqual([watch.id]);
    const stream = t.app.user().store.jobStream.since(job.id, 0, 100, watch.id).map((e) => e.type);
    expect(stream).toEqual(['github.pr_waiting', 'github.pr_settled']);
  });
});
