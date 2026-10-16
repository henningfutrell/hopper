// Pull request housekeeping (issue #1143), over the real daemon: a tend job started is said on its pull request; a job's
// pull request off the landing branch is moved to it and recorded (`job.pull_request_retargeted`); one superseded by another
// pull request that closed its issue is closed, and the close is recorded with why. In-memory fake GitHub at the GitHubApi
// seam; issues carry a scripted-executor op as their first body line. A rebase held behind other heads for an hour is tended
// anyway (`MAX_HELD_MS`), as new heads keep coming. A stray pull request (part 4: a job named it, no job follows it, and no
// job of its item works on it) gets the same housekeeping, recorded with `stray`; one closed or merged on GitHub is recorded as ended (issue #1420).
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_HELD_MS } from '../../src/domain/tending-queue.ts';
import type { Job, JobGraph } from '../../src/domain/types.ts';
import { createFakeGitHub, type FakeGitHub } from '../../src/sources/index.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { connectGitHub } from '../support/github-account.ts';
import { waitFor } from '../support/wait.ts';
import { retargetNote, supersededNote, tendNote } from '../../src/sources/github/pr-notes.ts';

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
    // The landing branch is the landing batch setting's (issue #1142), never GitHub's default branch.
    expect((await app.ui('/ui/api/landing-batches', { repos: { [REPO]: { tested: 'beta', landing: 'main' } } }, { token: await app.login() })).status).toBe(200);
    const { job, url } = await pullRequestWaiting(gh, app, () => undefined);
    await app.sync();
    await waitFor(async () => (await app.events('types=job.pull_request_retargeted')).length > 0, { what: 'job.pull_request_retargeted' });
    expect((await app.events('types=job.pull_request_retargeted')).map((e) => [e.jobId, e.data])).toEqual([[job.id, { pullRequest: url, from: 'dev', to: 'main' }]]);
    expect(gh.pullRequestComments(url)).toEqual([retargetNote('dev', 'main')]);
  });

  it('a rebase held behind a head for an hour is tended anyway, and says so on its pull request', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    expect((await app.ui('/ui/api/yolo-mode', { repos: { [REPO]: true } }, { token: await app.login() })).status).toBe(200);
    // The head: on its way to the hopper's merge, its checks running. Git cannot say whether the two conflict: they do.
    const head = await pullRequestWaiting(gh, app, () => undefined);
    const held = await pullRequestWaiting(gh, app, (pr) => gh.pushToPullRequest(pr, new Date().toISOString()));
    gh.pushToPullRequest(head.url, new Date().toISOString());
    gh.setChecks(head.url, 'pending');
    gh.setConflicting(held.url, true);
    await app.sync();
    type Holds = { heldBehind?: unknown; heldSince?: string };
    const holds = async (): Promise<Holds> => (await app.job(held.job.id)).sourceState?.source as Holds;
    expect((await holds()).heldBehind).toEqual({ pullRequest: head.url, why: 'merging' });
    expect(Date.now() - Date.parse((await holds()).heldSince!)).toBeLessThan(60_000);
    expect(await app.events('types=job.pull_request_tended')).toEqual([]);
    // Held since longer than the limit: it is tended now, whatever holds it.
    const store = app.user().store;
    const s = store.jobs.get(held.job.id)!.sourceState!;
    store.jobs.update(held.job.id, { sourceState: { ...s, source: { ...s.source, heldSince: new Date(Date.now() - MAX_HELD_MS - 1000).toISOString() } } });
    await app.sync();
    const tender = await nextJob(app, held.issue.url, 2);
    await app.waitForStatus(tender!.id, 'finished');
    expect((await app.events('types=job.pull_request_tended')).map((e) => [e.jobId, (e.data as { step: string }).step])).toEqual([[held.job.id, 'rebase']]);
    expect(await holds()).not.toHaveProperty('heldSince');
    expect(gh.pullRequestComments(held.url)).toEqual([tendNote('rebase')]);
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
  /** Make the job's pull request a stray: a tend took it, and no job follows it now (its tend job ended with none). */
  function stray(app: TestApp, jobId: string): void {
    const store = app.user().store;
    const s = store.jobs.get(jobId)!.sourceState!;
    store.jobs.update(jobId, { sourceState: { ...s, source: { ...s.source, follow: 'tended' } } });
  }

  it('a stray pull request superseded by another that closed its issue: closed, said on it, and recorded as a stray', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const { issue, job, url } = await pullRequestWaiting(gh, app, () => undefined);
    stray(app, job.id);
    const now = new Date().toISOString();
    const other = gh.closeByPullRequest(REPO, issue.number, { createdAt: now, mergedAt: now });
    await app.sync();
    await waitFor(async () => (await app.events('types=job.pull_request_closed')).length > 0, { what: 'job.pull_request_closed' });
    const why = `its issue was closed by ${other.url}`;
    expect((await app.events('types=job.pull_request_closed')).map((e) => [e.jobId, e.data]))
      .toEqual([[job.id, { pullRequest: url, part: false, superseded: why, stray: true }]]);
    expect(gh.pullRequestComments(url)).toEqual([supersededNote(why)]);
    expect((await app.job(job.id)).sourceState?.source).toMatchObject({ follow: 'closed', pullRequest: url });
    // Closed, it is no stray: a later sync does nothing more.
    await app.sync();
    expect(await app.events('types=job.pull_request_closed')).toHaveLength(1);
  });

  it('a stray pull request off the landing branch: moved to it, said on it, and recorded as a stray', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const { job, url } = await pullRequestWaiting(gh, app, () => undefined);
    stray(app, job.id);
    expect((await app.ui('/ui/api/landing-batches', { repos: { [REPO]: { tested: 'beta', landing: 'main' } } }, { token: await app.login() })).status).toBe(200);
    await app.sync();
    await waitFor(async () => (await app.events('types=job.pull_request_retargeted')).length > 0, { what: 'job.pull_request_retargeted' });
    expect((await app.events('types=job.pull_request_retargeted')).map((e) => [e.jobId, e.data]))
      .toEqual([[job.id, { pullRequest: url, from: 'dev', to: 'main', stray: true }]]);
    expect(gh.pullRequestComments(url)).toEqual([retargetNote('dev', 'main')]);
    // On the landing branch now: a later sync does not move it again.
    await app.sync();
    expect(await app.events('types=job.pull_request_retargeted')).toHaveLength(1);
  });

  /** The job graph's view of the job and of its pull request (issue #1420). */
  async function graphOf(app: TestApp, jobId: string, url: string) {
    const graph = (await app.api<JobGraph>('GET', '/api/jobs/graph')).body;
    const node = (id: string) => graph.nodes.find((n) => n.id === id);
    return { job: node(`job:${jobId}`), pullRequest: node(`pr:${url}`) };
  }

  it('a stray pull request closed on GitHub without a merge: recorded closed, and the graph and Rework agree (issue #1420)', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const { job, url } = await pullRequestWaiting(gh, app, () => undefined);
    stray(app, job.id);
    gh.setConflicting(url, true);
    gh.closePullRequest(url);
    await app.sync();
    await waitFor(async () => (await app.events('types=job.pull_request_closed')).length > 0, { what: 'job.pull_request_closed' });
    expect((await app.events('types=job.pull_request_closed')).map((e) => [e.jobId, e.data]))
      .toEqual([[job.id, { pullRequest: url, part: false, stray: true }]]);
    expect((await app.job(job.id)).sourceState?.source).toMatchObject({ follow: 'closed', pullRequest: url });
    // The one record: the graph shows it closed, not open, conflicting or tended, and Rework finds no open pull request.
    const g = await graphOf(app, job.id, url);
    expect(g.job?.stage).toBe('done');
    expect(g.job?.pullRequest).toEqual({ url, state: 'closed' });
    expect(g.pullRequest?.stage).toBe('cancelled');
    const r = await app.ui(`/ui/api/jobs/${job.id}/rework`, { notes: 'Again.' }, { token: await app.login() });
    expect(r.status).toBe(409);
    expect(gh.pullRequestComments(url)).toEqual([]);
    // Closed, it is no stray: a later sync does nothing more.
    await app.sync();
    expect(await app.events('types=job.pull_request_closed')).toHaveLength(1);
  });

  it('a stray pull request merged on GitHub: recorded merged, as a stray (issue #1420)', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const { job, url } = await pullRequestWaiting(gh, app, () => undefined);
    stray(app, job.id);
    gh.mergePullRequest(url);
    await app.sync();
    await waitFor(async () => (await app.events('types=job.pull_request_merged')).length > 0, { what: 'job.pull_request_merged' });
    expect((await app.events('types=job.pull_request_merged')).map((e) => [e.jobId, e.data]))
      .toEqual([[job.id, { pullRequest: url, part: false, stray: true }]]);
    expect((await app.job(job.id)).sourceState?.source).toMatchObject({ follow: 'merged', pullRequest: url });
    expect((await graphOf(app, job.id, url)).pullRequest?.stage).toBe('done');
    await app.sync();
    expect(await app.events('types=job.pull_request_merged')).toHaveLength(1);
  });

  it('a stray pull request with work left to land, on the landing branch: left as it is', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const { job, url } = await pullRequestWaiting(gh, app, () => undefined);
    stray(app, job.id);
    await app.sync();
    await app.sync();
    expect(await app.events('types=job.pull_request_closed')).toEqual([]);
    expect(await app.events('types=job.pull_request_retargeted')).toEqual([]);
    expect(gh.pullRequestComments(url)).toEqual([]);
  });
});
