// The base merge in the tending queue (issue #967): a pull request with merge conflicts that the hopper's mirror merges
// with its base itself is not handed to a tend job: no job, no lane; it waits for its checks, and with yolo mode on the
// hopper merges it, and holds the pull requests that conflict with it meanwhile. A conflict the mirror does not resolve goes
// to a tend job, as before. Real daemon, in-memory fake GitHub at the GitHubApi seam (its git answers set by the test);
// issues carry a scripted-executor op as their first body line.
//
// Feature: the base merge
//   Scenario: a conflict the mirror resolves, yolo mode on
//     Then it is pushed with no tend job and no new job, waits for its checks, and is merged once they pass
//   Scenario: a conflict the mirror does not resolve
//     Then a tend job rebases it, as before
//   Scenario: two conflicting pull requests, yolo mode on, the first base merged
//     Then the second is held behind the first, which the hopper merges first
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

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

interface Waiting { issue: number; job: Job; url: string }

/** `count` issues, each a job that opens a ready pull request (the first the oldest), with `checks`; a tend pushes to it. */
async function waitingPullRequests(gh: FakeGitHub, app: TestApp, count: number, o: { checks?: 'passing' } = {}): Promise<Waiting[]> {
  const urls = new Map<string, string>();
  app.scripted.ships((j) => {
    const at = urls.get(j.source!.key);
    if (at === undefined) urls.set(j.source!.key, gh.openPullRequest(REPO, j.source!.number!, { createdAt: ago(10 * (count - j.source!.number! + 1)), ...(o.checks ? { checks: o.checks } : {}) }).url);
    else gh.pushToPullRequest(at, new Date().toISOString());
  });
  const issues = Array.from({ length: count }, () => gh.createIssue({ repo: REPO, body: `${JSON.stringify({ op: 'echo' })}\n\nPlease do the thing.`, labels: ['hopper'] }));
  await app.sync();
  const out: Waiting[] = [];
  for (const issue of issues) {
    const job = (await app.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs.find((j) => j.source?.key === issue.url)!;
    await app.waitForStatus(job.id, 'finished');
    await waitFor(() => gh.issue(REPO, issue.number).labels.includes('hopper:pr-ready'), { what: `hopper:pr-ready on #${issue.number}` });
    out.push({ issue: issue.number, job, url: urls.get(issue.url)! });
  }
  return out;
}

const tends = async (app: TestApp) => (await app.events('types=job.pull_request_tended')).map((e) => [e.jobId, (e.data as { step: string }).step]);

/** The tend job of `jobId` finished, and follows its pull request again. */
async function tendDone(app: TestApp, jobId: string): Promise<void> {
  const next = ((await app.events('types=job.pull_request_tended')).find((e) => e.jobId === jobId)!.data as { nextJobId: string }).nextJobId;
  await app.waitForStatus(next, 'finished');
  await waitFor(async () => ((await app.job(next)).sourceState?.source as { follow?: string } | undefined)?.follow === 'open', { what: 'the tend job follows its pull request' });
}

describe('the base merge (issue #967)', () => {
  const baseMerges = async (app: TestApp) => (await app.events('types=job.pull_request_base_merged')).map((e) => [e.jobId, e.data]);

  it('a conflict the mirror resolves is pushed with no tend job; with yolo mode on, the hopper merges it once its checks pass', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const token = await app.login();
    expect((await app.ui('/ui/api/yolo-mode', { repos: { [REPO]: true } }, { token })).status).toBe(200);
    const [only] = await waitingPullRequests(gh, app, 1, { checks: 'passing' });
    gh.setBaseMerge(only!.url, { resolved: ['WHATS-NEW.md'] });
    gh.setConflicting(only!.url, true);
    await app.sync();
    expect(await baseMerges(app)).toEqual([[only!.job.id, { pullRequest: only!.url, commit: expect.any(String), resolved: ['WHATS-NEW.md'] }]]);
    expect(await tends(app)).toEqual([]);
    const jobs = (await app.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs;
    expect(jobs).toHaveLength(1);
    const card = (await app.api<PullRequestsView>('GET', '/api/pull-requests')).body.repos.find((r) => r.repo === REPO)!.pullRequests[0]!;
    expect(card).toMatchObject({ mergeable: 'mergeable', checks: 'pending', waits: 'checks pending' });
    expect(card.queue).toBeUndefined();
    gh.setChecks(only!.url, 'passing');
    await app.sync();
    await waitFor(() => gh.issue(REPO, only!.issue).state === 'closed', { what: 'the pull request merged' });
  });

  it('a conflict the mirror does not resolve goes to a tend job, as before', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const [only] = await waitingPullRequests(gh, app, 1);
    gh.setBaseMerge(only!.url, { conflicts: ['src/main.ts'] });
    gh.setConflicting(only!.url, true);
    await app.sync();
    expect(await baseMerges(app)).toEqual([]);
    expect(await tends(app)).toEqual([[only!.job.id, 'rebase']]);
    await tendDone(app, only!.job.id);
  });

  it('a base merge with yolo mode on holds the pull requests that conflict with it; the others are merged or tended', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const token = await app.login();
    expect((await app.ui('/ui/api/yolo-mode', { repos: { [REPO]: true } }, { token })).status).toBe(200);
    const [first, second] = await waitingPullRequests(gh, app, 2, { checks: 'passing' });
    gh.setBaseMerge(first!.url, { resolved: ['docs/design.md'] });
    gh.setConflictBetween(first!.url, second!.url, true);
    gh.setConflicting(first!.url, true);
    gh.setConflicting(second!.url, true);
    await app.sync();
    expect((await baseMerges(app)).map(([id]) => id)).toEqual([first!.job.id]);
    expect(await tends(app)).toEqual([]);
    const cards = (await app.api<PullRequestsView>('GET', '/api/pull-requests')).body.repos.find((r) => r.repo === REPO)!.pullRequests;
    expect(cards.find((c) => c.jobId === second!.job.id)!.queue).toEqual({ held: { pullRequest: Number(first!.url.split('/').pop()), why: 'merging' } });
  });
});
