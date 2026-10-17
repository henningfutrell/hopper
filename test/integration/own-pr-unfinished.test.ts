// Own PR unfinished (issue #1265): a job that ends done while its own pull request has merge conflicts with its base is the
// hopper's to finish, never a person's while its retries last. The job goes on, told to rebase and resolve the conflicts; no
// hand-off and no `hopper:failed` until its retries are spent; with automatic Continue off, a person as before. Real daemon,
// in-memory fake GitHub at the GitHubApi seam; issues carry a scripted-executor op as their first body line.
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

async function boot(gh: FakeGitHub, settings?: Partial<FailureSettings>): Promise<TestApp> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  const plugins = { jobSources: [{ name: 'github', plugin: 'github-account', options: { enabled: true, pollSeconds: 3600, executor: 'scripted' } }] };
  a = await startTestApp({ dbPath: db.dbPath, seams: { github: gh }, plugins });
  connectGitHub(a, [REPO]);
  if (settings) {
    const token = await a.login();
    expect((await a.ui<FailureSettings>('/ui/api/failures/settings', settings, { token })).status).toBe(200);
  }
  return a;
}

const body = (op: Record<string, unknown>) => `${JSON.stringify(op)}\n\nPlease do the thing.`;
const jobsFor = async (app: TestApp, url: string): Promise<Job[]> =>
  (await app.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs.filter((j) => j.source?.key === url);
const failuresOf = async (app: TestApp): Promise<FailuresView> => (await app.api<FailuresView>('GET', '/api/failures')).body;
const assessed = async (app: TestApp, jobId: string) => (await app.events('types=job.assessed&limit=1000')).filter((e) => e.jobId === jobId).map((e) => e.data);

/** A job that opens a pull request closing its issue, with merge conflicts; a run the assessor sent back does `fix` to it. */
async function conflictingPullRequest(gh: FakeGitHub, app: TestApp, fix: (url: string) => void) {
  const issue = gh.createIssue({ repo: REPO, body: body({ op: 'echo' }), labels: ['hopper'] });
  let url: string | undefined;
  let first: string | undefined;
  app.scripted.ships((j) => {
    first ??= j.id;
    if (url === undefined) url = gh.openPullRequest(REPO, j.source!.number!, { createdAt: new Date().toISOString(), conflicting: true }).url;
    else if (j.continued !== undefined || j.id !== first) fix(url);
  });
  await app.sync();
  // The list is newest first: the job may already have failed and gone on as a new run.
  const job = (await jobsFor(app, issue.url)).at(-1);
  return { issue, job: job!, url: () => url! };
}

describe('own PR unfinished (issue #1265)', () => {
  it('its pull request has merge conflicts: no hand-off, the job goes on told to rebase, and finishes once it is fixed', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const { issue, job, url } = await conflictingPullRequest(gh, app, (pr) => gh.pushToPullRequest(pr, new Date().toISOString()));
    const failed = await app.waitForStatus(job.id, 'failed');
    expect(failed.error).toContain(`PR #${/\/pull\/(\d+)/.exec(url())![1]}: merge conflicts with its base`);
    const done = await waitFor(async () => (await jobsFor(app, issue.url)).find((j) => j.status === 'finished'), { what: 'the job finished', timeoutMs: 30_000 });
    const told = `${String((done.result as { answer?: unknown } | undefined)?.answer ?? '')}\n${String(app.scripted.payloads.at(-1)!.prompt ?? '')}`;
    expect(told).toContain(`Your pull request ${url()} has merge conflicts with its base branch.`);
    expect(told).toContain('Rebase your branch onto it.');
    expect(await assessed(app, job.id)).toEqual([expect.objectContaining({ causeId: 'own-pr-unfinished', decision: 'continue', auto: true })]);
    expect((await app.events('types=job.continued&limit=1000')).length + (await app.events('types=job.rerun&limit=1000')).length).toBe(1);
    expect((await failuresOf(app)).handoffs).toEqual([]);
    expect(gh.issue(REPO, issue.number).labels).not.toContain('hopper:failed');
  });

  it('still conflicting after the retries: a person, with the reason', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh, { maxAttempts: 1 });
    await conflictingPullRequest(gh, app, (pr) => gh.pushToPullRequest(pr, new Date().toISOString(), { conflicting: true }));
    const handoff = await waitFor(async () => (await failuresOf(app)).handoffs[0], { what: 'a hand-off', timeoutMs: 30_000 });
    expect(handoff.reasons.join(' ')).toMatch(/retry limit reached: sent back 1 time to finish its pull request/);
    expect((await app.events('types=job.continued&limit=1000')).length + (await app.events('types=job.rerun&limit=1000')).length).toBe(1);
  });

  it('automatic Continue off: a person, as before', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh, { auto: { retry: true, hold: true, redirect: true, continue: false } });
    const { job } = await conflictingPullRequest(gh, app, () => {});
    const handoff = await waitFor(async () => (await failuresOf(app)).handoffs[0], { what: 'a hand-off', timeoutMs: 30_000 });
    expect(handoff.jobId).toBe(job.id);
    expect(await assessed(app, job.id)).toEqual([expect.objectContaining({ causeId: 'own-pr-unfinished', decision: 'continue', auto: false })]);
    expect(await app.events('types=job.continued&limit=1000')).toEqual([]);
  });

  // Issue #1522: the miss's text is the generic Not complete form — the pull request the job updated is one its issue names,
  // which neither closes nor references the issue — but its work shows the pull request with merge conflicts.
  describe('the failure text in the generic Not complete form, its work showing the conflicts (issue #1522)', () => {
    async function namedPullRequest(gh: FakeGitHub, app: TestApp, fix: (url: string, issue: number) => void) {
      const other = gh.createIssue({ repo: REPO, body: 'Other work.' });
      const pr = gh.openReferencingPullRequest(REPO, other.number, { createdAt: '2026-10-01T09:00:00.000Z', crossReferenced: false, headRef: 'other-work' });
      const issue = gh.createIssue({ repo: REPO, body: `${body({ op: 'echo' })}\nIts work is on ${pr.url}.`, labels: ['hopper'] });
      let first: string | undefined;
      app.scripted.ships((j) => {
        first ??= j.id;
        if (j.id === first && j.continued === undefined) gh.pushToPullRequest(pr.url, new Date().toISOString(), { conflicting: true });
        else fix(pr.url, issue.number);
      });
      await app.sync();
      // The list is newest first: the job may already have failed and gone on as a new run.
      const job = (await jobsFor(app, issue.url)).at(-1);
      return { issue, job: job!, url: pr.url };
    }

    it('no hand-off: Own PR unfinished, the job goes on, and finishes once it is fixed', async () => {
      const gh = createFakeGitHub();
      const app = await boot(gh);
      const { issue, job } = await namedPullRequest(gh, app, (pr, n) => {
        gh.pushToPullRequest(pr, new Date().toISOString());
        gh.closeIssue(REPO, n, 'someone', { at: new Date().toISOString() });
      });
      // Its failure event, not its status: the job may already have gone on.
      const failed = await waitFor(async () => (await app.events('types=job.failed&limit=1000')).find((e) => e.jobId === job.id), { what: 'the job failed' });
      const error = String((failed.data as { error?: unknown }).error);
      expect(error).toMatch(/^not complete: /);
      expect(error).not.toMatch(/merge conflicts with its base/);
      await waitFor(async () => (await jobsFor(app, issue.url)).find((j) => j.status === 'finished'), { what: 'the job finished', timeoutMs: 30_000 });
      expect(await assessed(app, job.id)).toEqual([expect.objectContaining({ causeId: 'own-pr-unfinished', decision: 'continue', auto: true })]);
      expect((await app.events('types=job.continued&limit=1000')).length + (await app.events('types=job.rerun&limit=1000')).length).toBe(1);
      expect(await app.events('types=handoff.opened&limit=1000')).toEqual([]);
    });

    it('still conflicting after the retries: a person', async () => {
      const gh = createFakeGitHub();
      const app = await boot(gh, { maxAttempts: 1 });
      await namedPullRequest(gh, app, (pr) => gh.pushToPullRequest(pr, new Date().toISOString(), { conflicting: true }));
      const handoff = await waitFor(async () => (await failuresOf(app)).handoffs[0], { what: 'a hand-off', timeoutMs: 30_000 });
      expect(handoff.reasons.join(' ')).toMatch(/retry limit reached: sent back 1 time to finish its pull request/);
      expect((await app.events('types=job.continued&limit=1000')).length + (await app.events('types=job.rerun&limit=1000')).length).toBe(1);
    });

    it('automatic Continue off: a person, as before', async () => {
      const gh = createFakeGitHub();
      const app = await boot(gh, { auto: { retry: true, hold: true, redirect: true, continue: false } });
      const { job } = await namedPullRequest(gh, app, () => {});
      const handoff = await waitFor(async () => (await failuresOf(app)).handoffs[0], { what: 'a hand-off', timeoutMs: 30_000 });
      expect(handoff.jobId).toBe(job.id);
      expect(await app.events('types=job.continued&limit=1000')).toEqual([]);
    });
  });
});
