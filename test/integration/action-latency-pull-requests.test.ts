// The latency budget of Merge now and Close PR (issue #1194, part 5): while GitHub holds every call, each answers;
// the source merges or closes the pull request after the answer, and a GitHub refusal is recorded with why. Real daemon,
// real database; the fake GitHub, held at its seam. The answer's time is asserted off CI only (`test/support/latency.ts`).
import { afterEach, describe, expect, it } from 'vitest';
import type { AfterAnswerTiming, Job, PullRequestsView } from '../../src/domain/types.ts';
import { createFakeGitHub, type FakeGitHub } from '../../src/sources/index.ts';
import { GitHubApiError } from '../../src/sources/github/index.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { connectGitHub } from '../support/github-account.ts';
import { withinBudget } from '../support/latency.ts';
import { slowGitHub } from '../support/slow-github.ts';
import { waitFor } from '../support/wait.ts';

const REPO = 'owner/hopper-sandbox';
/** How long GitHub holds the merge after the answers. */
const HELD_MS = 300;
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
    slow.hold();
    const { r, ms } = await timed(() => a.ui('/ui/api/pull-requests/merge', { jobId: job.id }, { token }));
    expect(r).toMatchObject({ status: 202, body: { jobId: job.id, act: 'merge' } });
    withinBudget(ms);
    const again = await timed(() => a.ui('/ui/api/pull-requests/merge', { jobId: job.id }, { token }));
    expect(again.r).toMatchObject({ status: 202, body: { jobId: job.id, act: 'merge' } });
    withinBudget(again.ms);
    // GitHub still holds the merge: the answers came first, and nothing is merged yet.
    expect(mergesOf(gh)).toHaveLength(0);
    expect(await a.events('types=job.pull_request_merged')).toHaveLength(0);
    await new Promise((r) => setTimeout(r, HELD_MS));
    slow.release();
    const merged = await waitFor(async () => (await a.events('types=job.pull_request_merged')).find((e) => e.jobId === job.id), { what: 'merged', timeoutMs: 10_000 });
    expect(merged.data).toEqual({ pullRequest: url, part: false, person: expect.any(String), via: 'ui' });
    expect(mergesOf(gh)).toHaveLength(1);
    expect(gh.issue(REPO, issue.number).state).toBe('closed');
    expect(await cardOf(a, job.id)).toBeUndefined();
    // The merge's wait on the job's report chain and its run: together at least as long as GitHub held it.
    const timing = (await a.api<{ afterAnswer: AfterAnswerTiming[] }>('GET', '/api/sources')).body.afterAnswer.find((t) => t.act === 'merge');
    expect(timing).toMatchObject({ count: 1 });
    expect(timing!.waitMs.max + timing!.runMs.max).toBeGreaterThanOrEqual(HELD_MS - 1);
  });

  it('Merge now that GitHub refuses after the answer: recorded with why, and the card stays', { timeout: 30_000 }, async () => {
    const { a, gh, slow, token, issue, job } = await waiting();
    gh.failNext('merge', new GitHubApiError('Pull Request is not mergeable (HTTP 405)', true, 405));
    slow.hold();
    const { r, ms } = await timed(() => a.ui('/ui/api/pull-requests/merge', { jobId: job.id }, { token }));
    expect(r.status).toBe(202);
    withinBudget(ms);
    slow.release();
    const failed = await waitFor(async () => (await a.events('types=job.pull_request_act_failed'))[0], { what: 'the act failed', timeoutMs: 10_000 });
    expect(failed).toMatchObject({ jobId: job.id, data: { act: 'merge', error: expect.stringContaining('not mergeable'), person: expect.any(String), via: 'ui' } });
    expect(gh.issue(REPO, issue.number).state).toBe('open');
    expect(await cardOf(a, job.id)).toMatchObject({ state: 'open' });
    expect(await a.events('types=job.pull_request_merged')).toEqual([]);
  });

  it('Close PR: answered at once; the close follows', { timeout: 30_000 }, async () => {
    const { a, gh, slow, token, issue, job, url } = await waiting();
    slow.hold();
    const { r, ms } = await timed(() => a.ui('/ui/api/pull-requests/close', { jobId: job.id }, { token }));
    expect(r).toMatchObject({ status: 202, body: { jobId: job.id, act: 'close' } });
    withinBudget(ms);
    slow.release();
    const closed = await waitFor(async () => (await a.events('types=job.pull_request_closed')).find((e) => e.jobId === job.id), { what: 'closed', timeoutMs: 10_000 });
    expect(closed.data).toEqual({ pullRequest: url, part: false, person: expect.any(String), via: 'ui' });
    expect(gh.issue(REPO, issue.number).labels).toContain('hopper:pr-closed');
  });
});
