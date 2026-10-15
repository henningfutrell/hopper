// The latency budget of a person's actions (issue #1194): with GitHub and the job's machine slow, an action records its
// decision and answers within the budget; the slow work runs after the answer. Real daemon, real database; the fake
// GitHub (slowed at its seam), the OpenFGA double and the fake herdr and its machine at their seams.
import { afterEach, describe, expect, it } from 'vitest';
import type { IntakeOutcome } from '../../src/domain/intake.ts';
import type { FailuresView, Job } from '../../src/domain/types.ts';
import { createFakeHerdrClient } from '../../src/executors/herdr/index.ts';
import { createFakeGitHub } from '../../src/sources/index.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { connectGitHub } from '../support/github-account.ts';
import { slowGitHub } from '../support/slow-github.ts';
import { waitFor } from '../support/wait.ts';

/** What an action may take to answer. Anything that waits for the slow side takes `SLOW_MS` at least. */
const BUDGET_MS = 200;
const SLOW_MS = 2000;
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
