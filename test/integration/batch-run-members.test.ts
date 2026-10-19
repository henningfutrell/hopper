// A batch run's members (issue #2132): a job's pull request merges into the landing branch (`main`), which closes no issue,
// and a batch run of `main` into the default branch (`dev`) says "Closes #N" for its issue. The batch run is no issue's
// work: a job's report and its follow never take it for the job's pull request. So a batch run closed without a merge
// leaves its members merged: no `hopper:pr-closed`, no block, and Intake offers nothing for them. Real daemon, in-memory
// fake GitHub at the GitHubApi seam, `dev` its default branch.
import { afterEach, describe, expect, it } from 'vitest';
import type { Job } from '../../src/domain/types.ts';
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
  const token = await a.login();
  expect((await a.ui('/ui/api/landing-batches', { repos: { [REPO]: { tested: 'dev' } } }, { token })).status).toBe(200);
  return a;
}

const body = `${JSON.stringify({ op: 'echo' })}\n\nPlease do the thing.`;
const jobsFor = async (app: TestApp, url: string): Promise<Job[]> =>
  (await app.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs.filter((j) => j.source?.key === url);

describe('a batch run closed without a merge (issue #2132)', () => {
  it('a member whose own pull request merged keeps its merged state: no hopper:pr-closed, no block, and Intake offers nothing', async () => {
    const gh = createFakeGitHub({ defaultBranch: 'dev' });
    const app = await boot(gh);
    const issue = gh.createIssue({ repo: REPO, body, labels: ['hopper'] });
    let own = '';
    let batch = '';
    // The job's pull request merged into main while the job ran, and the batch run that carries it opened: the report
    // finds no open pull request of the job's own, only the batch run's.
    app.scripted.ships((job) => {
      if (own) return;
      const now = new Date().toISOString();
      own = gh.openPullRequest(REPO, job.source!.number!, { createdAt: now, base: 'main' }).url;
      gh.mergePullRequest(own, now);
      batch = gh.openPullRequest(REPO, job.source!.number!, {
        createdAt: now, base: 'dev', headRef: 'hopper-batch/abc123def456',
        body: `A batch run.\n\nPull requests in this batch:\n- #${own.split('/').pop()}\n\nCloses #${job.source!.number}`,
      }).url;
    });
    await app.sync();
    const [job] = await jobsFor(app, issue.url);
    await app.waitForStatus(job!.id, 'finished');
    const item = () => app.user().store.workItems.get(issue.url);
    await app.sync();
    await waitFor(() => item()?.state === 'done', { what: 'the item done' });
    expect(item()).toMatchObject({ pullRequest: own, pullRequestState: 'merged' });
    expect(gh.issue(REPO, issue.number)).toMatchObject({ state: 'open' });

    gh.closePullRequest(batch);
    await app.sync();
    await app.sync();
    expect(gh.issue(REPO, issue.number).labels).not.toContain('hopper:pr-closed');
    expect(gh.issue(REPO, issue.number).labels).toContain('hopper:done');
    expect(item()).toMatchObject({ state: 'done', pullRequest: own, pullRequestState: 'merged' });
    expect(await app.events('types=job.pull_request_closed')).toEqual([]);
    expect((await app.events('types=source.request_opened')).filter((e) => e.data.key === issue.url)).toEqual([]);
    expect(await jobsFor(app, issue.url)).toHaveLength(1);
  });

  it('a member whose own pull request closed without a merge is flagged as before: hopper:pr-closed', async () => {
    const gh = createFakeGitHub({ defaultBranch: 'dev' });
    const app = await boot(gh);
    const issue = gh.createIssue({ repo: REPO, body, labels: ['hopper'] });
    let own = '';
    app.scripted.ships((job) => {
      if (!own) own = gh.openPullRequest(REPO, job.source!.number!, { createdAt: new Date().toISOString(), base: 'main' }).url;
    });
    await app.sync();
    const [job] = await jobsFor(app, issue.url);
    await app.waitForStatus(job!.id, 'finished');
    await waitFor(() => gh.issue(REPO, issue.number).labels.includes('hopper:pr-ready'), { what: 'hopper:pr-ready' });
    const batch = gh.openPullRequest(REPO, issue.number, { createdAt: new Date().toISOString(), base: 'dev', headRef: 'hopper-batch/abc123def456', body: `A batch run.\n\nCloses #${issue.number}` }).url;
    gh.closePullRequest(own);
    gh.closePullRequest(batch);
    await app.sync();
    await waitFor(() => gh.issue(REPO, issue.number).labels.includes('hopper:pr-closed'), { what: 'hopper:pr-closed' });
    expect((await app.events('types=job.pull_request_closed')).map((e) => e.data)).toEqual([{ pullRequest: own, part: false }]);
  });
});
