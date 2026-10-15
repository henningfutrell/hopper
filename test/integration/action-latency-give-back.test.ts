// The latency budget of the acts that give an item back (issue #1194, part 4): Failures' Retry, a hand-off's Continue
// and I fixed it, Push it and Tend again answer within the budget with GitHub slow; the source gives the item back after
// the answer, and the job follows. Real daemon, real database; the fake GitHub (slowed at its seam) and the fake herdr.
import { afterEach, describe, expect, it } from 'vitest';
import type { FailuresView, Job, PullRequestsView } from '../../src/domain/types.ts';
import { createFakeHerdrClient } from '../../src/executors/herdr/index.ts';
import { createFakeGitHub, type FakeGitHub } from '../../src/sources/index.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { connectGitHub } from '../support/github-account.ts';
import { slowGitHub } from '../support/slow-github.ts';
import { waitFor } from '../support/wait.ts';

const BUDGET_MS = 200;
const SLOW_MS = 2000;
const REPO = 'owner/hopper-sandbox';
const apps: TestApp[] = [];
let cleanup: (() => void) | undefined;

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  cleanup?.();
});

async function timed<T>(act: () => Promise<T>): Promise<{ r: T; ms: number }> {
  const t0 = performance.now();
  const r = await act();
  return { r, ms: performance.now() - t0 };
}

const HERDR = [{ name: 'herdr-claude', plugin: 'herdr-claude', options: { pollMs: 10, idleNudgeMs: 5000, promptSteadyMs: 100 } }];

async function boot(o: { herdr?: ReturnType<typeof createFakeHerdrClient> } = {}) {
  const gh = createFakeGitHub();
  const slow = slowGitHub(gh);
  const db = tempDbPath();
  cleanup = db.cleanup;
  const executor = o.herdr ? 'herdr-claude' : 'scripted';
  const plugins = {
    jobSources: [{ name: 'github', plugin: 'github-account', options: { enabled: true, pollSeconds: 3600, executor } }],
    ...(o.herdr ? { executors: HERDR, machines: lanes(1) } : {}),
  };
  const a = await startTestApp({ dbPath: db.dbPath, env: {}, seams: { github: slow.api, ...(o.herdr ? { herdr: o.herdr, levels: [] } : {}) }, plugins });
  apps.push(a);
  connectGitHub(a, [REPO]);
  const token = await a.login();
  return { a, gh, slow, token };
}

