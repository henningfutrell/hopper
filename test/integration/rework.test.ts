// Rework (issue #724, design.md "Rework"): a person sends a done job's open pull request back with rework notes — from
// its card in Pull requests, the operator CLI or `POST /ui/api/jobs/:id/rework`. The pull request becomes a draft and
// stays open on its branch, the ended job stops following it, and a new job of the item is queued at once, told the notes
// and the pull request to rework. The new job is done only when it pushed to that pull request after the rework and marked
// it ready. Real daemon, real database, real CLI; the in-memory fake GitHub at the GitHubApi seam.
import { afterEach, describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../../src/cli.ts';
import type { Job, PullRequestsView } from '../../src/domain/types.ts';
import { createFakeGitHub, type FakeGitHub } from '../../src/sources/index.ts';
import { databaseUrlFor } from '../support/database.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { connectGitHub } from '../support/github-account.ts';
import { waitFor } from '../support/wait.ts';

const REPO = 'owner/hopper-sandbox';
let a: TestApp | undefined;
let cleanup: (() => void) | undefined;

afterEach(async () => {
  await a?.stop();
  a = undefined;
  cleanup?.();
});

async function boot(gh: FakeGitHub): Promise<TestApp> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  const plugins = { jobSources: [{ name: 'github', plugin: 'github-account', options: { enabled: true, pollSeconds: 3600, executor: 'scripted' } }] };
  a = await startTestApp({ dbPath: db.dbPath, env: {}, seams: { github: gh }, plugins });
  connectGitHub(a, [REPO]);
  return a;
}

async function hopper(app: TestApp, argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { env: { HOPPER_DATABASE_URL: databaseUrlFor(app.dbPath) }, stdin: () => '', out: (x) => out.push(x), err: (x) => err.push(x) };
  const code = await runCli([...argv, '--url', app.url], io);
  return { code, out: out.join(''), err: err.join('') };
}

