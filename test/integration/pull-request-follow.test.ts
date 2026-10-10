// After done, end to end (issue #579): the issue shows a job's pull request as ready, and the hopper follows it —
// merged, the item is done; closed without a merge, it is flagged. A job that ships part of its issue ends partly done,
// and the next part runs once that part is merged. A job that failed only because its pull request was not merged,
// waiting on a person, is finished once its pull request is ready, and its hand-off closes. Real daemon, in-memory
// fake GitHub at the GitHubApi seam; issues carry a scripted-executor op as their first body line.
import { afterEach, describe, expect, it } from 'vitest';
import type { FailuresView, Job } from '../../src/domain/types.ts';
import { createFakeGitHub, type FakeGitHub } from '../../src/sources/index.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { connectGitHub } from '../support/github-account.ts';
import { opensPartPullRequest, opensPullRequest } from '../support/scripted-executor.ts';
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
const labelled = (gh: FakeGitHub, n: number, label: string) => waitFor(() => gh.issue(REPO, n).labels.includes(label), { what: label });
const prOf = (job: Job) => String((job.sourceState?.source as { pullRequest?: string } | undefined)?.pullRequest);

async function doneWithPullRequest(gh: FakeGitHub, app: TestApp, ships = opensPullRequest) {
  const issue = gh.createIssue({ repo: REPO, body: body({ op: 'echo' }), labels: ['hopper'] });
  app.scripted.ships(ships(gh));
  await app.sync();
  const [job] = await jobsFor(app, issue.url);
  const finished = await app.waitForStatus(job!.id, 'finished');
  return { issue, job: finished };
}

describe('the pull request after done', () => {
  it('ready for review: the issue says hopper:pr-ready; merged, hopper:done, recorded', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const { issue, job } = await doneWithPullRequest(gh, app);
    await labelled(gh, issue.number, 'hopper:pr-ready');
    expect(gh.issue(REPO, issue.number).labels).not.toContain('hopper:done');
    const url = prOf(await app.job(job.id));
    gh.mergePullRequest(url);
    await app.sync();
    await labelled(gh, issue.number, 'hopper:done');
    expect(gh.issue(REPO, issue.number).labels).not.toContain('hopper:pr-ready');
    const merged = await app.events('types=job.pull_request_merged');
    expect(merged.map((e) => [e.jobId, e.data])).toEqual([[job.id, { pullRequest: url, part: false }]]);
    await app.sync();
    expect(await app.events('types=job.pull_request_merged')).toHaveLength(1);
  });

  it('closed without a merge: hopper:pr-closed, recorded; the job stays finished', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const { issue, job } = await doneWithPullRequest(gh, app);
    await labelled(gh, issue.number, 'hopper:pr-ready');
    const url = prOf(await app.job(job.id));
    gh.closePullRequest(url);
    await app.sync();
    await labelled(gh, issue.number, 'hopper:pr-closed');
    expect((await app.events('types=job.pull_request_closed')).map((e) => [e.jobId, e.data])).toEqual([[job.id, { pullRequest: url, part: false }]]);
    expect((await app.job(job.id)).status).toBe('finished');
  });

  it('a part: the job ends partly done, never failed; merged, the next part runs', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const { issue, job } = await doneWithPullRequest(gh, app, opensPartPullRequest);
    expect(job.partlyDone).toMatch(/\/pull\/\d+$/);
    const [finished] = (await app.events('types=job.finished')).filter((e) => e.jobId === job.id);
    expect(finished!.data.partlyDone).toBe(job.partlyDone);
    await labelled(gh, issue.number, 'hopper:partly-done');
    await app.sync();
    expect(await jobsFor(app, issue.url)).toHaveLength(1);
    gh.mergePullRequest(job.partlyDone!);
    await app.sync();
    await waitFor(() => !gh.issue(REPO, issue.number).labels.includes('hopper:partly-done'), { what: 'hopper:partly-done gone' });
    await app.sync();
    const jobs = await waitFor(async () => { const j = await jobsFor(app, issue.url); return j.length === 2 ? j : undefined; }, { what: 'the next part queued' });
    expect(jobs.map((j) => j.id)).toContain(job.id);
    expect((await app.events('types=job.pull_request_merged')).map((e) => e.data)).toEqual([{ pullRequest: job.partlyDone, part: true }]);
  });

  it('a job that failed only for want of a merged pull request, handed to a person: finished once its pull request is ready; the hand-off closes', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const issue = gh.createIssue({ repo: REPO, body: body({ op: 'echo' }), labels: ['hopper'] });
    await app.sync();
    const [job] = await jobsFor(app, issue.url);
    const failed = await app.waitForStatus(job!.id, 'failed');
    expect(failed.error).toMatch(/^not complete:/);
    await labelled(gh, issue.number, 'hopper:failed');
    const failures = async () => (await app.api<FailuresView>('GET', '/api/failures')).body;
    await waitFor(async () => (await failures()).handoffs.some((h) => h.jobId === job!.id && h.status === 'open'), { what: 'handed off' });
    gh.openPullRequest(REPO, issue.number, { createdAt: new Date().toISOString() });
    await app.sync();
    await app.waitForStatus(job!.id, 'finished');
    await labelled(gh, issue.number, 'hopper:pr-ready');
    expect(gh.issue(REPO, issue.number).labels).not.toContain('hopper:failed');
    await waitFor(async () => (await failures()).handoffs.every((h) => h.jobId !== job!.id || h.status === 'closed'), { what: 'the hand-off closed' });
  });
  it('a done-check miss whose source is done when the assessor looks (issue #637): finished, its record resolved, no hand-off', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const issue = gh.createIssue({ repo: REPO, body: body({ op: 'fail', message: 'not complete: GitHub did not list the pull request yet', ms: 0 }), labels: ['hopper'] });
    gh.openPullRequest(REPO, issue.number, { createdAt: new Date().toISOString() });
    await app.sync();
    const [job] = await jobsFor(app, issue.url);
    await app.waitForStatus(job!.id, 'finished');
    const failures = (await app.api<FailuresView>('GET', '/api/failures')).body;
    expect(failures.recent.filter((r) => r.jobId === job!.id).map((r) => [r.outcome, r.decision])).toEqual([['resolved', 'person']]);
    expect(failures.handoffs.filter((h) => h.jobId === job!.id)).toEqual([]);
    await labelled(gh, issue.number, 'hopper:pr-ready');
  });
});
