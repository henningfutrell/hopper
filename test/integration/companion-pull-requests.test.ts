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
/** A repository the hopper does not work on (issue #2752): no job source lists it. */
const OTHER = 'owner/elsewhere';
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

  it('its second pull request in another repository that gets merge conflicts is rebased there too (issue #2752)', async () => {
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
      companion = gh.openUnlinkedPullRequest(OTHER, { createdAt, headRef: 'issue-1-app-change', base: 'main' }).url;
      for (const [i, [repo, url]] of [[REPO, main], [OTHER, companion]].entries()) {
        app.user().store.events.append({ type: 'github_proxy.done', jobId: j.id, data: { requestId: `r${i}`, op: 'pr.create', repo, number: Number(url!.split('/').at(-1)), url } });
      }
    });
    await app.sync();
    const [job] = await jobsFor(app, issue.url);
    await app.waitForStatus(job!.id, 'finished');
    await waitFor(async () => (await app.job(job!.id)).sourceState?.source?.pullRequest === main, { what: 'the job follows its pull request in its own repository' });
    await app.sync();
    expect(await jobsFor(app, issue.url)).toHaveLength(1);

    gh.setConflicting(companion!, true);
    await app.sync();
    const tender = await waitFor(async () => (await jobsFor(app, issue.url))[1], { what: 'a tend job' });
    expect(tender.rerunOf).toBe(job!.id);
    await app.waitForStatus(tender.id, 'finished');
    expect(String(app.scripted.payloads.at(-1)!.prompt)).toContain(tendBrief(companion!, 'rebase'));
    expect((await app.events('types=job.pull_request_tended')).map((e) => [e.jobId, e.data])).toEqual([[job!.id, { pullRequest: companion, step: 'rebase', nextJobId: tender.id }]]);
    // As on a followed pull request in another repository: the tend note goes only on one of the issue's repository.
    expect(gh.pullRequestComments(companion!)).toEqual([]);
  });

  /** A finished job that follows its pull request in its own repository, and holds a ready one in OTHER. */
  async function readyCompanion(app: TestApp, gh: FakeGitHub): Promise<{ job: Job; companion: string }> {
    const issue = gh.createIssue({ repo: REPO, body: body({ op: 'echo' }), labels: ['hopper'] });
    let main: string | undefined;
    let companion: string | undefined;
    app.scripted.ships((j) => {
      const createdAt = new Date().toISOString();
      main = gh.openPullRequest(REPO, j.source!.number!, { createdAt, base: 'main', checks: 'pending' }).url;
      companion = gh.openUnlinkedPullRequest(OTHER, { createdAt, headRef: 'issue-1-app-change', base: 'main', checks: 'pending' }).url;
      for (const [i, [repo, url]] of [[REPO, main], [OTHER, companion]].entries()) {
        app.user().store.events.append({ type: 'github_proxy.done', jobId: j.id, data: { requestId: `r${i}`, op: 'pr.create', repo, number: Number(url!.split('/').at(-1)), url } });
      }
    });
    await app.sync();
    const [job] = await jobsFor(app, issue.url);
    await app.waitForStatus(job!.id, 'finished');
    await waitFor(async () => (await app.job(job!.id)).sourceState?.source?.pullRequest === main, { what: 'the job follows its pull request in its own repository' });
    gh.setChecks(companion!, 'passing');
    return { job: job!, companion: companion! };
  }

  const merges = (gh: FakeGitHub) => gh.calls.filter((c) => c.method === 'merge').map((c) => c.args);

  it('its ready second pull request in another repository is merged there under that repository\'s yolo mode (issue #2752)', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const token = await app.login();
    expect((await app.ui('/ui/api/yolo-mode', { repos: { [OTHER]: true } }, { token })).status).toBe(200);
    const { job, companion } = await readyCompanion(app, gh);
    await app.sync();
    await waitFor(async () => merges(gh).length > 0, { what: 'the hopper merges the companion' });
    expect(merges(gh)).toEqual([[OTHER, Number(companion.split('/').at(-1))]]);
    await waitFor(async () => (await app.events('types=job.companion_merged')).length > 0, { what: 'the merge is recorded' });
    expect((await app.events('types=job.companion_merged')).map((e) => [e.jobId, e.data])).toEqual([[job.id, { pullRequest: companion }]]);
    expect((await app.job(job.id)).sourceState?.source?.companions).toEqual({ [companion]: { conflicting: false, ended: true } });
    await app.sync();
    expect(merges(gh)).toHaveLength(1);
  });

  it('its companion that gets ready after the followed pull request merged and closed the issue is merged too (issue #2752)', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const token = await app.login();
    expect((await app.ui('/ui/api/yolo-mode', { repos: { [OTHER]: true } }, { token })).status).toBe(200);
    const { job, companion } = await readyCompanion(app, gh);
    gh.setChecks(companion, 'pending');
    gh.mergePullRequest(String((await app.job(job.id)).sourceState?.source?.pullRequest));
    gh.closeIssue(REPO, job.source!.number!, undefined, { reason: 'completed' });
    await waitFor(async () => { await app.sync(); return app.user().store.workItems.get(job.source!.key)?.state === 'done'; }, { what: 'the item is done' });
    expect(merges(gh)).toEqual([]);
    gh.setChecks(companion, 'passing');
    await waitFor(async () => { await app.sync(); return merges(gh).length > 0; }, { what: 'the hopper merges the companion' });
    expect(merges(gh)).toEqual([[OTHER, Number(companion.split('/').at(-1))]]);
  });

  it('with yolo mode not on for that repository, it is not merged (issue #2752)', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const { job, companion } = await readyCompanion(app, gh);
    await app.sync();
    await waitFor(async () => ((await app.job(job.id)).sourceState?.source?.companions as Record<string, unknown> | undefined)?.[companion] !== undefined, { what: 'the companion is read' });
    await app.sync();
    expect(merges(gh)).toEqual([]);
    expect(await app.events('types=job.companion_merged')).toEqual([]);
  });
});
