// The merge marker (issue #1588): the hopper stops after its merge call went through and before it recorded the merge —
// yolo mode, or a person's Merge now. After the start the pull request reads as merged: it is the hopper's merge, so the
// issue of a pull request with no closing keyword is closed once, with one comment, and who merged it is recorded. Real
// daemon, real database; the in-memory fake GitHub at the GitHubApi seam, its merge's answer lost before the stop.
import { afterEach, describe, expect, it } from 'vitest';
import type { Job } from '../../src/domain/types.ts';
import { createFakeGitHub, type FakeGitHub } from '../../src/sources/index.ts';
import { GitHubApiError, type GitHubApi } from '../../src/sources/github/index.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { connectGitHub } from '../support/github-account.ts';
import { waitFor } from '../support/wait.ts';

const REPO = 'owner/hopper-sandbox';
const apps: TestApp[] = [];
let cleanup: (() => void) | undefined;

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  cleanup?.();
});

async function boot(dbPath: string, github: GitHubApi): Promise<TestApp> {
  const plugins = { jobSources: [{ name: 'github', plugin: 'github-account', options: { enabled: true, pollSeconds: 3600, executor: 'scripted' } }] };
  const a = await startTestApp({ dbPath, env: {}, seams: { github }, plugins });
  apps.push(a);
  connectGitHub(a, [REPO]);
  return a;
}

/** `gh` whose merge goes through on GitHub, and its answer is lost: the hopper stops before it records the merge. */
function mergeAnswerLost(gh: FakeGitHub): GitHubApi {
  return new Proxy(gh, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver) as unknown;
      if (prop !== 'merge') return v;
      return async (repo: string, n: number) => { await gh.merge(repo, n); throw new GitHubApiError('socket hang up', false); };
    },
  });
}

const jobFor = async (app: TestApp, url: string): Promise<Job> =>
  (await app.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs.find((j) => j.source?.key === url)!;

/** A finished job that follows an open pull request of its issue with no closing keyword, its checks passing. */
async function followed(gh: FakeGitHub, app: TestApp) {
  const issue = gh.createIssue({ repo: REPO, body: `${JSON.stringify({ op: 'echo' })}\n\nPlease do the thing.`, labels: ['hopper'] });
  let first = '';
  app.scripted.ships((job) => { if (job.source?.key === issue.url) first = gh.openPullRequest(REPO, issue.number, { createdAt: new Date().toISOString(), checks: 'pending' }).url; });
  await app.sync();
  const job = await app.waitForStatus((await jobFor(app, issue.url)).id, 'finished');
  await waitFor(() => gh.issue(REPO, issue.number).labels.includes('hopper:pr-ready'), { what: 'hopper:pr-ready' });
  // The job's pull request, as the follow names one that only mentions the issue.
  const refs = gh.openReferencingPullRequest(REPO, issue.number, { createdAt: new Date().toISOString(), checks: 'passing' });
  gh.closePullRequest(first);
  const kept = app.user().store.jobs.get(job.id)!.sourceState;
  app.user().store.jobs.update(job.id, { sourceState: { ...kept, source: { pullRequest: refs.url, follow: 'open' } } });
  return { issue, job, url: refs.url };
}

const merges = (gh: FakeGitHub) => gh.calls.filter((c) => c.method === 'merge');

/** After the start: the issue closed once as completed, with one comment that links the pull request, and done. */
async function closedOnce(gh: FakeGitHub, app: TestApp, number: number, url: string): Promise<void> {
  await waitFor(() => gh.issue(REPO, number).state === 'closed', { what: 'the issue closed after the start' });
  await app.sync();
  await waitFor(() => gh.issue(REPO, number).labels.includes('hopper:done'), { what: 'hopper:done' });
  expect(gh.issue(REPO, number)).toMatchObject({ state: 'closed', stateReason: 'completed' });
  expect(gh.commentsOn(REPO, number).map((c) => c.body)).toEqual([expect.stringContaining(url)]);
  expect(gh.calls.filter((c) => c.method === 'closeAsCompleted')).toHaveLength(1);
  expect(merges(gh)).toHaveLength(1);
}

describe('a stop between the hopper\'s merge and its record (issue #1588)', () => {
  it('yolo mode: after the start the issue is closed once, with one comment, and the merge is the hopper\'s', async () => {
    const db = tempDbPath();
    cleanup = db.cleanup;
    const gh = createFakeGitHub();
    const first = await boot(db.dbPath, mergeAnswerLost(gh));
    expect((await first.ui('/ui/api/yolo-mode', { repos: { [REPO]: true } }, { token: await first.login() })).status).toBe(200);
    const w = await followed(gh, first);
    void first.sync().catch(() => undefined);
    await waitFor(() => merges(gh).length === 1, { what: 'the merge call' });
    await first.stop();
    apps.splice(0);
    expect(gh.issue(REPO, w.issue.number).state).toBe('open');

    const second = await boot(db.dbPath, gh);
    await second.sync();
    await closedOnce(gh, second, w.issue.number, w.url);
    const merged = (await second.events('types=job.pull_request_merged')).filter((e) => e.jobId === w.job.id);
    expect(merged.map((e) => e.data)).toEqual([{ pullRequest: w.url, part: false, byHopper: true }]);
  });

  it('Merge now: after the start the issue is closed once, with one comment, and the merge is recorded as the person\'s act', async () => {
    const db = tempDbPath();
    cleanup = db.cleanup;
    const gh = createFakeGitHub();
    const first = await boot(db.dbPath, mergeAnswerLost(gh));
    const w = await followed(gh, first);
    expect((await first.ui('/ui/api/pull-requests/merge', { jobId: w.job.id }, { token: await first.login() })).status).toBe(202);
    await waitFor(() => merges(gh).length === 1, { what: 'the merge call' });
    await first.stop();
    apps.splice(0);

    const second = await boot(db.dbPath, gh);
    await second.sync();
    await closedOnce(gh, second, w.issue.number, w.url);
    const merged = (await second.events('types=job.pull_request_merged')).filter((e) => e.jobId === w.job.id);
    expect(merged.map((e) => e.data)).toEqual([{ pullRequest: w.url, part: false, person: expect.any(String), via: 'ui' }]);
    expect((await second.events('types=job.pull_request_act_failed')).filter((e) => e.jobId === w.job.id)).toEqual([]);
  });
});
