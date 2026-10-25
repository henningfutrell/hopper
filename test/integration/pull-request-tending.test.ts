// Tending a waiting pull request (issue #736): a PR waiting job's pull request that gets merge conflicts with its base, or
// failing checks, is not left for a person. The hopper runs its item again with the tend brief, and the new job brings the
// same pull request back to ready. A job that cannot is handed to a person with why. A done job's own pull request with
// failing checks is not done. Real daemon, in-memory fake GitHub at the GitHubApi seam; issues carry a scripted-executor
// op as their first body line.
import { afterEach, describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../../src/cli.ts';
import { MAX_TENDS, TEND_RETRY_MS, tendBrief, type FailuresView, type Job, type PullRequestCard, type PullRequestsView } from '../../src/domain/types.ts';
import { createFakeGitHub, type FakeGitHub } from '../../src/sources/index.ts';
import { GitHubApiError } from '../../src/sources/github/index.ts';
import { databaseUrlFor } from '../support/database.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { connectGitHub } from '../support/github-account.ts';
import { tendAgain } from '../support/give-back.ts';
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
const jobsFor = async (app: TestApp, url: string): Promise<Job[]> =>
  (await app.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs.filter((j) => j.source?.key === url)
    .sort((x, y) => x.createdAt.localeCompare(y.createdAt) || x.id.localeCompare(y.id));
const nextJob = (app: TestApp, url: string, count: number) =>
  waitFor(async () => { const j = await jobsFor(app, url); return j.length === count ? j.at(-1) : undefined; }, { what: `job ${count} of the item` });

/**
 * A job that opens a ready pull request, then — each later run — does `tend` to it. The pull request's URL once opened.
 */
async function pullRequestWaiting(gh: FakeGitHub, app: TestApp, tend: (url: string) => void) {
  const issue = gh.createIssue({ repo: REPO, body: body({ op: 'echo' }), labels: ['hopper'] });
  let url: string | undefined;
  app.scripted.ships((j) => {
    if (url === undefined) url = gh.openPullRequest(REPO, j.source!.number!, { createdAt: new Date().toISOString() }).url;
    else tend(url);
  });
  await app.sync();
  const [job] = await jobsFor(app, issue.url);
  await app.waitForStatus(job!.id, 'finished');
  await waitFor(() => gh.issue(REPO, issue.number).labels.includes('hopper:pr-ready'), { what: 'hopper:pr-ready' });
  return { issue, job: job!, url: url! };
}

describe('tending a waiting pull request (issue #736)', () => {
  it('merge conflicts with its base: the item runs again with the tend brief, the job rebases the same pull request, and it waits again', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const { issue, job, url } = await pullRequestWaiting(gh, app, (pr) => gh.pushToPullRequest(pr, new Date().toISOString()));
    gh.setConflicting(url, true);
    await app.sync();
    const tender = await nextJob(app, issue.url, 2);
    expect(tender!.rerunOf).toBe(job.id);
    // A tend job (issue #967): it may elbow in past a lane cap; the job it tends was none.
    expect(tender!.spec.tend).toBe(true);
    expect(job.spec.tend).toBeUndefined();
    const finished = await app.waitForStatus(tender!.id, 'finished');
    expect(String(app.scripted.payloads.at(-1)!.prompt)).toContain(tendBrief(url, 'rebase'));
    expect((await app.events('types=job.pull_request_tended')).map((e) => [e.jobId, e.data])).toEqual([[job.id, { pullRequest: url, step: 'rebase', nextJobId: tender!.id }]]);
    expect((await app.events('types=job.rerun')).map((e) => [e.jobId, e.data])).toEqual([[job.id, { by: 'tending', nextJobId: tender!.id }]]);
    expect(finished.status).toBe('finished');
    await waitFor(() => gh.issue(REPO, issue.number).labels.includes('hopper:pr-ready'), { what: 'hopper:pr-ready again' });
    // The tended job follows no more; the new one follows the same pull request.
    await app.sync();
    await app.sync();
    expect(await jobsFor(app, issue.url)).toHaveLength(2);
    expect((await app.job(job.id)).sourceState?.source).toMatchObject({ follow: 'tended' });
    expect((await app.job(tender!.id)).sourceState?.source).toMatchObject({ follow: 'open', pullRequest: url });
    expect(await app.events('types=job.failed')).toEqual([]);
  });

  it('failing checks: the item runs again told to fix them, and the job finishes once they pass', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const { issue, job, url } = await pullRequestWaiting(gh, app, (pr) => { gh.pushToPullRequest(pr, new Date().toISOString()); gh.setChecks(pr, 'passing'); });
    const failed = [{ name: 'test (1)', url: `${url}/checks`, reported: ['test/a.test.ts:4: AssertionError: expected 1 to be 2'] }];
    gh.setChecks(url, 'failing', failed);
    await app.sync();
    const tender = await nextJob(app, issue.url, 2);
    await app.waitForStatus(tender!.id, 'finished');
    // Issue #927: the brief names the checks that failed and quotes what they reported, and the first fix may run a flaky one again once.
    expect(String(app.scripted.payloads.at(-1)!.prompt)).toContain(tendBrief(url, 'fix_checks', { failed, rerun: true }));
    expect((await app.events('types=job.pull_request_tended')).map((e) => [e.jobId, e.data])).toEqual([[job.id, { pullRequest: url, step: 'fix_checks', nextJobId: tender!.id }]]);
  });

  it('a check that fails with an uncaught error: the hopper reads its log, and the tend brief carries the error; no question is asked (issue #993)', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const { issue, url } = await pullRequestWaiting(gh, app, (pr) => { gh.pushToPullRequest(pr, new Date().toISOString()); gh.setChecks(pr, 'passing'); });
    gh.setJobLog(REPO, 42, [' Test Files  120 passed (120)', 'Error: the store is closed', ' ❯ Store.read src/store/db.ts:40:11', '', '     Errors  1 error',
      '##[error]Process completed with exit code 1.'].map((l) => `2026-10-13T10:00:02.0000000Z ${l}`).join('\n'));
    // No annotation: an uncaught error names no test and no file.
    gh.setChecks(url, 'failing', [{ name: 'test (6)', url: `https://github.com/${REPO}/actions/runs/18/job/42` }]);
    await app.sync();
    const tender = await nextJob(app, issue.url, 2);
    await app.waitForStatus(tender!.id, 'finished');
    const prompt = String(app.scripted.payloads.at(-1)!.prompt);
    expect(prompt).toContain('  > Error: the store is closed\n  > ❯ Store.read src/store/db.ts:40:11');
    expect(prompt).toContain(`  The full log: sh "$HOPPER_GH" check log 42 --repo ${REPO}`);
    expect(prompt).not.toContain('Process completed');
    expect(gh.calls.filter((c) => c.method === 'jobLog')).toEqual([{ method: 'jobLog', args: [REPO, 42] }]);
    expect(await app.events('types=question.asked')).toEqual([]);
  });

  it('a check log GitHub refuses: the tend brief says why, so only then may the job ask a person for it (issue #993)', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const { issue, url } = await pullRequestWaiting(gh, app, (pr) => { gh.pushToPullRequest(pr, new Date().toISOString()); gh.setChecks(pr, 'passing'); });
    gh.setJobLog(REPO, 42, new GitHubApiError('Resource not accessible by integration', true, 403));
    gh.setChecks(url, 'failing', [{ name: 'test (6)', url: `https://github.com/${REPO}/actions/runs/18/job/42` }]);
    await app.sync();
    const tender = await nextJob(app, issue.url, 2);
    await app.waitForStatus(tender!.id, 'finished');
    expect(String(app.scripted.payloads.at(-1)!.prompt)).toContain(
      '  The hopper could not read its log: GitHub refused it (403: Resource not accessible by integration): the hopper\'s GitHub connection may not read Actions logs.');
  });

  it('a job that cannot resolve the conflicts ends failed, saying why, and waits on a person', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const { issue, url } = await pullRequestWaiting(gh, app, () => undefined);
    gh.setConflicting(url, true);
    await app.sync();
    const tender = await nextJob(app, issue.url, 2);
    const failed = await app.waitForStatus(tender!.id, 'failed');
    expect(failed.error).toMatch(/^not complete: .*merge conflicts/);
    const failures = async () => (await app.api<FailuresView>('GET', '/api/failures')).body;
    await waitFor(async () => (await failures()).handoffs.some((h) => h.jobId === tender!.id && h.status === 'open'), { what: 'handed off' });
    await app.sync();
    expect(await jobsFor(app, issue.url)).toHaveLength(2);
  });

  it('a rebase is never capped (issue #786): the base moves again after each, and each time the item runs again', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const { issue, url } = await pullRequestWaiting(gh, app, (pr) => gh.pushToPullRequest(pr, new Date().toISOString()));
    const rebases = MAX_TENDS + 2;
    for (let n = 2; n <= rebases + 1; n++) {
      gh.setConflicting(url, true);
      await app.sync();
      const tender = await nextJob(app, issue.url, n);
      await app.waitForStatus(tender!.id, 'finished');
      await waitFor(async () => ((await app.job(tender!.id)).sourceState?.source as { follow?: string } | undefined)?.follow === 'open', { what: 'following again' });
    }
    expect(await app.events('types=job.pull_request_tended')).toHaveLength(rebases);
  });

  it(`at most ${MAX_TENDS} fix_checks tends in a row of the same pull request; then it waits on a person`, async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const { issue, url } = await pullRequestWaiting(gh, app, (pr) => { gh.pushToPullRequest(pr, new Date().toISOString()); gh.setChecks(pr, 'passing'); });
    for (let n = 2; n <= MAX_TENDS + 1; n++) {
      gh.setChecks(url, 'failing');
      await app.sync();
      const tender = await nextJob(app, issue.url, n);
      await app.waitForStatus(tender!.id, 'finished');
      // Issue #927: only the first fix of the row may run the checks again; the later ones fix the cause.
      expect(String(app.scripted.payloads.at(-1)!.prompt)).toContain(tendBrief(url, 'fix_checks', { rerun: n === 2 }));
      await waitFor(async () => ((await app.job(tender!.id)).sourceState?.source as { follow?: string } | undefined)?.follow === 'open', { what: 'following again' });
    }
    gh.setChecks(url, 'failing');
    await app.sync();
    await app.sync();
    expect(await jobsFor(app, issue.url)).toHaveLength(MAX_TENDS + 1);
    expect(await app.events('types=job.pull_request_tended')).toHaveLength(MAX_TENDS);
  });
});

