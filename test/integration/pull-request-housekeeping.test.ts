// Pull request housekeeping (issue #1143), over the real daemon: a tend job started is said on its pull request; a job's
// pull request off the landing branch is moved to it and recorded (`job.pull_request_retargeted`); one superseded by another
// pull request that closed its issue is closed, and the close is recorded with why. In-memory fake GitHub at the GitHubApi
// seam; issues carry a scripted-executor op as their first body line.
import { afterEach, describe, expect, it } from 'vitest';
import type { Job } from '../../src/domain/types.ts';
import { createFakeGitHub, type FakeGitHub } from '../../src/sources/index.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { connectGitHub } from '../support/github-account.ts';
import { waitFor } from '../support/wait.ts';
import { retargetNote, tendNote } from '../../src/sources/github/pr-notes.ts';

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

describe('pull request housekeeping (issue #1143)', () => {
  it('a tend job started: the pull request says the hopper works on it, once', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const { issue, url } = await pullRequestWaiting(gh, app, (pr) => gh.pushToPullRequest(pr, new Date().toISOString()));
    gh.setConflicting(url, true);
    await app.sync();
    const tender = await nextJob(app, issue.url, 2);
    await app.waitForStatus(tender!.id, 'finished');
    expect(gh.pullRequestComments(url)).toEqual([tendNote('rebase')]);
  });

  it('a pull request off the landing branch: moved to it, and recorded', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    gh.setDefaultBranch(REPO, 'main');
    const { job, url } = await pullRequestWaiting(gh, app, () => undefined);
    await app.sync();
    await waitFor(async () => (await app.events('types=job.pull_request_retargeted')).length > 0, { what: 'job.pull_request_retargeted' });
    expect((await app.events('types=job.pull_request_retargeted')).map((e) => [e.jobId, e.data])).toEqual([[job.id, { pullRequest: url, from: 'dev', to: 'main' }]]);
    expect(gh.pullRequestComments(url)).toEqual([retargetNote('dev', 'main')]);
  });

  it('a pull request superseded by another that closed its issue: closed, and recorded with why', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const { issue, job, url } = await pullRequestWaiting(gh, app, () => undefined);
    const now = new Date().toISOString();
    const other = gh.closeByPullRequest(REPO, issue.number, { createdAt: now, mergedAt: now });
    await app.sync();
    await waitFor(async () => (await app.events('types=job.pull_request_closed')).length > 0, { what: 'job.pull_request_closed' });
    expect((await app.events('types=job.pull_request_closed')).map((e) => [e.jobId, e.data]))
      .toEqual([[job.id, { pullRequest: url, part: false, superseded: `its issue was closed by ${other.url}` }]]);
  });
});
