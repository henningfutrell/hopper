// Issue #859: a follow-on of a proposal's path works its parent's issue like any job of it. It has the parent's source,
// so its issue is done only by a pull request it opens; the parent's job, finished when the proposal was accepted, leaves
// the issue claimed and follows no pull request. Real daemon, real database; the in-memory fake GitHub at the GitHubApi seam.
//
// Feature: a proposal's follow-on opens its pull request on its parent's issue
//   Scenario: the follow-on ends with no pull request
//     Given an issue whose job writes a proposal, and a person selects path 1
//     When the follow-on ends done but opened no pull request
//     Then it fails as not complete, the issue stays open and is not marked done or ready
//     And the parent's job follows no pull request
//   Scenario: the follow-on opens its pull request
//     When the follow-on opens a pull request that closes the issue, and ends done
//     Then it is finished, the issue waits on that pull request, and yolo mode merges it
import { afterEach, describe, expect, it } from 'vitest';
import type { Job, ReviewItemView } from '../../src/domain/types.ts';
import { createFakeGitHub, type FakeGitHub } from '../../src/sources/index.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { connectGitHub } from '../support/github-account.ts';
import { THREE_PATHS } from '../support/proposal-paths.ts';
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

const jobs = async (app: TestApp): Promise<Job[]> => (await app.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs;
const followOf = async (app: TestApp, id: string) => (await app.job(id)).sourceState?.source as { follow?: string; pullRequest?: string } | undefined;

/** An issue whose job writes a proposal; a person selects path 1. Answers the issue, the parent's job and the follow-on. */
async function selected(gh: FakeGitHub, app: TestApp) {
  const token = await app.login();
  expect((await app.ui('/ui/api/yolo-mode', { repos: { [REPO]: true } }, { token })).status).toBe(200);
  const issue = gh.createIssue({ repo: REPO, body: `${JSON.stringify({ op: 'propose', message: THREE_PATHS })}\n\nPaint the shed.`, labels: ['hopper'] });
  await app.sync();
  const parent = (await jobs(app)).find((j) => j.source?.key === issue.url)!;
  const p = await waitFor(async () => (await app.api<{ items: ReviewItemView[] }>('GET', '/api/proposals')).body.items
    .find((x) => x.jobId === parent.id && x.stage === 'human'), { what: 'the proposal for a person' });
  expect((await app.ui(`/ui/api/proposals/${p.id}/accept`, { paths: [{ id: '1' }] }, { token })).status).toBe(200);
  const followOn = await waitFor(async () => (await jobs(app)).find((j) => j.followOn?.jobId === parent.id), { what: 'the follow-on' });
  return { issue, parent, followOn };
}

describe('a proposal\'s follow-on works its parent\'s issue (issue #859)', () => {
  it('a follow-on that ends with no pull request fails; the issue is not done, and the parent follows nothing', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const { issue, parent, followOn } = await selected(gh, app);
    expect(followOn.source).toMatchObject({ repo: REPO, number: issue.number, key: issue.url });

    const failed = await app.waitForStatus(followOn.id, 'failed');
    expect(failed.error).toMatch(/^not complete: /);
    await app.waitForStatus(parent.id, 'finished');
    await app.sync();
    await waitFor(async () => gh.issue(REPO, issue.number).labels.includes('hopper:failed'), { what: 'the follow-on\'s end on the issue' });
    expect(gh.issue(REPO, issue.number)).toMatchObject({ state: 'open' });
    expect(gh.issue(REPO, issue.number).labels).not.toContain('hopper:pr-ready');
    expect(gh.issue(REPO, issue.number).labels).not.toContain('hopper:done');
    expect((await followOf(app, parent.id))?.follow).toBeUndefined();
  });

  it('a follow-on that opens its pull request on the parent\'s issue is finished, and yolo mode merges it', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    let url = '';
    app.scripted.ships((job) => {
      if (job.followOn) url = gh.openPullRequest(job.source!.repo!, job.source!.number!, { createdAt: new Date().toISOString(), checks: 'pending' }).url;
    });
    const { issue, parent, followOn } = await selected(gh, app);

    await app.waitForStatus(followOn.id, 'finished');
    await waitFor(async () => (await followOf(app, followOn.id))?.follow === 'open', { what: 'the follow-on follows its pull request' });
    expect(await followOf(app, followOn.id)).toMatchObject({ follow: 'open', pullRequest: url });
    expect(gh.issue(REPO, issue.number).labels).toContain('hopper:pr-ready');
    expect((await followOf(app, parent.id))?.follow).toBeUndefined();

    gh.setChecks(url, 'passing');
    await app.sync();
    await waitFor(() => gh.issue(REPO, issue.number).state === 'closed', { what: 'the hopper merged it' });
    await waitFor(() => gh.issue(REPO, issue.number).labels.includes('hopper:done'), { what: 'the issue done' });
  });
});
