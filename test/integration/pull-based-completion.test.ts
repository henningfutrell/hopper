// Pull-based completion (issue #428): a done job's item is resolved upstream, and the hopper only follows. Its issue
// closed as completed — by a person — ends the follow merged: `hopper:done`, recorded, and the hopper merges nothing. A
// pull request still open is followed to its end first (issue #927): no re-follow at each sync. Closed as not planned ends it abandoned: never merged, even with yolo mode on and its
// checks passing; `hopper:pr-ready` comes off, no end label goes on, `job.pull_request_abandoned` is recorded once, and its
// card drops off the Pull requests list. Real daemon, real database; the in-memory fake GitHub at the GitHubApi seam.
import { afterEach, describe, expect, it } from 'vitest';
import type { Job, PullRequestsView } from '../../src/domain/types.ts';
import { createFakeGitHub, type FakeGitHub } from '../../src/sources/index.ts';
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

const body = (op: Record<string, unknown>) => `${JSON.stringify(op)}\n\nPlease do the thing.`;
const jobFor = async (app: TestApp, url: string): Promise<Job> =>
  (await app.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs.find((j) => j.source?.key === url)!;
const cardOf = async (app: TestApp, jobId: string) =>
  (await app.api<PullRequestsView>('GET', '/api/pull-requests')).body.repos.flatMap((r) => r.pullRequests).find((p) => p.jobId === jobId);
const merges = (gh: FakeGitHub) => gh.calls.filter((c) => c.method === 'merge');
const now = () => new Date().toISOString();

/** A job that ends done with its pull request open, ready, its checks passing: the job, finished, and the URL. */
async function waiting(gh: FakeGitHub, app: TestApp) {
  const issue = gh.createIssue({ repo: REPO, body: body({ op: 'echo' }), labels: ['hopper'] });
  let url = '';
  app.scripted.ships((job) => { if (job.source?.key === issue.url) url = gh.openPullRequest(REPO, issue.number, { createdAt: now(), checks: 'passing' }).url; });
  await app.sync();
  const job = await app.waitForStatus((await jobFor(app, issue.url)).id, 'finished');
  await waitFor(() => gh.issue(REPO, issue.number).labels.includes('hopper:pr-ready'), { what: 'hopper:pr-ready' });
  return { issue, job, url };
}

describe('pull-based completion (issue #428)', () => {
  it('closed as completed upstream, its pull request still open: followed to its end (issue #927); once that ends unmerged, merged and hopper:done, the hopper merges nothing', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const token = await app.login();
    expect((await app.ui('/ui/api/yolo-mode', { repos: { [REPO]: false } }, { token })).status).toBe(200);
    const { issue, job, url } = await waiting(gh, app);
    gh.closeIssue(REPO, issue.number, 'owner', { at: now(), reason: 'completed' });
    await app.sync();
    await app.sync();
    expect(await app.events('types=job.pull_request_merged')).toEqual([]);
    expect(await app.events('types=job.pull_request_followed')).toEqual([]);
    expect(await cardOf(app, job.id)).toMatchObject({ state: 'open', pullRequest: { url } });

    gh.closePullRequest(url);
    await app.sync();
    await waitFor(() => gh.issue(REPO, issue.number).labels.includes('hopper:done'), { what: 'hopper:done' });
    expect(gh.issue(REPO, issue.number).labels).not.toContain('hopper:pr-ready');
    expect((await app.events('types=job.pull_request_merged')).map((e) => [e.jobId, e.data])).toEqual([[job.id, { pullRequest: url, part: false }]]);
    expect(merges(gh)).toEqual([]);
    expect((await app.job(job.id)).status).toBe('finished');
  });

  it('closed as not planned upstream: abandoned at the next sync — never merged, even with yolo mode on; no end label; recorded once', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const token = await app.login();
    expect((await app.ui('/ui/api/yolo-mode', { repos: { [REPO]: false } }, { token })).status).toBe(200);
    const { issue, job, url } = await waiting(gh, app);
    expect(await cardOf(app, job.id)).toBeDefined();
    gh.closeIssue(REPO, issue.number, 'owner', { at: now(), reason: 'not_planned' });
    expect((await app.ui('/ui/api/yolo-mode', { repos: { [REPO]: true } }, { token })).status).toBe(200);
    await app.sync();
    const abandoned = await waitFor(async () => (await app.events('types=job.pull_request_abandoned')).find((e) => e.jobId === job.id), { what: 'job.pull_request_abandoned' });
    expect(abandoned.data).toEqual({ pullRequest: url, part: false });
    expect(merges(gh)).toEqual([]);
    const labels = gh.issue(REPO, issue.number).labels;
    expect(labels).not.toContain('hopper:pr-ready');
    expect(labels).not.toContain('hopper:done');
    expect(labels).not.toContain('hopper:pr-closed');
    expect((await app.job(job.id)).sourceState?.source).toMatchObject({ follow: 'abandoned', pullRequest: url });
    expect(await cardOf(app, job.id)).toBeUndefined();
    await app.sync();
    expect(await app.events('types=job.pull_request_abandoned')).toHaveLength(1);
    expect(merges(gh)).toEqual([]);
  });
});
