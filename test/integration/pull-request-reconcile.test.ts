// Reconciling the Pull requests list with GitHub (issue #763): a done job that follows no pull request — it ended before
// the hopper followed one, or its follow ended — and whose item has an open pull request on GitHub follows that pull
// request from the next sync on. It shows on the Pull requests list, and is followed and tended as a job's own is: yolo
// mode merges it once it is ready. An open pull request of an issue that is closed is not followed. Real daemon, real
// database; the in-memory fake GitHub at the GitHubApi seam.
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
const now = () => new Date().toISOString();
const jobFor = async (app: TestApp, url: string): Promise<Job> =>
  (await app.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs.find((j) => j.source?.key === url)!;
const cardOf = async (app: TestApp, jobId: string) =>
  (await app.api<PullRequestsView>('GET', '/api/pull-requests')).body.repos.flatMap((r) => r.pullRequests).find((p) => p.jobId === jobId);
const followOf = async (app: TestApp, id: string) => (await app.job(id)).sourceState?.source as { follow?: string; pullRequest?: string; part?: boolean } | undefined;

/**
 * A job that ends done with its pull request open, as `open` opens it; then its source state is set back to one that
 * follows nothing, as a job that ended before the hopper followed pull requests has it. Answers the job and the URL.
 */
async function doneNotFollowing(gh: FakeGitHub, app: TestApp, open: (n: number) => string) {
  const issue = gh.createIssue({ repo: REPO, body: body({ op: 'echo' }), labels: ['hopper'] });
  let url = '';
  app.scripted.ships((job) => { if (job.source?.key === issue.url) url = open(issue.number); });
  await app.sync();
  const job = await app.waitForStatus((await jobFor(app, issue.url)).id, 'finished');
  await waitFor(async () => (await followOf(app, job.id))?.follow === 'open', { what: 'the job follows its pull request' });
  const sync = (await app.job(job.id)).sourceState?.sync;
  app.user().store.jobs.update(job.id, { sourceState: { sync, source: {} } });
  expect(await cardOf(app, job.id)).toBeUndefined();
  return { issue, job, url };
}

describe('reconciling open pull requests with GitHub (issue #763)', () => {
  it('a done job that follows no pull request follows its item\'s open one: it shows on the list, and yolo mode merges it', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const { issue, job, url } = await doneNotFollowing(gh, app, (n) => gh.openPullRequest(REPO, n, { createdAt: now(), checks: 'pending' }).url);
    await app.sync();
    await waitFor(async () => (await followOf(app, job.id))?.follow === 'open', { what: 'followed again' });
    expect(await followOf(app, job.id)).toMatchObject({ follow: 'open', pullRequest: url });
    expect((await app.events('types=job.pull_request_followed')).map((e) => [e.jobId, e.data])).toEqual([[job.id, { pullRequest: url, part: false }]]);
    expect(await cardOf(app, job.id)).toMatchObject({ state: 'open', pullRequest: { url } });

    const token = await app.login();
    expect((await app.ui('/ui/api/yolo-mode', { repos: { [REPO]: true } }, { token })).status).toBe(200);
    gh.setChecks(url, 'passing');
    await app.sync();
    await waitFor(() => gh.issue(REPO, issue.number).state === 'closed', { what: 'the hopper merged it' });
  });

  it('one named for the issue only on its branch, and a part: each is followed, the part as a part', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const branch = await doneNotFollowing(gh, app, (n) => gh.openUnlinkedPullRequest(REPO, { createdAt: now(), headRef: `issue-${n}-thing` }).url);
    const part = await doneNotFollowing(gh, app, (n) => gh.openPartPullRequest(REPO, n, { createdAt: now() }).url);
    await app.sync();
    await waitFor(async () => (await followOf(app, part.job.id))?.follow === 'open', { what: 'the part followed' });
    expect(await followOf(app, branch.job.id)).toMatchObject({ follow: 'open', pullRequest: branch.url });
    expect(await followOf(app, part.job.id)).toMatchObject({ follow: 'open', pullRequest: part.url, part: true });
  });

  it('an open pull request of a closed issue is not followed, and a job that follows its own is left as it is', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const closed = await doneNotFollowing(gh, app, (n) => gh.openPullRequest(REPO, n, { createdAt: now() }).url);
    gh.closeIssue(REPO, closed.issue.number, 'owner', { at: now() });
    const issue = gh.createIssue({ repo: REPO, body: body({ op: 'echo' }), labels: ['hopper'] });
    app.scripted.ships((j) => { if (j.source?.key === issue.url) gh.openPullRequest(REPO, issue.number, { createdAt: now() }); });
    await app.sync();
    const own = await app.waitForStatus((await jobFor(app, issue.url)).id, 'finished');
    await waitFor(async () => (await followOf(app, own.id))?.follow === 'open', { what: 'the job follows its own pull request' });
    await app.sync();
    await app.sync();
    expect((await followOf(app, closed.job.id))?.follow).toBeUndefined();
    expect(await app.events('types=job.pull_request_followed')).toEqual([]);
  });
});
