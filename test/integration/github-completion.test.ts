// The GitHub source's done-check end to end (issues #187, #579): a job is finished when its own pull request is open
// and ready for review — no merge needed — or merged. Real daemon, in-memory fake
// GitHub at the GitHubApi seam; issues carry a scripted-executor op as their first body line.
// A job whose issue closed as complete is finished, not failed (issue #350).
import { afterEach, describe, expect, it } from 'vitest';
import { finishBrief, MAX_FINISH_BRIEFS, type FailuresView, type Job } from '../../src/domain/types.ts';
import { createFakeGitHub, type FakeGitHub } from '../../src/sources/index.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { opensPullRequest } from '../support/scripted-executor.ts';
import { waitFor } from '../support/wait.ts';
import { connectGitHub } from '../support/github-account.ts';

const REPO = 'owner/hopper-sandbox';
const apps: TestApp[] = [];
let cleanup: (() => void) | undefined;

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  cleanup?.();
});

async function boot(gh: FakeGitHub, env: Record<string, string> = {}) {
  const db = tempDbPath();
  cleanup = db.cleanup;
  const plugins = { jobSources: [{ name: 'github', plugin: 'github-account', options: {
    enabled: true, pollSeconds: 3600, executor: 'scripted',
  } }] };
  const a = await startTestApp({ dbPath: db.dbPath, env, seams: { github: gh }, plugins });
  apps.push(a);
  connectGitHub(a, [REPO]);
  return a;
}

