// Operator-led work (issue #318): a person — at a terminal, or in an IDE the hopper has no pane in —
// takes a waiting job by hand. The UI claims it as operator-led (job.claimed_by_operator); the
// decider never runs it; the job is done when its closing pull request reaches the completion, as
// any job's work is. Real daemon, in-memory fake GitHub at the GitHubApi seam.
import { afterEach, describe, expect, it } from 'vitest';
import type { Job } from '../../src/domain/types.ts';
import { createFakeGitHub, type FakeGitHub } from '../../src/sources/index.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';
import { connectGitHub } from '../support/github-account.ts';

const REPO = 'owner/hopper-sandbox';
const apps: TestApp[] = [];
let cleanup: (() => void) | undefined;

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  cleanup?.();
});

async function boot(gh: FakeGitHub) {
  const db = tempDbPath();
  cleanup = db.cleanup;
  const plugins = {
    machines: lanes(1),
    jobSources: [{ name: 'github', plugin: 'github-account', options: {
      enabled: true, pollSeconds: 3600, authors: ['owner'], executor: 'scripted', defaultCwd: '/tmp',
    } }],
  };
  const a = await startTestApp({ dbPath: db.dbPath, env: {}, seams: { github: gh }, plugins });
  apps.push(a);
  connectGitHub(a, [REPO]);
  const token = await a.login();
  // Review: a new job waits for the user, so it is still waiting when the operator takes it.
  expect((await a.ui('/ui/api/queue-gate', { mode: 'review', autoAcceptPerHour: null }, { token })).status).toBe(200);
  return { a, token };
}

const jobFor = async (a: TestApp, url: string): Promise<Job> =>
  (await a.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs.find((j) => j.source?.key === url)!;

async function waitingJob(a: TestApp, gh: FakeGitHub) {
  const issue = gh.createIssue({ repo: REPO, body: '{"op":"echo"}\n\nDo the thing.', labels: ['hopper'] });
  await a.sync();
  const job = await jobFor(a, issue.url);
  await a.waitForStatus(job.id, 'held');
  return { issue, job };
}

const claim = (a: TestApp, token: string, id: string) => a.ui<Job>(`/ui/api/jobs/${id}/operator-led`, {}, { token });

describe('operator-led work', () => {
  it('the UI claims a waiting job as operator-led: claimed on its issue, on no lane, never run', async () => {
    const gh = createFakeGitHub();
    const { a, token } = await boot(gh);
    const { issue, job } = await waitingJob(a, gh);

    const r = await claim(a, token, job.id);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'operator_led', accepted: true });
    expect(r.body.laneId).toBeUndefined();
    expect(r.body.startedAt).toBeDefined();
    const claimed = await a.events('types=job.claimed_by_operator');
    expect(claimed.map((e) => [e.jobId, e.data])).toEqual([[job.id, {}]]);
    expect(gh.issue(REPO, issue.number).labels).toContain('hopper:claimed');
    expect((await a.api('GET', '/api/queue')).body.operatorLed.map((j: Job) => j.id)).toEqual([job.id]);

    await a.sync();
    expect(await a.events('types=job.started')).toEqual([]);
    expect((await a.job(job.id)).status).toBe('operator_led');
  });

  it('done is the closing pull request: an open one is not enough at merge completion, the merge finishes the job', async () => {
    const gh = createFakeGitHub();
    const { a, token } = await boot(gh);
    const { issue, job } = await waitingJob(a, gh);
    await claim(a, token, job.id);

    gh.openPullRequest(REPO, issue.number, { createdAt: new Date().toISOString() });
    await a.sync();
    expect((await a.job(job.id)).status).toBe('operator_led');

    const now = new Date().toISOString();
    gh.closeByPullRequest(REPO, issue.number, { createdAt: now, mergedAt: now });
    await a.sync();
    const done = await a.waitForStatus(job.id, 'finished');
    expect(done.finishedAt).toBeDefined();
    await waitFor(() => gh.issue(REPO, issue.number).labels.includes('hopper:done'), { what: 'hopper:done' });
    expect(gh.issue(REPO, issue.number).labels).not.toContain('hopper:claimed');
  });

  it('an issue closed by a person cancels the operator-led job, and the claim comes off', async () => {
    const gh = createFakeGitHub();
    const { a, token } = await boot(gh);
    const { issue, job } = await waitingJob(a, gh);
    await claim(a, token, job.id);

    gh.closeIssue(REPO, issue.number);
    await a.sync();
    const cancelled = await a.waitForStatus(job.id, 'cancelled');
    expect(cancelled.status).toBe('cancelled');
    await waitFor(() => !gh.issue(REPO, issue.number).labels.includes('hopper:claimed'), { what: 'claim removed' });
  });

  it('only a waiting job can be claimed as operator-led; an unknown one is not found', async () => {
    const gh = createFakeGitHub();
    const { a, token } = await boot(gh);
    const { job } = await waitingJob(a, gh);
    await claim(a, token, job.id);
    expect((await claim(a, token, job.id)).status).toBe(409);
    expect((await a.ui(`/ui/api/jobs/${job.id}/cancel`, {}, { token })).status).toBe(200);
    expect((await claim(a, token, job.id)).status).toBe(409);
    expect((await claim(a, token, 'missing')).status).toBe(404);
  });
});
