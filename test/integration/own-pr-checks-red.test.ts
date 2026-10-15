// Own PR checks red (issue #1230): a job that ends done while the checks of its own pull request are red is the hopper's
// to finish. Its failed checks run again once; red again, the job goes on told the failed checks and their logs; no
// hand-off and no `hopper:failed` until its retries are spent. Real daemon, in-memory fake GitHub at the GitHubApi seam;
// issues carry a scripted-executor op as their first body line.
import { afterEach, describe, expect, it } from 'vitest';
import type { FailureSettings, FailuresView, Job } from '../../src/domain/types.ts';
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
  a = await startTestApp({ dbPath: db.dbPath, env: { HOPPER_CHECKS_WAIT_MS: '200' }, seams: { github: gh }, plugins });
  connectGitHub(a, [REPO]);
  return a;
}

const body = (op: Record<string, unknown>) => `${JSON.stringify(op)}\n\nPlease do the thing.`;
const jobsFor = async (app: TestApp, url: string): Promise<Job[]> =>
  (await app.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs.filter((j) => j.source?.key === url)
    .sort((x, y) => x.createdAt.localeCompare(y.createdAt) || x.id.localeCompare(y.id));
const failedLabels = (gh: FakeGitHub) => gh.calls.filter((c) => c.method === 'addLabels' && (c.args[2] as string[]).includes('hopper:failed'));
const failuresOf = async (app: TestApp): Promise<FailuresView> => (await app.api<FailuresView>('GET', '/api/failures')).body;
const CHECK = { name: 'test (node 24)', url: `https://github.com/${REPO}/actions/runs/7/job/71` };
const LOG = ['FAIL test/landing.test.ts > answers in time', 'AssertionError: expected 210.6 to be less than 200', '##[error]Process completed with exit code 1.']
  .map((l) => `2026-10-15T10:00:02.0000000Z ${l}`).join('\n');

/** A job that opens a pull request closing its issue, its one check red; a run the hopper sent back does `fix` to it. */
async function redPullRequest(gh: FakeGitHub, app: TestApp, fix: (url: string) => void) {
  const issue = gh.createIssue({ repo: REPO, body: body({ op: 'echo' }), labels: ['hopper'] });
  gh.setJobLog(REPO, 71, LOG);
  let url: string | undefined;
  let first: string | undefined;
  app.scripted.ships((j) => {
    first ??= j.id;
    if (url === undefined) {
      url = gh.openPullRequest(REPO, j.source!.number!, { createdAt: new Date().toISOString() }).url;
      gh.setChecks(url, 'failing', [CHECK]);
    } else if (j.continued !== undefined || j.id !== first) {
      fix(url);
    }
  });
  await app.sync();
  const [job] = await jobsFor(app, issue.url);
  return { issue, job: job!, url: () => url! };
}

describe('own PR checks red (issue #1230)', () => {
  it('one red check: the check runs again, red again the job goes on told the failure, and finishes once it passes; no hand-off, no hopper:failed', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const { issue, job, url } = await redPullRequest(gh, app, (pr) => { gh.pushToPullRequest(pr, new Date().toISOString()); gh.setChecks(pr, 'passing'); });
    const failed = await app.waitForStatus(job.id, 'failed');
    const n = /\/pull\/(\d+)/.exec(url())![1];
    expect(failed.error).toContain(`PR #${n}: checks failed: test (node 24)`);
    await waitFor(() => gh.jobReruns.length > 0, { what: 'the failed check run again' });
    expect(gh.jobReruns).toEqual([`${REPO}#71`]);
    const done = await waitFor(async () => (await jobsFor(app, issue.url)).find((j) => j.status === 'finished'), { what: 'the job finished', timeoutMs: 30_000 });
    // In its own session (the answer it resumed with), or a new job of its item (its prompt): told the failure.
    const told = `${String((done.result as { answer?: unknown } | undefined)?.answer ?? '')}\n${String(app.scripted.payloads.at(-1)!.prompt ?? '')}`;
    expect(told).toContain(`The checks of your pull request ${url()} fail.`);
    expect(told).toContain('AssertionError: expected 210.6 to be less than 200');
    expect(told).toContain('The hopper ran the failed checks again once, and they failed again.');
    expect(done.source?.key).toBe(issue.url);
    expect((await app.events('types=job.checks_rerun')).map((e) => e.data)).toEqual([{ recordId: expect.any(String), pullRequest: url(), head: expect.any(String), checks: ['test (node 24)'] }]);
    const view = await failuresOf(app);
    expect(view.handoffs).toEqual([]);
    expect((await app.events('types=job.assessed&limit=1000')).filter((e) => e.jobId === job.id).map((e) => e.data)).toEqual([expect.objectContaining({ causeId: 'own-pr-checks-red', decision: 'continue', auto: true })]);
    expect(failedLabels(gh)).toEqual([]);
    expect(gh.issue(REPO, issue.number).labels).not.toContain('hopper:failed');
  });

  it('red again after the retries: a person, with the reason, and only then hopper:failed', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const token = await app.login();
    const r = await app.ui<FailureSettings>('/ui/api/failures/settings', { maxAttempts: 1 }, { token });
    expect(r.status).toBe(200);
    // The job sent back pushes a try that does not fix the check.
    const { issue } = await redPullRequest(gh, app, (pr) => { gh.pushToPullRequest(pr, new Date().toISOString()); });
    const handoff = await waitFor(async () => (await failuresOf(app)).handoffs[0], { what: 'a hand-off', timeoutMs: 30_000 });
    expect(handoff.reasons.join(' ')).toMatch(/retry limit reached: sent back 1 time for red checks/);
    expect(gh.jobReruns).toEqual([`${REPO}#71`]);
    await waitFor(() => gh.issue(REPO, issue.number).labels.includes('hopper:failed'), { what: 'hopper:failed' });
    expect(failedLabels(gh)).toHaveLength(1);
    expect((await app.events('types=job.continued&limit=1000')).length + (await app.events('types=job.rerun&limit=1000')).length).toBe(1);
  });
});