const body = (op: Record<string, unknown>) => `${JSON.stringify(op)}\n\nPlease do the thing.`;
const jobFor = async (a: TestApp, url: string): Promise<Job | undefined> =>
  (await a.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs.find((j) => j.source?.key === url);
const bodies = (gh: FakeGitHub, n: number) => gh.commentsOn(REPO, n).map((c) => c.body);

describe('GitHub done-check: a pull request ready for review', () => {
  it('a job that opens a ready pull request is finished; the issue stays open for the merge (issues #187, #579)', async () => {
    const gh = createFakeGitHub();
    const a = await boot(gh);
    const issue = gh.createIssue({ repo: REPO, body: body({ op: 'echo' }), labels: ['hopper'] });
    a.scripted.ships(opensPullRequest(gh));
    await a.sync();
    const job = (await jobFor(a, issue.url))!;
    await a.waitForStatus(job.id, 'finished');
    await waitFor(() => gh.issue(REPO, issue.number).labels.includes('hopper:pr-ready'), { what: 'hopper:pr-ready' });
    expect(gh.issue(REPO, issue.number).state).toBe('open');
    expect(bodies(gh, issue.number)).toEqual([]);
    await a.sync();
    expect(await a.events('types=job.queued')).toHaveLength(1);
  });

  it('GitHub lag (issue #637): the first check sees no pull request, the re-check a moment later sees it — finished, no failure record', async () => {
    const gh = createFakeGitHub();
    const a = await boot(gh, { HOPPER_DONE_RECHECK_MS: '1500' });
    const issue = gh.createIssue({ repo: REPO, body: body({ op: 'echo' }), labels: ['hopper'] });
    a.scripted.ships((j) => { setTimeout(() => gh.openPullRequest(REPO, j.source!.number!, { createdAt: new Date().toISOString() }), 300); });
    await a.sync();
    const job = (await jobFor(a, issue.url))!;
    await a.waitForStatus(job.id, 'finished');
    expect((await a.events('types=job.failed')).filter((e) => e.jobId === job.id)).toEqual([]);
    const f = (await a.api<{ recent: unknown[]; handoffs: unknown[] }>('GET', '/api/failures')).body;
    expect([f.recent, f.handoffs]).toEqual([[], []]);
  });

  it('a draft pull request is not done: briefed to mark it ready and still a draft, the job ends failed, saying why (issues #579, #626)', async () => {
    const gh = createFakeGitHub();
    const a = await boot(gh);
    const issue = gh.createIssue({ repo: REPO, body: body({ op: 'echo' }), labels: ['hopper'] });
    a.scripted.ships((j) => { gh.openPullRequest(REPO, j.source!.number!, { createdAt: new Date().toISOString(), isDraft: true }); });
    await a.sync();
    const job = (await jobFor(a, issue.url))!;
    const failed = await a.waitForStatus(job.id, 'failed');
    expect(failed.error).toMatch(new RegExp(`^not complete: the issue ${issue.url} is open, and no pull request in ${REPO} that closes or references it is ready for review or merged since the job began: #\\d+ \\(open, draft\\)(, #\\d+ \\(open, draft\\))*$`));
    expect((await a.events('types=job.finish_briefed')).filter((e) => e.jobId === job.id)).toHaveLength(MAX_FINISH_BRIEFS);
  });

  it.each([
    ['its own draft is marked ready', 'mark_ready', { isDraft: true }, (gh: FakeGitHub, url: string) => gh.markReady(url)],
    ['its own pull request with merge conflicts is rebased', 'rebase', { conflicting: true }, (gh: FakeGitHub, url: string) => gh.pushToPullRequest(url, new Date().toISOString())],
  ] as const)('a job goes on with the fixed brief, not a hand-off, and finishes once %s (issue #626)', async (_n, step, left, finish) => {
    const gh = createFakeGitHub();
    const a = await boot(gh);
    const issue = gh.createIssue({ repo: REPO, body: body({ op: 'echo' }), labels: ['hopper'] });
    let pr: string | undefined;
    a.scripted.ships((j) => {
      if (pr === undefined) pr = gh.openPullRequest(REPO, j.source!.number!, { createdAt: new Date().toISOString(), ...left }).url;
      else finish(gh, pr);
    });
    await a.sync();
    const job = (await jobFor(a, issue.url))!;
    const finished = await a.waitForStatus(job.id, 'finished');
    const briefed = (await a.events('types=job.finish_briefed')).filter((e) => e.jobId === job.id);
    expect(briefed.map((e) => e.data)).toEqual([{ pullRequest: pr, step }]);
    expect((finished.result as { answer: string }).answer).toBe(finishBrief({ pullRequest: pr!, step }));
    expect(await a.events('types=job.failed')).toEqual([]);
    expect(gh.issue(REPO, issue.number).labels).not.toContain('hopper:failed');
  });

  it('a job whose issue asks to update an existing pull request is finished when it pushed to it and it has no merge conflicts: no new pull request (issue #618)', async () => {
    const gh = createFakeGitHub();
    const a = await boot(gh);
    gh.createIssue({ repo: REPO });
    const older = gh.openPullRequest(REPO, 1, { createdAt: '2026-10-01T09:00:00.000Z', conflicting: true });
    const issue = gh.createIssue({ repo: REPO, body: `${body({ op: 'echo' })}\nBring ${older.url} up to date with dev.`, labels: ['hopper'] });
    a.scripted.ships(() => gh.pushToPullRequest(older.url, new Date().toISOString()));
    await a.sync();
    const job = (await jobFor(a, issue.url))!;
    await a.waitForStatus(job.id, 'finished');
    expect(gh.issue(REPO, issue.number).labels).not.toContain('hopper:failed');
  });

  it('a job whose issue asks to update an existing pull request, and leaves it with merge conflicts, ends failed (issue #618)', async () => {
    const gh = createFakeGitHub();
    const a = await boot(gh);
    gh.createIssue({ repo: REPO });
    const older = gh.openPullRequest(REPO, 1, { createdAt: '2026-10-01T09:00:00.000Z', conflicting: true });
    const issue = gh.createIssue({ repo: REPO, body: `${body({ op: 'echo' })}\nRebase #${older.url.split('/').at(-1)} onto dev.`, labels: ['hopper'] });
    a.scripted.ships(() => gh.pushToPullRequest(older.url, new Date().toISOString(), { conflicting: true }));
    await a.sync();
    const job = (await jobFor(a, issue.url))!;
    const failed = await a.waitForStatus(job.id, 'failed');
    expect(failed.error).toMatch(/^not complete: the issue .* is open, .*the pull requests it asks to update are not each merged or free of merge conflicts: #\d+ \(open, merge conflicts\)$/);
  });

  it('a job that closes its issue as completed with a commit, no pull request, is finished (issue #350)', async () => {
    const gh = createFakeGitHub();
    const a = await boot(gh);
    const issue = gh.createIssue({ repo: REPO, body: body({ op: 'echo' }), labels: ['hopper'] });
    a.scripted.ships((j) => gh.closeIssue(REPO, j.source!.number!, 'owner', { at: new Date().toISOString() }));
    await a.sync();
    const job = (await jobFor(a, issue.url))!;
    await a.waitForStatus(job.id, 'finished');
    await waitFor(() => gh.issue(REPO, issue.number).labels.includes('hopper:done'), { what: 'hopper:done' });
    expect(gh.issue(REPO, issue.number).labels).not.toContain('hopper:failed');
  });

  it('a job that fails after its own merged pull request closed its issue is finished: hopper:done, never hopper:failed (issue #350)', async () => {
    const gh = createFakeGitHub();
    const a = await boot(gh);
    const issue = gh.createIssue({ repo: REPO, body: body({ op: 'fail', ms: 1500, message: 'pane ended' }), labels: ['hopper'] });
    await a.sync();
    const job = (await jobFor(a, issue.url))!;
    await a.waitForStatus(job.id, 'running');
    const now = new Date().toISOString();
    gh.closeByPullRequest(REPO, issue.number, { createdAt: now, mergedAt: now });
    const finished = await a.waitForStatus(job.id, 'finished');
    expect(finished.error).toBeUndefined();
    await waitFor(() => gh.issue(REPO, issue.number).labels.includes('hopper:done'), { what: 'hopper:done' });
    expect(gh.issue(REPO, issue.number).labels).not.toContain('hopper:failed');
    const ends = (await a.events('types=job.failed,job.finished')).filter((e) => e.jobId === job.id);
    expect(ends.map((e) => [e.type, e.data])).toEqual([
      ['job.failed', { error: 'pane ended', priority: 50, high: false }],
      ['job.finished', { result: 'issue closed as complete' }],
    ]);
  });

  it('a job that fails while its issue is open stays failed (issue #350)', async () => {
    const gh = createFakeGitHub();
    const a = await boot(gh);
    const issue = gh.createIssue({ repo: REPO, body: body({ op: 'fail', message: 'broke' }), labels: ['hopper'] });
    await a.sync();
    const job = (await jobFor(a, issue.url))!;
    await a.waitForStatus(job.id, 'failed');
    await waitFor(() => gh.issue(REPO, issue.number).labels.includes('hopper:failed'), { what: 'hopper:failed' });
    expect((await a.job(job.id)).status).toBe('failed');
  });
});

describe('resolve and release do not run finished work again (issue #637)', () => {
  it('test 8 — a held job whose pull request merged meanwhile: resolving its problem finishes it, no run again, its issue stays closed', async () => {
    const gh = createFakeGitHub();
    const a = await boot(gh);
    const token = await a.login();
    const issue = gh.createIssue({ repo: REPO, body: body({ op: 'fail', ms: 300, message: 'claude: Not logged in · Please run /login' }), labels: ['hopper'] });
    await a.sync();
    const job = (await jobFor(a, issue.url))!;
    await a.waitForStatus(job.id, 'failed');
    const problem = await waitFor(async () => (await a.api<FailuresView>('GET', '/api/failures')).body.problems.find((p) => p.jobIds.includes(job.id)), { what: 'the problem' });
    await waitFor(() => gh.issue(REPO, issue.number).labels.includes('hopper:failed'), { what: 'hopper:failed' });
    const now = new Date().toISOString();
    gh.closeByPullRequest(REPO, issue.number, { createdAt: now, mergedAt: now });
    expect((await a.ui(`/ui/api/failures/problems/${problem.id}/resolve`, {}, { token })).status).toBe(200);
    await a.waitForStatus(job.id, 'finished');
    await waitFor(() => gh.issue(REPO, issue.number).labels.includes('hopper:done'), { what: 'hopper:done' });
    expect(gh.issue(REPO, issue.number).state).toBe('closed');
    expect(gh.calls.filter((c) => c.method === 'reopenIssue')).toEqual([]);
    expect((await a.events('types=job.rerun')).filter((e) => e.jobId === job.id)).toEqual([]);
    const record = (await a.api<FailuresView>('GET', '/api/failures')).body.ended.find((r) => r.jobId === job.id);
    expect(record).toMatchObject({ outcome: 'resolved' });
    expect(record?.note).toMatch(/done at its source/);
  });

  it('a person\'s Retry of a failure whose work is done meanwhile finishes the job and is refused, saying why', async () => {
    const gh = createFakeGitHub();
    const a = await boot(gh);
    const token = await a.login();
    const issue = gh.createIssue({ repo: REPO, body: body({ op: 'echo' }), labels: ['hopper'] });
    await a.sync();
    const job = (await jobFor(a, issue.url))!;
    await a.waitForStatus(job.id, 'failed');
    const record = await waitFor(async () => (await a.api<FailuresView>('GET', '/api/failures')).body.recent.find((r) => r.jobId === job.id), { what: 'the failure' });
    await waitFor(() => gh.issue(REPO, issue.number).labels.includes('hopper:failed'), { what: 'hopper:failed' });
    gh.openPullRequest(REPO, issue.number, { createdAt: new Date().toISOString() });
    const r = await a.ui<{ error: string }>(`/ui/api/failures/${record.id}/retry`, {}, { token });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/needs no run again: its job is done at its source/);
    await a.waitForStatus(job.id, 'finished');
    await waitFor(() => gh.issue(REPO, issue.number).labels.includes('hopper:pr-ready'), { what: 'hopper:pr-ready' });
    expect((await a.events('types=job.rerun')).filter((e) => e.jobId === job.id)).toEqual([]);
  });
});
