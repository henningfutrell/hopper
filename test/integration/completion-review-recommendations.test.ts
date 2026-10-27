// Bug-report recommendations (issue #2846 part 2, design.md "Bug-report recommendations") over the real HTTP server and
// database, GitHub a fake on loopback: a completion review that finds a hopper defect makes one recommendation per
// signature, which waits for a person; nothing is filed until Approve, which sends it through Report a bug's pipeline as a
// report of the job; Dismiss keeps the reason, and the same signature is not recommended again.
import { afterEach, describe, expect, it } from 'vitest';
import type { BugReportRecommendation } from '../../src/domain/review-defects.ts';
import { DEFAULT_COMPLETION_REVIEW } from '../../src/domain/completion-review.ts';
import { ADMIN_ID, type Job } from '../../src/domain/types.ts';
import { createCompletionReviews } from '../../src/engine/completion-reviews.ts';
import { createFakeGitHub } from '../support/fake-forges.ts';
import { connectGitHub } from '../support/github-account.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

const apps: TestApp[] = [];
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) await c();
});

const REPO = 'henningfutrell/hopper';
/** The failure text of the sweep's cause (src/failures/causes.ts `SWEPT`): a hopper defect. */
const SWEPT = 'the hopper\'s sweep stopped its processes on m1 while it read the job as queued';
const later = (): Date => new Date(Date.now() + 120_000);

async function start(o: { publicReports?: boolean } = {}) {
  const github = await createFakeGitHub({ clientId: 'gh-client-id' });
  cleanups.push(() => github.close());
  github.tokens.set('test-account-token', 'reporter');
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const app = await startTestApp({
    dbPath: db.dbPath, env: { HOPPER_GITHUB_URL: github.url, HOPPER_GITHUB_CLIENT_ID: 'gh-client-id', HOPPER_GITHUB_APP_SLUG: 'hopper-test' },
  });
  apps.push(app);
  connectGitHub(app, [], { login: 'reporter' });
  const store = app.user(ADMIN_ID).store;
  if (o.publicReports !== false) store.settings.setPublicBugReports(true);
  store.settings.setCompletionReview({ ...DEFAULT_COMPLETION_REVIEW, minRunMinutes: 0 });
  const token = await app.login();
  return { app, github, store, token, pass: createCompletionReviews(store) };
}

/** A job that failed by the sweep's cause, assessed. */
async function swept(t: Awaited<ReturnType<typeof start>>): Promise<Job> {
  const job = await t.app.pull({ op: 'fail', message: SWEPT });
  await t.app.waitForStatus(job.id, 'failed');
  await waitFor(async () => t.store.failures.forJob(job.id)?.causeId === 'swept' || undefined, { what: `job ${job.id} assessed` });
  return job;
}

const list = async (a: TestApp, q = '') => (await a.api<{ recommendations: BugReportRecommendation[] }>('GET', `/api/completion-review/recommendations${q}`)).body.recommendations;
const events = (t: Awaited<ReturnType<typeof start>>, type: string) => t.store.events.recent(1000).filter((e) => e.type === type);

describe('bug-report recommendations of completion reviews', () => {
  it('waits for a person; Approve files it through Report a bug, once; a later review of the same defect recommends nothing', async () => {
    const t = await start();
    const job = await swept(t);
    t.pass(later());
    const [r] = await list(t.app, '?state=open');
    expect(r).toMatchObject({ signature: 'cause:swept', jobId: job.id, state: 'open', jobs: 1 });
    expect(events(t, 'completion_review.recommended').map((e) => e.jobId)).toEqual([job.id]);
    const page = await t.app.api<{ recommendation?: BugReportRecommendation }>('GET', `/api/jobs/${job.id}/completion-review`);
    expect(page.body.recommendation?.signature).toBe('cause:swept');
    expect(t.github.issues.filter((i) => i.repo === REPO)).toEqual([]); // nothing filed before approval

    const approved = await t.app.ui<{ kind: string; number: number }>('/ui/api/completion-review/recommendations/approve', { signature: 'cause:swept' }, { token: t.token });
    expect(approved.status).toBe(200);
    expect(approved.body.kind).toBe('filed');
    const [issue] = t.github.issues.filter((i) => i.repo === REPO);
    expect(issue!.title).toContain('sweep');
    expect(issue!.body).not.toContain(job.id);
    expect(issue!.labels).toEqual(['user-report']);
    const [after] = await list(t.app);
    expect(after).toMatchObject({ state: 'approved', by: expect.any(String), reportId: expect.any(String) });
    expect(t.store.bugReports.get(after!.reportId!)).toMatchObject({ state: 'open', jobId: job.id, fromJob: true });
    expect(events(t, 'completion_review.recommendation_decided')[0]!.data).toMatchObject({ signature: 'cause:swept', state: 'approved' });
    expect((await t.app.ui('/ui/api/completion-review/recommendations/approve', { signature: 'cause:swept' }, { token: t.token })).status).toBe(409);

    await swept(t);
    t.pass(later());
    expect(events(t, 'completion_review.recommended')).toHaveLength(1);
    expect((await list(t.app))[0]).toMatchObject({ state: 'approved' });
    expect((await list(t.app))[0]!.jobs).toBeGreaterThanOrEqual(2);
    expect(t.github.issues.filter((i) => i.repo === REPO)).toHaveLength(1);
  });

  it('keeps a dismissal\'s reason, and does not recommend the signature again', async () => {
    const t = await start();
    await swept(t);
    t.pass(later());
    const path = '/ui/api/completion-review/recommendations/dismiss';
    expect((await t.app.ui(path, { signature: 'cause:swept' }, { token: t.token })).status).toBe(400);
    expect((await t.app.ui(path, { signature: 'nope', reason: 'x' }, { token: t.token })).status).toBe(404);
    const d = await t.app.ui<BugReportRecommendation>(path, { signature: 'cause:swept', reason: 'fixed by the sweep change' }, { token: t.token });
    expect(d.body).toMatchObject({ state: 'dismissed', reason: 'fixed by the sweep change' });
    expect((await t.app.ui(path, { signature: 'cause:swept', reason: 'again' }, { token: t.token })).status).toBe(409);

    await swept(t);
    t.pass(later());
    expect(await list(t.app, '?state=open')).toEqual([]);
    expect(events(t, 'completion_review.recommended')).toHaveLength(1);
    expect(t.github.issues.filter((i) => i.repo === REPO)).toEqual([]);
  });

  it('files nothing while public bug reports are off: Approve is refused, and it stays open', async () => {
    const t = await start({ publicReports: false });
    await swept(t);
    t.pass(later());
    expect((await t.app.ui('/ui/api/completion-review/recommendations/approve', { signature: 'cause:swept' }, { token: t.token })).status).toBe(409);
    expect((await list(t.app))[0]).toMatchObject({ state: 'open' });
    expect(t.store.bugReports.list()).toEqual([]);
  });

  it('recommends nothing for a failure of the job\'s own work', async () => {
    const t = await start();
    const job = await t.app.pull({ op: 'fail', message: 'boom' });
    await t.app.waitForStatus(job.id, 'failed');
    expect(t.pass(later()).map((r) => r.jobId)).toEqual([job.id]);
    expect(await list(t.app)).toEqual([]);
  });
});
