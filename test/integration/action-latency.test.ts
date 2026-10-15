// The latency budget of a person's actions (issue #1194): with GitHub and the job's machine slow, an action records its
// decision and answers within the budget; the slow work runs after the answer. Real daemon, real database; the fake
// GitHub (slowed at its seam), the OpenFGA double and the fake herdr and its machine at their seams.
import { afterEach, describe, expect, it } from 'vitest';
import type { IntakeOutcome } from '../../src/domain/intake.ts';
import type { FailuresView, Job, PullRequestsView } from '../../src/domain/types.ts';
import { createFakeHerdrClient } from '../../src/executors/herdr/index.ts';
import { createFakeGitHub, type FakeGitHub } from '../../src/sources/index.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { connectGitHub } from '../support/github-account.ts';
import { BUDGET_MS, SLOW_MS } from '../support/latency.ts';
import { slowGitHub } from '../support/slow-github.ts';
import { waitFor } from '../support/wait.ts';

const REPO = 'owner/hopper-sandbox';
const apps: TestApp[] = [];
let cleanup: (() => void) | undefined;

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  cleanup?.();
});

/** The answer and how long it took, in ms. */
async function timed<T>(act: () => Promise<T>): Promise<{ r: T; ms: number }> {
  const t0 = performance.now();
  const r = await act();
  return { r, ms: performance.now() - t0 };
}

