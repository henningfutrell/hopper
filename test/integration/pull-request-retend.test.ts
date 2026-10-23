// A failed rebase tend, once its base branch moves (issue #1143 part 3): the hopper's mirror says the commit the base
// branch is at; the first after the failure is kept, and another one makes the same rebase due again, at most
// MAX_TEND_RETRIES in a row. Where the hopper cannot read the base, the pull request waits on a person, as before. Real
// daemon, in-memory fake GitHub at the GitHubApi seam; issues carry a scripted-executor op as their first body line.
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_TEND_RETRIES, tendBrief, type Job, type PullRequestCard, type PullRequestsView } from '../../src/domain/types.ts';
import { createFakeGitHub, type FakeGitHub } from '../../src/sources/index.ts';
import { tendNote } from '../../src/sources/github/pr-notes.ts';
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

describe('a failed rebase tend, once its base branch moves (issue #1143 part 3)', () => {
  const cardOf = async (app: TestApp, jobId: string): Promise<PullRequestCard | undefined> =>
    (await app.api<PullRequestsView>('GET', '/api/pull-requests')).body.repos.flatMap((r) => r.pullRequests).find((c) => c.jobId === jobId);
  const tip = (n: number) => n.toString(16).padStart(40, '0');

  it(`is tended again, at most ${MAX_TEND_RETRIES} times in a row; a base that stands still tends nothing`, async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    // Each tend job leaves the conflicts as they are: it ends failed.
    const { issue, job, url } = await pullRequestWaiting(gh, app, () => undefined);
    gh.setBaseTip(REPO, 'dev', tip(1));
    gh.setConflicting(url, true);
    await app.sync();
    let tender = await nextJob(app, issue.url, 2);
    const ended = async (id: string) => {
      await app.waitForStatus(id, 'failed');
      await waitFor(async () => (await app.job(id)).sourceState?.sync?.finalReported === true, { what: 'its end reported' });
    };
    for (let n = 1; n <= MAX_TEND_RETRIES; n++) {
      await ended(tender!.id);
      // The base as the hopper first saw it after the failure; the same base tends nothing.
      await app.sync();
      await app.sync();
      expect(await jobsFor(app, issue.url)).toHaveLength(n + 1);
      expect((await cardOf(app, job.id))?.gaveUp).toMatch(/the hopper rebases it again when its base branch moves$/);

      gh.setBaseTip(REPO, 'dev', tip(n + 1));
      await app.sync();
      const again = await nextJob(app, issue.url, n + 2);
      expect(again).toMatchObject({ rerunOf: tender!.id, spec: expect.objectContaining({ tend: true }) });
      expect(String(again!.spec.payload.prompt)).toContain(tendBrief(url, 'rebase'));
      expect((await app.job(job.id)).sourceState?.source).toMatchObject({ follow: 'tended', tended: { pullRequest: url, step: 'rebase', nextJobId: again!.id, retries: n } });
      tender = again;
    }

    // The last one failed too: the hopper gives up, whatever the base does.
    await ended(tender!.id);
    await app.sync();
    gh.setBaseTip(REPO, 'dev', tip(99));
    await app.sync();
    await app.sync();
    expect(await jobsFor(app, issue.url)).toHaveLength(MAX_TEND_RETRIES + 2);
    expect((await cardOf(app, job.id))?.gaveUp).toMatch(/^the job that rebased it failed/);
    expect((await cardOf(app, job.id))?.gaveUp).not.toMatch(/when its base branch moves/);
    expect(gh.pullRequestComments(url)).toEqual(Array(MAX_TEND_RETRIES + 1).fill(tendNote('rebase')));
    // Five jobs, one after another: about 2 s each under CI load (1.4 s for all of them here), so 15 s was too short (issue #2525).
  }, 60_000);

  it('is not tended again once it was closed without a merge (issue #1456): the end is recorded, and it shows open no more', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const { issue, job, url } = await pullRequestWaiting(gh, app, () => undefined);
    gh.setBaseTip(REPO, 'dev', tip(1));
    gh.setConflicting(url, true);
    await app.sync();
    const tender = await nextJob(app, issue.url, 2);
    await app.waitForStatus(tender!.id, 'failed');
    await waitFor(async () => (await app.job(tender!.id)).sourceState?.sync?.finalReported === true, { what: 'its end reported' });
    await app.sync();
    // Closed as superseded by another pull request, then the base moves: nothing is left to rebase. The strays' read fails
    // once, as a sync between two rounds of every follow makes none: only the tend itself sees the close.
    gh.closePullRequest(url);
    gh.setBaseTip(REPO, 'dev', tip(2));
    gh.failNext('openPullRequestsIn', new Error('GitHub is away'));
    await app.sync();
    expect(await jobsFor(app, issue.url)).toHaveLength(2);
    expect((await app.job(job.id)).sourceState?.source).toMatchObject({ pullRequest: url, follow: 'closed' });
    await app.sync();
    expect(await jobsFor(app, issue.url)).toHaveLength(2);
    expect(gh.pullRequestComments(url)).toEqual([tendNote('rebase')]);
    expect((await cardOf(app, job.id))?.state).not.toBe('open');
    expect((await app.events('types=job.pull_request_closed')).filter((e) => e.jobId === job.id))
      .toEqual([expect.objectContaining({ data: expect.objectContaining({ pullRequest: url }) })]);
  });

  it('where the hopper cannot read the base branch (no mirror), a failed rebase tend waits on a person, as before', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const { issue, job, url } = await pullRequestWaiting(gh, app, () => undefined);
    gh.setConflicting(url, true);
    await app.sync();
    const tender = await nextJob(app, issue.url, 2);
    await app.waitForStatus(tender!.id, 'failed');
    await waitFor(async () => (await app.job(tender!.id)).sourceState?.sync?.finalReported === true, { what: 'its end reported' });
    await app.sync();
    await app.sync();
    expect(await jobsFor(app, issue.url)).toHaveLength(2);
    expect((await cardOf(app, job.id))?.gaveUp).toMatch(/^the job that rebased it failed/);
  });
});