describe('a tend job cancelled by no person (issue #1010)', () => {
  it('is no reason to give up: after a wait, the same step runs again, and a person\'s cancel is', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    // Each run takes a moment, so its tend job can be cancelled while it runs.
    const issue = gh.createIssue({ repo: REPO, body: body({ op: 'echo', ms: 1500 }), labels: ['hopper'] });
    let url: string | undefined;
    app.scripted.ships((j) => { url ??= gh.openPullRequest(REPO, j.source!.number!, { createdAt: new Date().toISOString() }).url; });
    await app.sync();
    const [job] = await jobsFor(app, issue.url);
    await app.waitForStatus(job!.id, 'finished');
    await waitFor(() => gh.issue(REPO, issue.number).labels.includes('hopper:pr-ready'), { what: 'hopper:pr-ready' });
    const { store, engine } = app.user();
    const cancelled = async (id: string, reason: string) => {
      await app.waitForStatus(id, 'running');
      engine.cancel(id, reason);
      await app.waitForStatus(id, 'cancelled');
      await waitFor(async () => (await app.job(id)).sourceState?.sync?.finalReported === true, { what: 'its cancel reported' });
    };

    gh.setConflicting(url!, true);
    await app.sync();
    const first = await nextJob(app, issue.url, 2);
    await cancelled(first!.id, 'reaped by the sweep');
    // Not at once: it waits first.
    await app.sync();
    // Its pull request still waits: the issue says so, and is not taken again as a new job.
    expect(gh.issue(REPO, issue.number).labels).toContain('hopper:pr-ready');
    expect(await jobsFor(app, issue.url)).toHaveLength(2);

    // The wait is over: the item runs again, a tend job, with the same step, and the card waits on it.
    store.jobs.update(first!.id, { finishedAt: new Date(Date.now() - TEND_RETRY_MS - 1000).toISOString() });
    await app.sync();
    const second = await nextJob(app, issue.url, 3);
    expect(second).toMatchObject({ rerunOf: first!.id, spec: expect.objectContaining({ tend: true }) });
    expect(String(second!.spec.payload.prompt)).toContain(tendBrief(url!, 'rebase'));
    expect((await app.job(job!.id)).sourceState?.source).toMatchObject({ follow: 'tended', tended: { pullRequest: url, step: 'rebase', nextJobId: second!.id, retries: 1 } });

    // A person's cancel: the hopper tends it no more, and its issue is left as any cancelled job's.
    await cancelled(second!.id, 'cancelled in UI');
    expect(gh.issue(REPO, issue.number).labels).not.toContain('hopper:pr-ready');
    store.jobs.update(second!.id, { finishedAt: new Date(Date.now() - 24 * 3_600_000).toISOString() });
    await app.sync();
    expect((await jobsFor(app, issue.url)).filter((j) => j.spec.tend)).toHaveLength(2);
    expect(await app.events('types=job.pull_request_tended')).toHaveLength(2);
  });
});

