// A done item's companion pull request (issue #1143 reopened): a job opened two pull requests, its followed one merged and
// closed the issue, and the other one gets merge conflicts later. A tend would run the item again and reopen its issue, so
// the hopper merges the base branch in its own mirror first, and when that cannot resolve the conflicts it files one rebase
// issue on the item's repository, with the hopper label and assigned to the connected account, so Intake takes it as any
// other work. The item's issue stays closed. Real daemon, in-memory fake GitHub at the GitHubApi seam.
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
  (await app.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs.filter((j) => j.source?.key === url);

/** A finished job whose followed pull request merged and closed its issue, and whose companion is still open. */
async function doneWithCompanion(app: TestApp, gh: FakeGitHub): Promise<{ job: Job; issue: number; companion: string }> {
  const issue = gh.createIssue({ repo: REPO, body: body({ op: 'echo' }), labels: ['hopper'] });
  let main: string | undefined;
  let companion: string | undefined;
  app.scripted.ships((j) => {
    const createdAt = new Date().toISOString();
    main = gh.openPullRequest(REPO, j.source!.number!, { createdAt, base: 'main' }).url;
    companion = gh.openUnlinkedPullRequest(REPO, { createdAt, headRef: 'issue-1-bookkeeping', base: 'main', headOid: 'a'.repeat(40) }).url;
    for (const [i, url] of [main, companion].entries()) {
      app.user().store.events.append({ type: 'github_proxy.done', jobId: j.id, data: { requestId: `r${i}`, op: 'pr.create', repo: REPO, number: Number(url.split('/').at(-1)), url } });
    }
  });
  await app.sync();
  const [job] = await jobsFor(app, issue.url);
  await app.waitForStatus(job!.id, 'finished');
  await waitFor(async () => (await app.job(job!.id)).sourceState?.source?.pullRequest === main, { what: 'the job follows its first pull request' });
  gh.mergePullRequest(main!);
  gh.closeIssue(REPO, issue.number, undefined, { reason: 'completed' });
  await waitFor(async () => { await app.sync(); return app.user().store.workItems.get(issue.url)?.state === 'done'; }, { what: 'the item is done' });
  return { job: job!, issue: issue.number, companion: companion! };
}

const filed = async (app: TestApp) => (await app.events('types=job.companion_rebase_filed')).map((e) => [e.jobId, e.data]);

describe('a done item\'s companion pull request with merge conflicts (issue #1143 reopened)', () => {
  it('gets one rebase issue that Intake takes, and the item\'s issue stays closed', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const { job, issue, companion } = await doneWithCompanion(app, gh);
    gh.setBaseMerge(companion, { conflicts: ['notes.md'] });
    gh.setConflicting(companion, true);

    await waitFor(async () => { await app.sync(); return (await filed(app)).length > 0; }, { what: 'the rebase issue is filed' });
    const rebase = gh.issue(REPO, issue + 1);
    expect(await filed(app)).toEqual([[job.id, { pullRequest: companion, issue: rebase.number, url: rebase.url }]]);
    expect(rebase.title).toBe(`Rebase #${companion.split('/').at(-1)} onto main`);
    expect(rebase.body).toContain(companion);
    expect(rebase.labels).toEqual(['hopper']);
    expect(rebase.assignees).toEqual(['owner']);
    expect(gh.calls.some((c) => c.method === 'baseMerge')).toBe(true);
    // No tend: the item is not run again, and its issue stays closed.
    expect(gh.issue(REPO, issue).state).toBe('closed');
    expect(await jobsFor(app, `https://github.com/${REPO}/issues/${issue}`)).toHaveLength(1);
    expect(app.user().store.workItems.get(`https://github.com/${REPO}/issues/${issue}`)?.state).toBe('done');

    // Once for its head commit.
    await app.sync();
    await app.sync();
    expect(await filed(app)).toHaveLength(1);
  });

  it('a base merge that resolves the conflicts files no issue', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const { job, companion } = await doneWithCompanion(app, gh);
    gh.setBaseMerge(companion, { resolved: ['notes.md'] });
    gh.setConflicting(companion, true);

    await waitFor(async () => { await app.sync(); return (await app.events('types=job.pull_request_base_merged')).length > 0; }, { what: 'the base merge' });
    expect((await app.events('types=job.pull_request_base_merged'))[0]).toMatchObject({ jobId: job.id, data: { pullRequest: companion, resolved: ['notes.md'] } });
    await app.sync();
    expect(await filed(app)).toEqual([]);
  });
});
