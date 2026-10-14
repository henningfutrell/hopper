// The done-check backfill (issue #637): the `not complete:` failures an earlier build left waiting on a person are
// judged again by the done rule of today. The issue closed as completed, or its pull request merged: the job ends
// finished, its failure and hand-off clear, and its issue stays closed — nothing runs again, nothing is reopened. A ready
// pull request open: the job is PR waiting, in the Pull requests list. Anything else: it stays in Failures, with a
// plain sentence. One event per job it changes, none for one it does not; a second run changes nothing. It runs once
// at the first start of this build, and again whenever it is asked, from the operator CLI. Real daemon, real database,
// real CLI; the in-memory fake GitHub at the GitHubApi seam.
import { afterEach, describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../../src/cli.ts';
import type { DomainEvent, FailuresView, Job, PullRequestsView } from '../../src/domain/types.ts';
import { createFakeGitHub, type FakeGitHub } from '../../src/sources/index.ts';
import { databaseUrlFor } from '../support/database.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { connectGitHub } from '../support/github-account.ts';
import { waitFor } from '../support/wait.ts';

const REPO = 'owner/hopper-sandbox';
const apps: TestApp[] = [];
let cleanup: (() => void) | undefined;

afterEach(async () => {
  for (const x of apps.splice(0)) await x.stop();
  cleanup?.();
});

const PLUGINS = { jobSources: [{ name: 'github', plugin: 'github-account', options: { enabled: true, pollSeconds: 3600, executor: 'scripted' } }] };

async function boot(gh: FakeGitHub, dbPath?: string): Promise<TestApp> {
  const db = dbPath ? { dbPath } : tempDbPath();
  if ('cleanup' in db) cleanup = db.cleanup;
  const app = await startTestApp({ dbPath: db.dbPath, env: {}, seams: { github: gh }, plugins: PLUGINS });
  apps.push(app);
  connectGitHub(app, [REPO]);
  return app;
}

async function hopper(app: TestApp, argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { env: { HOPPER_DATABASE_URL: databaseUrlFor(app.dbPath) }, stdin: () => '', out: (x) => out.push(x), err: (x) => err.push(x) };
  const code = await runCli([...argv, '--url', app.url], io);
  return { code, out: out.join(''), err: err.join('') };
}

const body = (op: Record<string, unknown>) => `${JSON.stringify(op)}\n\nPlease do the thing.`;
const jobFor = async (app: TestApp, url: string): Promise<Job> =>
  (await app.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs.find((j) => j.source?.key === url)!;
const failuresOf = async (app: TestApp): Promise<FailuresView> => (await app.api<FailuresView>('GET', '/api/failures')).body;
const backfilled = (es: DomainEvent[]) => es.filter((e) => (e.data.result as { backfill?: string } | undefined)?.backfill === 'done-check');

/** Three issues whose jobs ended done with nothing on GitHub: each fails `not complete:` and waits on a person. */
async function threeMisses(gh: FakeGitHub, app: TestApp) {
  const issues = [1, 2, 3].map(() => gh.createIssue({ repo: REPO, body: body({ op: 'echo' }), labels: ['hopper'] }));
  await app.sync();
  const jobs: Job[] = [];
  for (const issue of issues) {
    const job = await app.waitForStatus((await jobFor(app, issue.url)).id, 'failed');
    expect(job.error).toMatch(/^not complete:/);
    jobs.push(job);
  }
  await waitFor(async () => (await failuresOf(app)).handoffs.filter((h) => h.status === 'open').length === 3, { what: 'three hand-offs' });
  return { issues, jobs };
}

describe('the done-check backfill (issue #637)', () => {
  it('test 12 — closed by a merged pull request: finished, cleared, not reopened; a ready pull request: PR waiting; none: stays, with a plain sentence; two events; a second run changes nothing', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const { issues: [ia, ib, ic], jobs: [ja, jb, jc] } = await threeMisses(gh, app);
    const at = new Date().toISOString();
    gh.closeByPullRequest(REPO, ia!.number, { createdAt: at, mergedAt: at });
    const prB = gh.openPullRequest(REPO, ib!.number, { createdAt: at });
    const before = (await app.events()).length;

    const run = await hopper(app, ['backfill', 'done-check', '--json']);
    expect(run.code).toBe(0);
    const out = JSON.parse(run.out) as { backfill: string; changed: { jobId: string; state: string }[]; unchanged: number; failures: { jobId: string; reason: string }[] };
    expect(out.backfill).toBe('done-check');
    expect(out.changed.map((c) => [c.jobId, c.state]).sort()).toEqual([[ja!.id, 'finished'], [jb!.id, 'pr-waiting']].sort());
    expect(out.unchanged).toBe(1);
    expect(out.failures).toEqual([{ jobId: jc!.id, reason: expect.stringMatching(/^[A-Z].*\.$/) }]);

    expect((await app.job(ja!.id)).status).toBe('finished');
    expect((await app.job(jb!.id)).status).toBe('finished');
    expect((await app.job(jc!.id)).status).toBe('failed');
    const f = await failuresOf(app);
    expect(f.handoffs.filter((h) => h.status === 'open').map((h) => h.jobId)).toEqual([jc!.id]);
    expect(f.recent.filter((r) => r.jobId === ja!.id || r.jobId === jb!.id)).toEqual([]);
    expect([ja!, jb!].map((j) => app.user().store.failures.forJob(j.id)?.outcome)).toEqual(['resolved', 'resolved']);
    const since = (await app.events()).slice(before);
    expect(backfilled(since).map((e) => e.jobId).sort()).toEqual([ja!.id, jb!.id].sort());
    expect(since.filter((e) => e.jobId === ja!.id || e.jobId === jb!.id || e.jobId === jc!.id)).toHaveLength(2);

    // A stays closed and is not run again; B's pull request shows in the Pull requests list.
    await app.sync();
    await waitFor(() => gh.issue(REPO, ia!.number).labels.includes('hopper:done'), { what: 'A: hopper:done' });
    expect(gh.issue(REPO, ia!.number).state).toBe('closed');
    expect(gh.calls.some((c) => c.method === 'reopenIssue')).toBe(false);
    expect(await app.events('types=job.rerun')).toEqual([]);
    await waitFor(() => gh.issue(REPO, ib!.number).labels.includes('hopper:pr-ready'), { what: 'B: hopper:pr-ready' });
    const prs = (await app.api<PullRequestsView>('GET', '/api/pull-requests')).body;
    expect(prs.repos.flatMap((r) => r.pullRequests).map((p) => [p.jobId, p.pullRequest?.url])).toEqual([[jb!.id, prB.url]]);
    expect(gh.issue(REPO, ic!.number).labels).toContain('hopper:failed');

    // Idempotent: nothing changes, no event.
    const count = (await app.events()).length;
    const again = JSON.parse((await hopper(app, ['backfill', 'done-check', '--json'])).out) as typeof out;
    expect(again.changed).toEqual([]);
    expect(again.unchanged).toBe(1);
    expect((await app.events()).length).toBe(count);
  });

  it('runs once, at the first start of this build: a later start does not run it again', async () => {
    const gh = createFakeGitHub();
    const first = await boot(gh);
    const { issues: [ia], jobs: [ja] } = await threeMisses(gh, first);
    // As a store an earlier build left: the backfill never ran on it.
    first.user().store.settings.setBackfills({});
    await first.stop();
    apps.splice(0);
    const at = new Date().toISOString();
    gh.closeByPullRequest(REPO, ia!.number, { createdAt: at, mergedAt: at });

    const second = await boot(gh, first.dbPath);
    await second.waitForStatus(ja!.id, 'finished');
    expect(backfilled(await second.events('types=job.finished')).map((e) => e.jobId)).toEqual([ja!.id]);
    expect(second.user().store.settings.getBackfills()['done-check']).toEqual(expect.any(String));
  });
});