describe('a person\'s action answers within the budget, whatever is slow (issue #1194)', () => {
  async function bootIntake() {
    const gh = createFakeGitHub();
    const slow = slowGitHub(gh);
    const db = tempDbPath();
    cleanup = db.cleanup;
    const plugins = { jobSources: [{ name: 'github', plugin: 'github-account', options: { enabled: true, pollSeconds: 3600, executor: 'scripted' } }] };
    const a = await startTestApp({ dbPath: db.dbPath, env: {}, seams: { github: slow.api }, plugins });
    apps.push(a);
    connectGitHub(a, [REPO]);
    const token = await a.login();
    const issue = gh.createIssue({ repo: REPO, author: 'stranger', body: `${JSON.stringify({ op: 'sleep', ms: 10000 })}\n\nFix the typo.`, labels: ['hopper'] });
    gh.addComment(REPO, issue.number, 'owner', 'Go ahead.');
    await a.sync();
    const intake: IntakeOutcome[] = (await a.api('GET', '/api/sources')).body.sources.find((s: { name: string }) => s.name === 'github').detail.intake;
    const hash = intake.find((x) => x.key === issue.url)!.request!.hash;
    return { a, gh, slow, token, issue, hash };
  }

  it('Approve: the approval is recorded and answered at once; the comments, the sync and the job follow', { timeout: 30_000 }, async () => {
    const { a, slow, token, issue, hash } = await bootIntake();
    slow.delay.ms = SLOW_MS;
    const { r, ms } = await timed(() => a.ui('/ui/api/sources/github/intake', { kind: 'approve', keys: [issue.url], hash }, { token }));
    expect(r).toMatchObject({ status: 200, body: { done: [issue.url], failed: {} } });
    expect(ms).toBeLessThan(BUDGET_MS);
    expect((await a.events('types=source.request_approved')).map((e) => e.data.key)).toEqual([issue.url]);
    slow.delay.ms = 0;
    const job = await waitFor(async () => (await a.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs.find((j) => j.source?.key === issue.url), { what: 'the approved job', timeoutMs: 10_000 });
    expect(job.source).toMatchObject({ origin: 'approved' });
  });

  it('Decline: recorded and answered at once', { timeout: 30_000 }, async () => {
    const { a, slow, token, issue, hash } = await bootIntake();
    slow.delay.ms = SLOW_MS;
    const { r, ms } = await timed(() => a.ui('/ui/api/sources/github/intake', { kind: 'decline', keys: [issue.url], hash }, { token }));
    expect(r).toMatchObject({ status: 200, body: { done: [issue.url], failed: {} } });
    expect(ms).toBeLessThan(BUDGET_MS);
    expect(await a.events('types=source.request_declined')).toHaveLength(1);
    slow.delay.ms = 0;
  });

  it('Assign to me, Release claim and Take off the backburner: answered at once; the GitHub write follows, and the sync takes the issues', { timeout: 30_000 }, async () => {
    const { a, gh, slow, token } = await bootIntake();
    const unassigned = gh.createIssue({ repo: REPO, assignees: [], labels: ['hopper'] });
    const claimed = gh.createIssue({ repo: REPO, labels: ['hopper', 'hopper:claimed', 'hopper:held-by:0f0f0f0f0f0f'] });
    const backburner = gh.createIssue({ repo: REPO, labels: ['hopper', 'hopper:backburner'] });
    await a.sync();
    slow.delay.ms = SLOW_MS;
    for (const [kind, issue] of [['assign', unassigned], ['release', claimed], ['unbackburner', backburner]] as const) {
      const { r, ms } = await timed(() => a.ui('/ui/api/sources/github/intake', { kind, keys: [issue.url] }, { token }));
      expect(r).toMatchObject({ status: 200, body: { done: [issue.url], failed: {} } });
      expect(ms).toBeLessThan(BUDGET_MS);
    }
    slow.delay.ms = 0;
    const jobs = async () => (await a.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs;
    await waitFor(async () => {
      const keys = new Set((await jobs()).map((j) => j.source?.key));
      return [unassigned, claimed, backburner].every((i) => keys.has(i.url)) || undefined;
    }, { what: 'the three issues taken', timeoutMs: 20_000 });
    expect((await a.events('types=source.issues_assigned')).map((e) => e.data.keys)).toEqual([[unassigned.url]]);
  });

  async function bootEnded(script: string, ships?: (gh: FakeGitHub, issueUrl: string) => (job: Job) => void) {
    const gh = createFakeGitHub();
    const slow = slowGitHub(gh);
    const db = tempDbPath();
    cleanup = db.cleanup;
    const plugins = { jobSources: [{ name: 'github', plugin: 'github-account', options: { enabled: true, pollSeconds: 3600, executor: 'scripted' } }] };
    const a = await startTestApp({ dbPath: db.dbPath, env: {}, seams: { github: slow.api }, plugins });
    apps.push(a);
    connectGitHub(a, [REPO]);
    const token = await a.login();
    const issue = gh.createIssue({ repo: REPO, body: `${script}\n\nFix the typo.`, labels: ['hopper'] });
    if (ships) a.scripted.ships(ships(gh, issue.url));
    await a.sync();
    const first = (await a.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs.find((j) => j.source?.key === issue.url)!;
    const ended = await waitFor(async () => { const j = await a.job(first.id); return ['failed', 'finished'].includes(j.status) ? j : undefined; }, { what: 'its end' });
    await waitFor(() => gh.issue(REPO, issue.number).labels.some((l) => l === 'hopper:failed' || l === 'hopper:pr-ready'), { what: 'its end at the source' });
    return { a, gh, slow, token, issue, ended };
  }
  const newJobOf = (a: TestApp, jobId: string) => waitFor(async () => (await a.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs.find((j) => j.rerunOf === jobId), { what: 'the new job', timeoutMs: 10_000 });

  it('Run again: answered at once, its give-back running; the issue is given back on GitHub after, and the new job follows', { timeout: 30_000 }, async () => {
    const { a, gh, slow, token, issue, ended } = await bootEnded('{"op":"fail","message":"boom"}');
    gh.closeIssue(REPO, issue.number, undefined, { reason: 'not_planned' });
    slow.delay.ms = SLOW_MS;
    const { r, ms } = await timed(() => a.ui(`/ui/api/jobs/${ended.id}/rerun`, {}, { token }));
    expect(r).toMatchObject({ status: 202, body: { jobId: ended.id, giveBack: 'rerun' } });
    expect(ms).toBeLessThan(BUDGET_MS);
    // The same act sent again while it runs (a second click, another tab) answers the same, and gives back nothing more.
    const again = await timed(() => a.ui(`/ui/api/jobs/${ended.id}/rerun`, {}, { token }));
    expect(again.r).toMatchObject({ status: 202, body: { jobId: ended.id, giveBack: 'rerun' } });
    expect(again.ms).toBeLessThan(BUDGET_MS);
    slow.delay.ms = 0;
    const next = await newJobOf(a, ended.id);
    expect(gh.issue(REPO, issue.number).state).toBe('open');
    expect((await a.events('types=job.rerun')).map((e) => e.jobId)).toEqual([ended.id]);
    expect((await a.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs.filter((j) => j.rerunOf === ended.id).map((j) => j.id)).toEqual([next.id]);
  });

  it('Run again: a give-back GitHub refuses after the answer is recorded with why, and no job is made', { timeout: 30_000 }, async () => {
    const { a, gh, slow, token, issue, ended } = await bootEnded('{"op":"fail","message":"boom"}');
    gh.failNext('reopenIssue', new Error('issue locked'));
    gh.closeIssue(REPO, issue.number, undefined, { reason: 'not_planned' });
    slow.delay.ms = SLOW_MS;
    const { r, ms } = await timed(() => a.ui(`/ui/api/jobs/${ended.id}/rerun`, {}, { token }));
    expect(r.status).toBe(202);
    expect(ms).toBeLessThan(BUDGET_MS);
    slow.delay.ms = 0;
    const failed = await waitFor(async () => (await a.events('types=job.give_back_failed'))[0], { what: 'the give-back failed', timeoutMs: 10_000 });
    expect(failed).toMatchObject({ jobId: ended.id, data: { act: 'rerun', error: expect.stringContaining('issue locked'), person: expect.any(String), via: 'ui' } });
    expect((await a.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs.filter((j) => j.rerunOf === ended.id)).toEqual([]);
    // Run again is offered again: sent again, it gives back and the new job follows.
    expect((await a.ui(`/ui/api/jobs/${ended.id}/rerun`, {}, { token })).status).toBe(202);
    await newJobOf(a, ended.id);
  });

  it('Rework: answered at once; the pull request is made a draft after, and the new job follows, told the notes', { timeout: 30_000 }, async () => {
    let url = '';
    const { a, gh, slow, token, ended } = await bootEnded('{"op":"echo"}', (g, key) => (job) => {
      if (job.source?.key === key && url === '') url = g.openPullRequest(REPO, Number(key.split('/').at(-1)), { createdAt: new Date().toISOString() }).url;
    });
    await a.sync();
    await waitFor(async () => (await a.api<PullRequestsView>('GET', '/api/pull-requests')).body.repos.flatMap((x) => x.pullRequests).find((p) => p.jobId === ended.id), { what: 'the pull request card' });
    slow.delay.ms = SLOW_MS;
    const { r, ms } = await timed(() => a.ui(`/ui/api/jobs/${ended.id}/rework`, { notes: 'Rename the flag.' }, { token }));
    expect(r).toMatchObject({ status: 202, body: { jobId: ended.id, giveBack: 'rework' } });
    expect(ms).toBeLessThan(BUDGET_MS);
    slow.delay.ms = 0;
    const next = await newJobOf(a, ended.id);
    expect(next.rework).toMatchObject({ pullRequest: url, notes: 'Rename the flag.', via: 'ui' });
    expect(gh.calls.filter((c) => c.method === 'toDraft')).toHaveLength(1);
  });

  it('Queue order and the landing batches: recorded and answered at once, GitHub slow', { timeout: 30_000 }, async () => {
    const { a, slow, token } = await bootIntake();
    slow.delay.ms = SLOW_MS;
    const order = await timed(() => a.ui('/ui/api/queue/order', { jobIds: [] }, { token }));
    expect(order.r.status).toBe(200);
    expect(order.ms).toBeLessThan(BUDGET_MS);
    const batches = await timed(() => a.ui('/ui/api/landing-batches', { repos: { [REPO]: { tested: 'dev' } } }, { token }));
    expect(batches.r.status).toBe(200);
    expect(batches.ms).toBeLessThan(BUDGET_MS);
    expect(await a.events('types=landing_batches.changed')).toHaveLength(1);
    slow.delay.ms = 0;
  });

  it('Discard kept work: answered at once and shown removing; the work leaves the list once its machine removed it', { timeout: 30_000 }, async () => {
    const herdr = createFakeHerdrClient({
      session: 'jh-test', turns: [{ output: ['● The paint ran out halfway.', '  HOPPER_FAILED the paint ran out'] }],
      reapKeeps: ['/tmp/.worktrees/@scratch/kept/repo'], discardMs: SLOW_MS,
    });
    const db = tempDbPath();
    cleanup = db.cleanup;
    const executors = [{ name: 'herdr-claude', plugin: 'herdr-claude', options: { pollMs: 10, idleNudgeMs: 5000, promptSteadyMs: 100 } }];
    const a = await startTestApp({ dbPath: db.dbPath, plugins: { executors, machines: lanes(1) }, seams: { herdr, levels: [] } });
    apps.push(a);
    const token = await a.login();
    const item = { executor: 'herdr-claude', prompt: 'Paint the shed', cwd: '/tmp', env: {} };
    const job = await a.pull({}, item);
    await a.waitForStatus(job.id, 'failed', 8000);
    const failures = async () => (await a.api<FailuresView>('GET', '/api/failures')).body;
    await waitFor(async () => (await failures()).keptWork.find((k) => k.jobId === job.id), { what: 'its work kept' });

    const { r, ms } = await timed(() => a.ui(`/ui/api/failures/kept-work/${job.id}/discard`, {}, { token }));
    expect(r.status).toBe(200);
    expect(ms).toBeLessThan(BUDGET_MS);
    expect((await failures()).keptWork.find((k) => k.jobId === job.id)).toMatchObject({
      discarding: { state: 'removing' }, actions: { discard: { ok: false, why: 'its work is being removed on its machine' } },
    });
    await waitFor(async () => (await failures()).keptWork.every((k) => k.jobId !== job.id), { what: 'its work removed', timeoutMs: 10_000 });
    expect((await a.events('types=job.work_removed')).filter((e) => e.jobId === job.id)).toEqual([expect.objectContaining({ data: expect.objectContaining({ discarded: true, via: 'ui' }) })]);
  });
});
