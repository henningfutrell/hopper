// The tend loop stops on its own (issue #2127). A tend job that finds its pull request has nothing left to merge closes its
// work item's issue, or the pull request, and ends; the pull request may still have merge conflicts. The hopper starts no
// new tend job for it: a rebase tend is never capped, so before this the same tend job started again and again. Real
// daemon, in-memory fake GitHub at the GitHubApi seam; issues carry a scripted-executor op as their first body line.
//
// Feature: the tend loop stops
//   Scenario: the work item's issue is closed while its pull request still conflicts
//     Given a pull request a tend job rebases, which closes the work item's issue and leaves the conflicts
//     When the hopper syncs again
//     Then it starts no new tend job, and the issue stays closed
//   Scenario: the tend job closes the pull request with no merge
//     Then the hopper records the close and starts no new tend job
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
  return a;
}

const body = (op: Record<string, unknown>) => `${JSON.stringify(op)}\n\nPlease do the thing.`;
const jobsFor = async (app: TestApp, url: string): Promise<Job[]> =>
  (await app.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs.filter((j) => j.source?.key === url)
    .sort((x, y) => x.createdAt.localeCompare(y.createdAt) || x.id.localeCompare(y.id));
const nextJob = (app: TestApp, url: string, count: number) =>
  waitFor(async () => { const j = await jobsFor(app, url); return j.length === count ? j.at(-1) : undefined; }, { what: `job ${count} of the item` });

/** A job that opens a ready pull request, then — each later run — does `tend` to it. */
async function pullRequestWaiting(gh: FakeGitHub, app: TestApp, tend: (url: string, number: number) => void) {
  const issue = gh.createIssue({ repo: REPO, body: body({ op: 'echo' }), labels: ['hopper'] });
  let url: string | undefined;
  app.scripted.ships((j) => {
    if (url === undefined) url = gh.openPullRequest(REPO, j.source!.number!, { createdAt: new Date().toISOString() }).url;
    else tend(url, j.source!.number!);
  });
  await app.sync();
  const [job] = await jobsFor(app, issue.url);
  await app.waitForStatus(job!.id, 'finished');
  await waitFor(() => gh.issue(REPO, issue.number).labels.includes('hopper:pr-ready'), { what: 'hopper:pr-ready' });
  return { issue, job: job!, url: url! };
}

async function ended(app: TestApp, id: string): Promise<void> {
  await waitFor(async () => ['finished', 'failed'].includes((await app.job(id)).status) || undefined, { what: 'the tend job to end' });
  await waitFor(async () => (await app.job(id)).sourceState?.sync?.finalReported === true, { what: 'its end reported' });
}

describe('the tend loop stops (issue #2127)', () => {
  it('starts no new tend job once the work item\'s issue is closed, though its pull request still conflicts', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    // The tend job finds nothing left to merge: it closes the work item's issue as completed and leaves the conflicts.
    const { issue, url } = await pullRequestWaiting(gh, app, (_url, n) => gh.closeIssue(REPO, n, 'owner'));
    gh.setConflicting(url, true);
    await app.sync();
    const tender = await nextJob(app, issue.url, 2);
    expect(tender!.spec.tend).toBe(true);
    await ended(app, tender!.id);
    for (let i = 0; i < 3; i++) await app.sync();
    expect(await jobsFor(app, issue.url)).toHaveLength(2);
    expect(gh.issue(REPO, issue.number).state).toBe('closed');
  });

  it('starts no new tend job once the tend job closed the pull request with no merge', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const { issue, url } = await pullRequestWaiting(gh, app, (pr) => gh.closePullRequest(pr));
    gh.setConflicting(url, true);
    await app.sync();
    const tender = await nextJob(app, issue.url, 2);
    await ended(app, tender!.id);
    for (let i = 0; i < 3; i++) await app.sync();
    expect((await jobsFor(app, issue.url)).filter((j) => j.spec.tend)).toHaveLength(1);
    expect((await app.events('types=job.pull_request_closed')).map((e) => e.data.pullRequest)).toContain(url);
  });
});
