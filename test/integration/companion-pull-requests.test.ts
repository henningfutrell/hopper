// Companion pull requests (issue #1143 reopened): a job that changes two repositories opens a pull request in each, and the
// hopper follows one. Its other pull request in the item's own repository, opened through the hopper, gets merge conflicts
// after the job finished: the hopper rebases it with a tend job, without anyone commenting, and says so on it. Real daemon,
// in-memory fake GitHub at the GitHubApi seam; issues carry a scripted-executor op as their first body line.
import { afterEach, describe, expect, it } from 'vitest';
import { tendBrief, type Job } from '../../src/domain/types.ts';
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

describe('companion pull requests (issue #1143 reopened)', () => {
  it('a finished job\'s second pull request that gets merge conflicts is rebased by a tend job, and says so', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const issue = gh.createIssue({ repo: REPO, body: body({ op: 'echo' }), labels: ['hopper'] });
    let main: string | undefined;
    let companion: string | undefined;
    app.scripted.ships((j) => {
      if (main !== undefined) {
        gh.pushToPullRequest(companion!, new Date().toISOString());
        return;
      }
      const createdAt = new Date().toISOString();
      main = gh.openPullRequest(REPO, j.source!.number!, { createdAt, base: 'main' }).url;
      companion = gh.openUnlinkedPullRequest(REPO, { createdAt, headRef: 'bookkeeping-notes', base: 'main' }).url;
      // Both opened through the hopper's GitHub proxy, as a job opens them.
      for (const [i, url] of [main, companion].entries()) {
        app.user().store.events.append({ type: 'github_proxy.done', jobId: j.id, data: { requestId: `r${i}`, op: 'pr.create', repo: REPO, number: Number(url.split('/').at(-1)), url } });
      }
    });
    await app.sync();
    const [job] = await jobsFor(app, issue.url);
    await app.waitForStatus(job!.id, 'finished');
    await waitFor(async () => (await app.job(job!.id)).sourceState?.source?.pullRequest === main, { what: 'the job follows its first pull request' });
    await app.sync();
    expect(await jobsFor(app, issue.url)).toHaveLength(1);

    gh.setConflicting(companion!, true);
    await app.sync();
    const tender = await waitFor(async () => (await jobsFor(app, issue.url))[1], { what: 'a tend job' });
    expect(tender.rerunOf).toBe(job!.id);
    expect(tender.spec.tend).toBe(true);
    await app.waitForStatus(tender.id, 'finished');
    expect(String(app.scripted.payloads.at(-1)!.prompt)).toContain(tendBrief(companion!, 'rebase'));
    expect((await app.events('types=job.pull_request_tended')).map((e) => [e.jobId, e.data])).toEqual([[job!.id, { pullRequest: companion, step: 'rebase', nextJobId: tender.id }]]);
    expect(gh.pullRequestComments(companion!)).toEqual([tendNote('rebase')]);
    expect(gh.pullRequestComments(main!)).toEqual([]);

    // The tend job follows the item's pull request again; the rebased companion needs nothing more.
    await waitFor(async () => (await app.job(tender.id)).sourceState?.source?.follow === 'open', { what: 'the tend job follows a pull request' });
    expect((await app.job(tender.id)).sourceState?.source).toMatchObject({ pullRequest: main });
    await app.sync();
    await app.sync();
    expect(await jobsFor(app, issue.url)).toHaveLength(2);
  });
});
