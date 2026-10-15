// The latency budget of Merge now and Close PR (issue #1194, part 5): with GitHub slow, each answers within the budget;
// the source merges or closes the pull request after the answer, and a GitHub refusal is recorded with why. Real daemon,
// real database; the fake GitHub, slowed at its seam.
import { afterEach, describe, expect, it } from 'vitest';
import type { Job, PullRequestsView } from '../../src/domain/types.ts';
import { createFakeGitHub, type FakeGitHub } from '../../src/sources/index.ts';
import { GitHubApiError } from '../../src/sources/github/index.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { connectGitHub } from '../support/github-account.ts';
import { BUDGET_MS, SLOW_MS } from '../support/latency.ts';
import { slowGitHub } from '../support/slow-github.ts';
import { waitFor } from '../support/wait.ts';

const REPO = 'owner/hopper-sandbox';
const apps: TestApp[] = [];
let cleanup: (() => void) | undefined;

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  cleanup?.();
});

async function timed<T>(act: () => Promise<T>): Promise<{ r: T; ms: number }> {
  const t0 = performance.now();
  const r = await act();
  return { r, ms: performance.now() - t0 };
}

/** A job that ends done with its pull request open, and the hopper following it; GitHub slowed from then on by `slow`. */
async function waiting() {
  const gh = createFakeGitHub();
  const slow = slowGitHub(gh);
  const db = tempDbPath();
  cleanup = db.cleanup;
  const plugins = { jobSources: [{ name: 'github', plugin: 'github-account', options: { enabled: true, pollSeconds: 3600, executor: 'scripted' } }] };
  const a = await startTestApp({ dbPath: db.dbPath, env: {}, seams: { github: slow.api }, plugins });
  apps.push(a);
  connectGitHub(a, [REPO]);
  const token = await a.login();
  const issue = gh.createIssue({ repo: REPO, body: '{"op":"echo"}\n\nFix the typo.', labels: ['hopper'] });
  let url = '';
  a.scripted.ships((j) => { if (j.source?.key === issue.url) url = gh.openPullRequest(REPO, issue.number, { createdAt: new Date().toISOString(), checks: 'pending' }).url; });
  await a.sync();
  const [job] = (await a.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs.filter((j) => j.source?.key === issue.url);
  await a.waitForStatus(job!.id, 'finished');
  await waitFor(() => gh.issue(REPO, issue.number).labels.includes('hopper:pr-ready'), { what: 'hopper:pr-ready' });
  return { a, gh, slow, token, issue, job: job!, url };
}

const cardOf = async (a: TestApp, jobId: string) =>
  (await a.api<PullRequestsView>('GET', '/api/pull-requests')).body.repos.flatMap((r) => r.pullRequests).find((p) => p.jobId === jobId);
const mergesOf = (gh: FakeGitHub) => gh.calls.filter((c) => c.method === 'merge');

describe('Merge now and Close PR answer within the budget, GitHub slow (issue #1194)', () => {
  it('Merge now: answered at once; a second click answers the same; the merge follows, with who pressed it', { timeout: 30_000 }, async () => {
    const { a, gh, slow, token, issue, job, url } = await waiting();
    slow.delay.ms = SLOW_MS;
    const { r, ms } = await timed(() => a.ui('/ui/api/pull-requests/merge', { jobId: job.id }, { token }));
    expect(r).toMatchObject({ status: 202, body: { jobId: job.id, act: 'merge' } });
    expect(ms).toBeLessThan(BUDGET_MS);
    const again = await timed(() => a.ui('/ui/api/pull-requests/merge', { jobId: job.id }, { token }));
    expect(again.r).toMatchObject({ status: 202, body: { jobId: job.id, act: 'merge' } });
    expect(again.ms).toBeLessThan(BUDGET_MS);
    slow.delay.ms = 0;
    const merged = await waitFor(async () => (await a.events('types=job.pull_request_merged')).find((e) => e.jobId === job.id), { what: 'merged', timeoutMs: 10_000 });
    expect(merged.data).toEqual({ pullRequest: url, part: false, person: expect.any(String), via: 'ui' });
    expect(mergesOf(gh)).toHaveLength(1);
    expect(gh.issue(REPO, issue.number).state).toBe('closed');
    expect(await cardOf(a, job.id)).toBeUndefined();
  });

  it('Merge now that GitHub refuses after the answer: recorded with why, and the card stays', { timeout: 30_000 }, async () => {
    const { a, gh, slow, token, issue, job } = await waiting();
    gh.failNext('merge', new GitHubApiError('Pull Request is not mergeable (HTTP 405)', true, 405));
    slow.delay.ms = SLOW_MS;
    const { r, ms } = await timed(() => a.ui('/ui/api/pull-requests/merge', { jobId: job.id }, { token }));
    expect(r.status).toBe(202);
    expect(ms).toBeLessThan(BUDGET_MS);
    slow.delay.ms = 0;
    const failed = await waitFor(async () => (await a.events('types=job.pull_request_act_failed'))[0], { what: 'the act failed', timeoutMs: 10_000 });
    expect(failed).toMatchObject({ jobId: job.id, data: { act: 'merge', error: expect.stringContaining('not mergeable'), person: expect.any(String), via: 'ui' } });
    expect(gh.issue(REPO, issue.number).state).toBe('open');
    expect(await cardOf(a, job.id)).toMatchObject({ state: 'open' });
    expect(await a.events('types=job.pull_request_merged')).toEqual([]);
  });

  it('Close PR: answered at once; the close follows', { timeout: 30_000 }, async () => {
    const { a, gh, slow, token, issue, job, url } = await waiting();
    slow.delay.ms = SLOW_MS;
    const { r, ms } = await timed(() => a.ui('/ui/api/pull-requests/close', { jobId: job.id }, { token }));
    expect(r).toMatchObject({ status: 202, body: { jobId: job.id, act: 'close' } });
    expect(ms).toBeLessThan(BUDGET_MS);
    slow.delay.ms = 0;
    const closed = await waitFor(async () => (await a.events('types=job.pull_request_closed')).find((e) => e.jobId === job.id), { what: 'closed', timeoutMs: 10_000 });
    expect(closed.data).toEqual({ pullRequest: url, part: false, person: expect.any(String), via: 'ui' });
    expect(gh.issue(REPO, issue.number).labels).toContain('hopper:pr-closed');
  });
});
