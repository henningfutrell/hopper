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

  it('what the follow sees of the pull request — checks running, then the merge — is what its work item waits on (issue #1067)', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const { issue, job } = await doneWithPullRequest(gh, app);
    await labelled(gh, issue.number, 'hopper:pr-ready');
    const url = prOf(await app.job(job.id));
    const item = () => app.user().store.workItems.get(issue.url);
    gh.setChecks(url, 'pending');
    await app.sync();
    await waitFor(() => item()?.pullRequestWait === 'checks_running', { what: 'checks running' });
    expect(item()).toMatchObject({ state: 'pr_open', pullRequest: url, waitingOn: 'its checks to pass' });
    gh.setChecks(url, 'passing');
    await app.sync();
    await waitFor(() => item()?.pullRequestWait === 'merge', { what: 'waits on the merge' });
    const seen = (await app.events('types=job.pull_request_seen')).map((e) => e.data);
    expect(seen.slice(-2)).toEqual([{ pullRequest: url, wait: 'checks_running' }, { pullRequest: url, wait: 'merge' }]);
    // Seen the same again: nothing recorded.
    await app.sync();
    expect(await app.events('types=job.pull_request_seen')).toHaveLength(seen.length);
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

  it('a part merged before the job ended, the job judged done (issue #1231): its item leaves PR open, and the next part runs', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    let part = '';
    // The job's part merged while it ran, and a merged pull request that only refers to the issue made the job done: the
    // report names no pull request to follow.
    const ships = (g: FakeGitHub) => (job: Job): void => {
      if (part) return; // The next part ships nothing.
      const { repo, number } = job.source as { repo: string; number: number };
      const now = new Date().toISOString();
      part = g.openPartPullRequest(repo, number, { createdAt: now }).url;
      g.mergePullRequest(part, now);
      g.mergePullRequest(g.openReferencingPullRequest(repo, number, { createdAt: now }).url, now);
    };
    const { issue, job } = await doneWithPullRequest(gh, app, ships);
    expect(job.partlyDone).toBeUndefined();
    // No open pull request (issue #1891): never hopper:pr-ready with none, nor hopper:blocked (issue #2693); the follow looks again.
    await waitFor(() => !gh.issue(REPO, issue.number).labels.includes('hopper:claimed'), { what: 'the report out' });
    expect(gh.issue(REPO, issue.number).labels).not.toContain('hopper:pr-ready');
    expect(gh.issue(REPO, issue.number).labels).not.toContain('hopper:blocked');
    await app.sync();
    const item = () => app.user().store.workItems.get(issue.url);
    await waitFor(() => item()?.state === 'partly_done', { what: 'the item partly done' });
    expect(item()).toMatchObject({ pullRequest: part, pullRequestState: 'merged' });
    expect((await app.events('types=job.pull_request_merged')).map((e) => e.data)).toEqual([{ pullRequest: part, part: true }]);
    expect(gh.issue(REPO, issue.number).labels).not.toContain('hopper:blocked');
    await app.sync();
    await waitFor(async () => (await jobsFor(app, issue.url)).length === 2, { what: 'the next part queued' });
  });

  it('a part on a branch named for the issue (issue #721): partly done, never hopper:pr-ready; merged, never hopper:done, and the next part runs', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const onBranch = (job: Job): void => {
      gh.openPartPullRequest(REPO, job.source!.number!, { createdAt: new Date().toISOString(), headRef: `issue-${job.source!.number}-first-part` });
    };
    const { issue, job } = await doneWithPullRequest(gh, app, () => onBranch);
    expect(job.partlyDone).toMatch(/\/pull\/\d+$/);
    await labelled(gh, issue.number, 'hopper:partly-done');
    expect(gh.issue(REPO, issue.number).labels).not.toContain('hopper:pr-ready');
    gh.mergePullRequest(job.partlyDone!);
    await app.sync();
    await waitFor(() => !gh.issue(REPO, issue.number).labels.includes('hopper:partly-done'), { what: 'hopper:partly-done gone' });
    expect(gh.issue(REPO, issue.number)).toMatchObject({ state: 'open' });
    expect(gh.issue(REPO, issue.number).labels).not.toContain('hopper:done');
    await app.sync();
    await waitFor(async () => (await jobsFor(app, issue.url)).length === 2, { what: 'the next part queued' });
  });

  it('a part recorded as the whole issue before issue #721: checked once, hopper:done comes off and the next part runs', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const { issue, job } = await doneWithPullRequest(gh, app, opensPartPullRequest);
    await labelled(gh, issue.number, 'hopper:partly-done');
    // What a build before issue #721 left: the part merged, recorded as the whole issue, hopper:done on the open issue.
    gh.mergePullRequest(job.partlyDone!);
    gh.removeLabel(REPO, issue.number, 'hopper:partly-done');
    gh.addLabel(REPO, issue.number, 'hopper:done');
    const kept = app.user().store.jobs.get(job.id)!.sourceState;
    app.user().store.jobs.update(job.id, { sourceState: { ...kept, source: { pullRequest: job.partlyDone, follow: 'merged' } } });
    await app.sync();
    await waitFor(() => !gh.issue(REPO, issue.number).labels.includes('hopper:done'), { what: 'hopper:done gone' });
    expect((await app.events('types=job.pull_request_merged')).map((e) => [e.jobId, e.data])).toEqual([[job.id, { pullRequest: job.partlyDone, part: true }]]);
    await app.sync();
    await waitFor(async () => (await jobsFor(app, issue.url)).length === 2, { what: 'the next part queued' });
    await app.sync();
    expect(await app.events('types=job.pull_request_merged')).toHaveLength(1);
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
    const [assessed] = (await app.events('types=job.assessed')).filter((e) => e.jobId === job!.id);
    expect(assessed!.data).toMatchObject({ causeId: 'not-complete', decision: 'person' });
    expect(app.user().store.failures.forJob(job!.id)).toMatchObject({ outcome: 'resolved', note: expect.stringMatching(/^done at its source/) });
    expect((await app.events('types=handoff.opened')).filter((e) => e.jobId === job!.id)).toEqual([]);
    const failures = (await app.api<FailuresView>('GET', '/api/failures')).body;
    expect([...failures.recent, ...failures.handoffs].filter((r) => r.jobId === job!.id)).toEqual([]);
    await labelled(gh, issue.number, 'hopper:pr-ready');
  });
  it('a job that ends failed after it delivered (issue #2040): its source is asked, the job is finished, its record resolved', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const message = 'this machine cannot reach the hopper (HOPPER_GH is empty), so I cannot confirm the remote head of the branch';
    const issue = gh.createIssue({ repo: REPO, body: body({ op: 'fail', message, ms: 0 }), labels: ['hopper'] });
    gh.openPullRequest(REPO, issue.number, { createdAt: new Date().toISOString() });
    await app.sync();
    const [job] = await jobsFor(app, issue.url);
    await app.waitForStatus(job!.id, 'finished');
    expect(app.user().store.failures.forJob(job!.id)).toMatchObject({ outcome: 'resolved', note: expect.stringMatching(/^done at its source/) });
    expect((await app.events('types=handoff.opened')).filter((e) => e.jobId === job!.id)).toEqual([]);
    await labelled(gh, issue.number, 'hopper:pr-ready');
    expect(gh.issue(REPO, issue.number).labels).not.toContain('hopper:failed');
  });
});