const jobsFor = async (app: TestApp, url: string): Promise<Job[]> =>
  (await app.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs.filter((j) => j.source?.key === url);
const cardOf = async (app: TestApp, jobId: string) =>
  (await app.api<PullRequestsView>('GET', '/api/pull-requests')).body.repos.flatMap((r) => r.pullRequests).find((p) => p.jobId === jobId);
const NOTES = 'Rename the flag to --dry-run.\nAdd a test for the empty list.';

/**
 * A job that ends done with its pull request open and ready (PR waiting), yolo mode off; `rework` plays what each later
 * job of the issue does to that pull request before it ends done. Answers the issue, the job, the pull request's URL.
 */
async function waiting(gh: FakeGitHub, app: TestApp, rework: (url: string) => void) {
  const issue = gh.createIssue({ repo: REPO, body: `${JSON.stringify({ op: 'echo' })}\n\nPlease do the thing.`, labels: ['hopper'] });
  let url = '';
  app.scripted.ships((job) => {
    if (job.source?.key !== issue.url) return;
    if (url === '') url = gh.openPullRequest(REPO, issue.number, { createdAt: new Date().toISOString() }).url;
    else rework(url);
  });
  await app.sync();
  const job = await app.waitForStatus((await jobsFor(app, issue.url))[0]!.id, 'finished');
  await waitFor(() => gh.issue(REPO, issue.number).labels.includes('hopper:pr-ready'), { what: 'hopper:pr-ready' });
  await app.sync();
  await waitFor(async () => (await cardOf(app, job.id)) !== undefined, { what: 'the pull request card' });
  return { issue, job, url };
}

const pullOf = async (gh: FakeGitHub, url: string) => (await gh.pullRequest(REPO, Number(url.split('/').at(-1))))!;

describe('Rework: send a done job\'s pull request back (issue #724)', () => {
  it('from the UI: the pull request becomes a draft on its branch, the old job stops following it, a new job runs with the notes, and is done once it pushed and marked it ready', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const token = await app.login();
    const { issue, job, url } = await waiting(gh, app, (pr) => { gh.pushToPullRequest(pr, new Date().toISOString()); gh.markReady(pr); });

    const r = await app.ui<Job>(`/ui/api/jobs/${job.id}/rework`, { notes: NOTES }, { token });
    expect(r.status).toBe(200);
    // The answer is the new job, queued at once, linked to the job it reworks, told the notes and the pull request.
    expect(r.body).toMatchObject({ rerunOf: job.id, source: { key: issue.url }, rework: { pullRequest: url, notes: NOTES, via: 'ui' } });
    expect(String(r.body.spec.payload.prompt)).toContain(url);
    expect(String(r.body.spec.payload.prompt)).toContain('Rename the flag to --dry-run.');
    // The pull request stays open as a draft (not merged, not closed); the issue is no longer PR ready.
    expect(await pullOf(gh, url)).toMatchObject({ state: 'open', isDraft: true });
    expect(gh.issue(REPO, issue.number).labels).not.toContain('hopper:pr-ready');
    expect(gh.issue(REPO, issue.number).labels).toContain('hopper');
    // The ended job keeps its end, and no longer counts as a waiting pull request: never done while in rework.
    expect((await app.job(job.id)).status).toBe('finished');
    expect(await cardOf(app, job.id)).toBeUndefined();
    const asked = (await app.events('types=job.rework_requested')).filter((e) => e.jobId === job.id);
    expect(asked.map((e) => e.data)).toEqual([{ pullRequest: url, notes: NOTES, nextJobId: r.body.id, person: expect.any(String), via: 'ui' }]);

    // The new job pushes to the same pull request and marks it ready: done, and its pull request is followed again.
    const second = await app.waitForStatus(r.body.id, 'finished');
    expect(second.error).toBeUndefined();
    expect((await jobsFor(app, issue.url)).map((j) => j.id).sort()).toEqual([job.id, r.body.id].sort());
    expect(gh.calls.filter((c) => c.method === 'merge')).toEqual([]);
    await waitFor(() => gh.issue(REPO, issue.number).labels.includes('hopper:pr-ready'), { what: 'hopper:pr-ready again' });
    await app.sync();
    await waitFor(async () => (await cardOf(app, r.body.id))?.pullRequest?.url === url, { what: 'the reworked pull request card' });
  });

  it('a reworked pull request marked ready with no push since the rework is not done', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const token = await app.login();
    const { job, url } = await waiting(gh, app, (pr) => { gh.markReady(pr); });

    const r = await app.ui<Job>(`/ui/api/jobs/${job.id}/rework`, { notes: NOTES }, { token });
    expect(r.status).toBe(200);
    const second = await app.waitForStatus(r.body.id, 'failed');
    expect(second.error).toMatch(/sent back for rework/);
    expect(second.error).toContain(url.split('/').at(-1));
  });

  it('a reworked pull request left a draft gets the finish brief to mark it ready', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const token = await app.login();
    // The rework pushes, and forgets to mark it ready; the finish brief's run marks it ready.
    let runs = 0;
    const { job, url } = await waiting(gh, app, (pr) => { runs += 1; if (runs === 1) gh.pushToPullRequest(pr, new Date().toISOString()); else gh.markReady(pr); });

    const r = await app.ui<Job>(`/ui/api/jobs/${job.id}/rework`, { notes: NOTES }, { token });
    expect(r.status).toBe(200);
    await app.waitForStatus(r.body.id, 'finished');
    const briefed = (await app.events('types=job.finish_briefed')).filter((e) => e.jobId === r.body.id);
    expect(briefed.map((e) => e.data)).toEqual([{ pullRequest: url, step: 'mark_ready' }]);
  });

  it('from the operator CLI: the same rework, by way of cli; without notes, or for a job with no open pull request, it is refused', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const token = await app.login();
    const { job, url } = await waiting(gh, app, (pr) => { gh.pushToPullRequest(pr, new Date().toISOString()); gh.markReady(pr); });

    expect((await app.ui(`/ui/api/jobs/${job.id}/rework`, {}, { token })).status).toBe(400);
    expect((await app.ui(`/ui/api/jobs/${job.id}/rework`, { notes: '  ' }, { token })).status).toBe(400);
    const missing = await hopper(app, ['job', 'rework', job.id]);
    expect(missing.code).not.toBe(0);

    const done = await hopper(app, ['job', 'rework', job.id, '--notes', NOTES]);
    expect(done.code).toBe(0);
    const next = JSON.parse(done.out) as Job;
    expect(next).toMatchObject({ rerunOf: job.id, rework: { pullRequest: url, notes: NOTES, via: 'cli' } });
    expect(await pullOf(gh, url)).toMatchObject({ state: 'open', isDraft: true });

    // Only the newest job of an item, finished, with an open pull request it follows, is sent back.
    const again = await app.ui<{ error: string }>(`/ui/api/jobs/${job.id}/rework`, { notes: NOTES }, { token });
    expect(again.status).toBe(409);
    await app.waitForStatus(next.id, 'finished');
    gh.mergePullRequest(url);
    await app.sync();
    await waitFor(async () => (await app.events('types=job.pull_request_merged')).some((e) => e.jobId === next.id), { what: 'merged' });
    const merged = await app.ui<{ error: string }>(`/ui/api/jobs/${next.id}/rework`, { notes: NOTES }, { token });
    expect(merged.status).toBe(409);
    expect(merged.body.error).toMatch(/no open pull request/);
  });
});
