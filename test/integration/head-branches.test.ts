// Head branch deletion (issue #2914), real daemon, real database, the in-memory fake GitHub at the GitHubApi seam: a merged job
// pull request leaves no branch, also when the hopper stops after its merge call and before it records the merge; the setting,
// on by default, is an admin's and stops the deletion.
import { afterEach, describe, expect, it } from 'vitest';
import type { Job } from '../../src/domain/types.ts';
import { createFakeGitHub, type FakeGitHub } from '../../src/sources/index.ts';
import { GitHubApiError, type GitHubApi } from '../../src/sources/github/index.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { connectGitHub } from '../support/github-account.ts';
import { waitFor } from '../support/wait.ts';

const REPO = 'owner/hopper-sandbox';
const apps: TestApp[] = [];
let cleanup: (() => void) | undefined;

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  cleanup?.();
});

async function boot(dbPath: string, github: GitHubApi): Promise<TestApp> {
  const plugins = { jobSources: [{ name: 'github', plugin: 'github-account', options: { enabled: true, pollSeconds: 3600, executor: 'scripted' } }] };
  const a = await startTestApp({ dbPath, env: {}, seams: { github }, plugins });
  apps.push(a);
  connectGitHub(a, [REPO]);
  return a;
}

const jobFor = async (app: TestApp, url: string): Promise<Job> =>
  (await app.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs.find((j) => j.source?.key === url)!;

/** A finished job whose open pull request, on `headRef`, is ready to merge. */
async function shipped(gh: FakeGitHub, app: TestApp, headRef: string) {
  const issue = gh.createIssue({ repo: REPO, body: `${JSON.stringify({ op: 'echo' })}\n\nPlease do the thing.`, labels: ['hopper'] });
  let url = '';
  app.scripted.ships((job) => { if (job.source?.key === issue.url) url = gh.openPullRequest(REPO, issue.number, { createdAt: new Date().toISOString(), checks: 'pending', headRef, base: 'main' }).url; });
  await app.sync();
  const job = await app.waitForStatus((await jobFor(app, issue.url)).id, 'finished');
  await waitFor(() => gh.issue(REPO, issue.number).labels.includes('hopper:pr-ready'), { what: 'hopper:pr-ready' });
  return { issue, job, url };
}

const yolo = async (a: TestApp) => { expect((await a.ui('/ui/api/yolo-mode', { repos: { [REPO]: true } }, { token: await a.login() })).status).toBe(200); };

describe('head branch deletion (issue #2914)', () => {
  it('a job pull request the hopper merges leaves no branch, and the deletion is recorded once', async () => {
    const db = tempDbPath(); cleanup = db.cleanup;
    const gh = createFakeGitHub();
    const app = await boot(db.dbPath, gh);
    await yolo(app);
    const { url } = await shipped(gh, app, 'hopper/1-fix');
    expect(gh.hasBranch(REPO, 'hopper/1-fix')).toBe(true);
    gh.setChecks(url, 'passing');
    await app.sync();
    await waitFor(() => !gh.hasBranch(REPO, 'hopper/1-fix'), { what: 'the head branch deleted' });
    await waitFor(async () => (await app.events('types=head_branch.deleted')).length === 1, { what: 'its event' });
    expect((await app.events('types=head_branch.deleted'))[0]!.data).toMatchObject({ repo: REPO, branch: 'hopper/1-fix', pullRequest: url, via: 'merge' });
  });

  it('a stop after the merge call and before its record: the next start leaves no branch', async () => {
    const db = tempDbPath(); cleanup = db.cleanup;
    const gh = createFakeGitHub();
    // The merge goes through on GitHub, and its answer is lost.
    const lost = new Proxy(gh, {
      get(target, prop, receiver) {
        const v = Reflect.get(target, prop, receiver) as unknown;
        if (prop !== 'merge') return v;
        return async (repo: string, n: number) => { await gh.merge(repo, n); throw new GitHubApiError('socket hang up', false); };
      },
    });
    const first = await boot(db.dbPath, lost);
    await yolo(first);
    const { url } = await shipped(gh, first, 'hopper/2-fix');
    gh.setChecks(url, 'passing');
    void first.sync().catch(() => undefined);
    await waitFor(() => gh.calls.some((c) => c.method === 'merge'), { what: 'the merge call' });
    await first.stop();
    apps.splice(0);
    expect(gh.hasBranch(REPO, 'hopper/2-fix')).toBe(true);
    const second = await boot(db.dbPath, gh);
    await second.sync();
    await waitFor(() => !gh.hasBranch(REPO, 'hopper/2-fix'), { what: 'the head branch deleted after the restart' });
  });

  it('is on by default, an admin turns it off per repository, and then a merge keeps its branch', async () => {
    const db = tempDbPath(); cleanup = db.cleanup;
    const gh = createFakeGitHub();
    const app = await boot(db.dbPath, gh);
    await yolo(app);
    expect((await app.api<{ repos: Record<string, boolean> }>('GET', '/api/head-branches')).body.repos).toEqual({});
    const r = await app.ui('/ui/api/head-branches', { repos: { [REPO]: false } }, { token: await app.login() });
    expect(r.status).toBe(200);
    expect((await app.api<{ repos: Record<string, boolean> }>('GET', '/api/head-branches')).body.repos).toEqual({ [REPO]: false });
    expect(await app.events('types=head_branches.changed')).toHaveLength(1);
    expect((await app.ui('/ui/api/head-branches', { repos: { [REPO]: true } })).status).toBe(403);
    const { url, issue } = await shipped(gh, app, 'hopper/3-fix');
    gh.setChecks(url, 'passing');
    await app.sync();
    await waitFor(() => gh.issue(REPO, issue.number).labels.includes('hopper:done'), { what: 'the merge recorded' });
    await app.sync();
    expect(gh.hasBranch(REPO, 'hopper/3-fix')).toBe(true);
    expect(gh.calls.filter((c) => c.method === 'deleteBranch')).toEqual([]);
  });

  it('the sync loop sweeps: a branch of a pull request merged long ago goes, and one with commits after its merge stays', async () => {
    const db = tempDbPath(); cleanup = db.cleanup;
    const gh = createFakeGitHub();
    const app = await boot(db.dbPath, gh);
    gh.createIssue({ repo: REPO, body: `${JSON.stringify({ op: 'echo' })}\n\nA job repository to scan.`, labels: ['hopper'] });
    const old = new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString();
    const stale = gh.openUnlinkedPullRequest(REPO, { createdAt: old, headRef: 'old-merged', headOid: 'a1' });
    const moved = gh.openUnlinkedPullRequest(REPO, { createdAt: old, headRef: 'old-moved', headOid: 'b1' });
    gh.mergePullRequest(stale.url, old);
    gh.mergePullRequest(moved.url, old);
    gh.setBranch(REPO, 'old-moved', { tip: 'c1' });
    // The first sync's discover names the job repositories; the next sweeps them.
    await app.sync();
    await app.sync();
    await waitFor(() => !gh.hasBranch(REPO, 'old-merged'), { what: 'the stale branch deleted' });
    expect(gh.hasBranch(REPO, 'old-moved')).toBe(true);
    expect((await app.events('types=head_branch.deleted')).map((e) => e.data)).toMatchObject([{ branch: 'old-merged', via: 'sweep' }]);
  });

  it('a wrong body is refused', async () => {
    const db = tempDbPath(); cleanup = db.cleanup;
    const app = await boot(db.dbPath, createFakeGitHub());
    expect((await app.ui('/ui/api/head-branches', { repos: { 'not a repo': true } }, { token: await app.login() })).status).toBe(400);
  });
});