describe('Tend again on a pull request the hopper gave up on (issue #1010)', () => {
  const cardOf = async (app: TestApp, jobId: string): Promise<PullRequestCard | undefined> =>
    (await app.api<PullRequestsView>('GET', '/api/pull-requests')).body.repos.flatMap((r) => r.pullRequests).find((c) => c.jobId === jobId);

  it('a failed tend: one click runs the same step again, names who asked, and the card waits on it; refused when nothing gave up', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const token = await app.login();
    let fixes = false;
    const { issue, job, url } = await pullRequestWaiting(gh, app, (pr) => { if (fixes) gh.setConflicting(pr, false); });
    // Nothing gave up yet: refused, and no job starts.
    const early = await app.ui<{ error: string }>('/ui/api/pull-requests/tend', { jobId: job.id }, { token });
    expect(early.status).toBe(409);
    expect(early.body.error).toMatch(/no tend of its pull request ended/);

    gh.setConflicting(url, true);
    await app.sync();
    const failedTend = await nextJob(app, issue.url, 2);
    await app.waitForStatus(failedTend!.id, 'failed');
    await waitFor(async () => (await cardOf(app, job.id))?.waits === 'tend failed', { what: 'the hopper gave up' });
    expect((await cardOf(app, job.id))?.gaveUp).toMatch(/^the job that rebased it failed/);
    await waitFor(async () => (await app.job(failedTend!.id)).sourceState?.sync?.finalReported === true, { what: 'its end reported' });

    fixes = true;
    // Answered before the tend (issue #1194): the tend job, once it is made.
    const r = await tendAgain(app, job.id, token);
    expect(r.status).toBe(200);
    const again = await nextJob(app, issue.url, 3);
    expect(r.body.job.id).toBe(again!.id);
    expect(again).toMatchObject({ spec: expect.objectContaining({ tend: true }) });
    expect(String(again!.spec.payload.prompt)).toContain(tendBrief(url, 'rebase'));
    const tended = (await app.events('types=job.pull_request_tended')).filter((e) => e.jobId === job.id);
    expect(tended.at(-1)!.data).toEqual({ pullRequest: url, step: 'rebase', nextJobId: again!.id, person: expect.any(String), via: 'ui' });
    expect((await app.job(job.id)).sourceState?.source).toMatchObject({ follow: 'tended', tended: { nextJobId: again!.id } });
    expect(((await app.job(job.id)).sourceState?.source as { tended?: { again?: string } }).tended?.again).toBeUndefined();

    // A second click while that tend runs: refused, no third tend.
    const twice = await app.ui<{ error: string }>('/ui/api/pull-requests/tend', { jobId: job.id }, { token });
    expect(twice.status).toBe(409);
    await app.waitForStatus(again!.id, 'finished');
    expect((await jobsFor(app, issue.url)).filter((j) => j.spec.tend)).toHaveLength(2);
  });
  it('a tend a person cancelled: hopper pr tend <n> tends it again on the same route, named as the operator CLI', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const issue = gh.createIssue({ repo: REPO, body: body({ op: 'echo', ms: 1500 }), labels: ['hopper'] });
    let url: string | undefined;
    app.scripted.ships((j) => { url ??= gh.openPullRequest(REPO, j.source!.number!, { createdAt: new Date().toISOString() }).url; });
    await app.sync();
    const [job] = await jobsFor(app, issue.url);
    await app.waitForStatus(job!.id, 'finished');
    await waitFor(() => gh.issue(REPO, issue.number).labels.includes('hopper:pr-ready'), { what: 'hopper:pr-ready' });
    gh.setConflicting(url!, true);
    await app.sync();
    const tender = await nextJob(app, issue.url, 2);
    await app.waitForStatus(tender!.id, 'running');
    app.user().engine.cancel(tender!.id, 'cancelled in UI');
    await app.waitForStatus(tender!.id, 'cancelled');
    await waitFor(async () => (await app.job(tender!.id)).sourceState?.sync?.finalReported === true, { what: 'its cancel reported' });
    await waitFor(async () => (await cardOf(app, job!.id))?.waits === 'tend failed', { what: 'the hopper gave up' });

    const out: string[] = [];
    const io: CliIo = { env: { HOPPER_DATABASE_URL: databaseUrlFor(app.dbPath) }, stdin: () => '', out: (x) => out.push(x), err: () => undefined };
    const code = await runCli(['pr', 'tend', url!.split('/').at(-1)!, '--json', '--url', app.url], io);
    expect(code).toBe(0);
    expect(JSON.parse(out.join(''))).toEqual({ jobId: job!.id, giveBack: 'tend' });
    const again = await nextJob(app, issue.url, 3);
    const tended = (await app.events('types=job.pull_request_tended')).filter((e) => e.jobId === job!.id);
    expect(tended.at(-1)!.data).toMatchObject({ nextJobId: again!.id, via: 'cli', person: 'operator CLI' });
  });
});

describe('the done-check and failing checks (issue #736)', () => {
  it('a job whose own pull request has failing checks is not done: it goes on told to fix them, and finishes once they pass', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const issue = gh.createIssue({ repo: REPO, body: body({ op: 'echo' }), labels: ['hopper'] });
    let pr: string | undefined;
    app.scripted.ships((j) => {
      if (pr === undefined) pr = gh.openPullRequest(REPO, j.source!.number!, { createdAt: new Date().toISOString(), checks: 'failing' }).url;
      else gh.setChecks(pr, 'passing');
    });
    await app.sync();
    const [job] = await jobsFor(app, issue.url);
    await app.waitForStatus(job!.id, 'finished');
    expect((await app.events('types=job.finish_briefed')).map((e) => e.data)).toEqual([{ pullRequest: pr, step: 'fix_checks' }]);
  });
});
