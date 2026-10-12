// Tending a waiting pull request (issue #736): a PR waiting job's pull request that gets merge conflicts with its base, or
// failing checks, is not left for a person. The hopper runs its item again with the tend brief, and the new job brings the
// same pull request back to ready. A job that cannot is handed to a person with why. A done job's own pull request with
// failing checks is not done. Real daemon, in-memory fake GitHub at the GitHubApi seam; issues carry a scripted-executor
// op as their first body line.
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_TENDS, tendBrief, type FailuresView, type Job } from '../../src/domain/types.ts';
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
    const finished = await app.waitForStatus(tender!.id, 'finished');
    expect(String(app.scripted.payloads.at(-1)!.prompt)).toContain(tendBrief(url, 'rebase'));
    expect((await app.events('types=job.pull_request_tended')).map((e) => [e.jobId, e.data])).toEqual([[job.id, { pullRequest: url, step: 'rebase', nextJobId: tender!.id }]]);
    expect((await app.events('types=job.rerun')).map((e) => [e.jobId, e.data])).toEqual([[job.id, { by: 'tending' }]]);
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