const failuresOf = async (a: TestApp) => (await a.api<FailuresView>('GET', '/api/failures')).body;
const jobsOf = async (a: TestApp, key: string) => (await a.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs.filter((j) => j.source?.key === key);

/** A GitHub issue whose first job fails, its end reported at its source. */
async function failed(a: TestApp, gh: FakeGitHub, script: string) {
  const issue = gh.createIssue({ repo: REPO, body: `${script}\n\nFix the typo.`, labels: ['hopper'] });
  await a.sync();
  const [job] = await jobsOf(a, issue.url);
  await a.waitForStatus(job!.id, 'failed', 8000);
  await waitFor(() => gh.issue(REPO, issue.number).labels.includes('hopper:failed'), { what: 'hopper:failed' });
  await waitFor(async () => (await a.job(job!.id)).sourceState?.sync?.finalReported === true, { what: 'its end reported' });
  return { issue, job: job! };
}

describe('the acts that give an item back answer within the budget, GitHub slow (issue #1194)', () => {
  it('Retry: answered at once, its give-back running; the new job follows, and the record is retried', { timeout: 30_000 }, async () => {
    const { a, gh, slow, token } = await boot();
    const { job } = await failed(a, gh, '{"op":"echo"}');
    const record = await waitFor(async () => (await failuresOf(a)).recent.find((r) => r.jobId === job.id && r.actions.retry.ok), { what: 'the failure' });
    slow.delay.ms = SLOW_MS;
    const { r, ms } = await timed(() => a.ui(`/ui/api/failures/${record.id}/retry`, {}, { token }));
    expect(r).toMatchObject({ status: 202, body: { jobId: job.id, giveBack: 'retry' } });
    expect(ms).toBeLessThan(BUDGET_MS);
    const again = await timed(() => a.ui(`/ui/api/failures/${record.id}/retry`, {}, { token }));
    expect(again.r).toMatchObject({ status: 202, body: { jobId: job.id, giveBack: 'retry' } });
    expect(again.ms).toBeLessThan(BUDGET_MS);
    slow.delay.ms = 0;
    const next = await waitFor(async () => (await jobsOf(a, job.source!.key)).find((j) => j.rerunOf === job.id), { what: 'the new job', timeoutMs: 10_000 });
    await waitFor(async () => (await failuresOf(a)).ended.find((x) => x.id === record.id && x.outcome === 'retried' && x.nextJobId === next.id), { what: 'the record retried' });
    expect((await jobsOf(a, job.source!.key)).filter((j) => j.rerunOf === job.id)).toHaveLength(1);
  });

  it('Retry: a give-back GitHub refuses after the answer is recorded with why, and no job is made', { timeout: 30_000 }, async () => {
    const { a, gh, slow, token } = await boot();
    const { issue, job } = await failed(a, gh, '{"op":"echo"}');
    const record = await waitFor(async () => (await failuresOf(a)).recent.find((r) => r.jobId === job.id && r.actions.retry.ok), { what: 'the failure' });
    gh.closeIssue(REPO, issue.number, undefined, { reason: 'not_planned' });
    gh.failNext('reopenIssue', new Error('issue locked'));
    slow.delay.ms = SLOW_MS;
    const { r, ms } = await timed(() => a.ui(`/ui/api/failures/${record.id}/retry`, {}, { token }));
    expect(r.status).toBe(202);
    expect(ms).toBeLessThan(BUDGET_MS);
    slow.delay.ms = 0;
    const failure = await waitFor(async () => (await a.events('types=job.give_back_failed'))[0], { what: 'the give-back failed', timeoutMs: 10_000 });
    expect(failure).toMatchObject({ jobId: job.id, data: { act: 'retry', error: expect.stringContaining('issue locked'), person: expect.any(String), via: 'ui' } });
    expect((await jobsOf(a, issue.url)).filter((j) => j.rerunOf === job.id)).toEqual([]);
  });

  it('a hand-off\'s I fixed it: answered at once; the new job follows and closes the hand-off', { timeout: 30_000 }, async () => {
    const { a, gh, slow, token } = await boot();
    const { job } = await failed(a, gh, '{"op":"fail","message":"HOPPER_FAILED the tests do not pass"}');
    const h = await waitFor(async () => (await failuresOf(a)).handoffs.find((x) => x.jobId === job.id && x.status === 'open'), { what: 'handed off' });
    slow.delay.ms = SLOW_MS;
    const { r, ms } = await timed(() => a.ui(`/ui/api/failures/handoffs/${h.id}/resolve`, { action: 'fixed', note: 'Fixed the fixture.' }, { token }));
    expect(r).toMatchObject({ status: 202, body: { jobId: job.id, giveBack: 'fixed' } });
    expect(ms).toBeLessThan(BUDGET_MS);
    slow.delay.ms = 0;
    const next = await waitFor(async () => (await jobsOf(a, job.source!.key)).find((j) => j.rerunOf === job.id), { what: 'the new job', timeoutMs: 10_000 });
    const closed = await waitFor(async () => (await failuresOf(a)).handoffs.find((x) => x.id === h.id && x.status === 'closed'), { what: 'the hand-off closed' });
    expect(closed).toMatchObject({ end: 'run_again', nextJobId: next.id, resolution: { action: 'fixed', note: 'Fixed the fixture.' } });
  });

  it('Push it: answered at once; the job goes on in its own session, told the note, once its issue is given back', { timeout: 30_000 }, async () => {
    const herdr = createFakeHerdrClient({
      session: 'jh-test', turns: [{ output: ['● The paint ran out halfway.', '  HOPPER_FAILED the paint ran out'] }, { output: ['● Pushed.', '  HOPPER_DONE'] }],
      reapKeeps: ['/tmp/.worktrees/@scratch/kept/repo'],
    });
    const { a, gh, slow, token } = await boot({ herdr });
    const { job } = await failed(a, gh, 'Paint the shed.');
    await waitFor(async () => (await failuresOf(a)).keptWork.find((k) => k.jobId === job.id && k.actions.push.ok), { what: 'its work kept' });
    slow.delay.ms = SLOW_MS;
    const { r, ms } = await timed(() => a.ui(`/ui/api/failures/kept-work/${job.id}/push`, { note: 'The branch is shed-blue.' }, { token }));
    expect(r).toMatchObject({ status: 202, body: { jobId: job.id, giveBack: 'push' } });
    expect(ms).toBeLessThan(BUDGET_MS);
    slow.delay.ms = 0;
    await waitFor(async () => (await a.events('types=job.continued')).find((e) => e.jobId === job.id), { what: 'the job continued', timeoutMs: 10_000 });
    await waitFor(() => herdr.prompts.length === 2, { what: 'the push brief sent' });
    expect(herdr.prompts[1]!.text).toContain('The branch is shed-blue.');
  });

  it('Tend again: answered at once; the tend job follows', { timeout: 30_000 }, async () => {
    const { a, gh, slow, token } = await boot();
    const issue = gh.createIssue({ repo: REPO, body: '{"op":"echo"}\n\nFix the typo.', labels: ['hopper'] });
    let url: string | undefined;
    let fixes = false;
    a.scripted.ships((j) => {
      if (url === undefined) url = gh.openPullRequest(REPO, j.source!.number!, { createdAt: new Date().toISOString() }).url;
      else if (fixes) gh.setConflicting(url, false);
    });
    await a.sync();
    const [job] = await jobsOf(a, issue.url);
    await a.waitForStatus(job!.id, 'finished');
    await waitFor(() => gh.issue(REPO, issue.number).labels.includes('hopper:pr-ready'), { what: 'hopper:pr-ready' });
    gh.setConflicting(url!, true);
    await a.sync();
    const tend = await waitFor(async () => (await jobsOf(a, issue.url)).find((j) => j.id !== job!.id), { what: 'the tend job' });
    await a.waitForStatus(tend.id, 'failed', 8000);
    await waitFor(async () => (await a.job(tend.id)).sourceState?.sync?.finalReported === true, { what: 'its end reported' });
    const card = async () => (await a.api<PullRequestsView>('GET', '/api/pull-requests')).body.repos.flatMap((x) => x.pullRequests).find((p) => p.jobId === job!.id);
    await waitFor(async () => (await card())?.waits === 'tend failed', { what: 'the hopper gave up' });
    fixes = true;
    slow.delay.ms = SLOW_MS;
    const { r, ms } = await timed(() => a.ui('/ui/api/pull-requests/tend', { jobId: job!.id }, { token }));
    expect(r).toMatchObject({ status: 202, body: { jobId: job!.id, giveBack: 'tend' } });
    expect(ms).toBeLessThan(BUDGET_MS);
    slow.delay.ms = 0;
    await waitFor(async () => (await a.events('types=job.pull_request_tended')).find((e) => e.jobId === job!.id && e.data.person !== undefined), { what: 'tended again', timeoutMs: 10_000 });
    expect((await jobsOf(a, issue.url)).filter((j) => j.spec.tend)).toHaveLength(2);
  });
});
