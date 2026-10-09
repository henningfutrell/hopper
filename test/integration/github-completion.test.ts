// The GitHub source's done-check end to end (issues #187, #579): a job is finished when its own pull request is open
// and ready for review — no merge needed — or merged. Real daemon, in-memory fake
// GitHub at the GitHubApi seam; issues carry a scripted-executor op as their first body line.
// A job whose issue closed as complete is finished, not failed (issue #350).
import { afterEach, describe, expect, it } from 'vitest';
import type { Job } from '../../src/domain/types.ts';
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

async function boot(gh: FakeGitHub) {
  const db = tempDbPath();
  cleanup = db.cleanup;
  const plugins = { jobSources: [{ name: 'github', plugin: 'github-account', options: {
    enabled: true, pollSeconds: 3600, executor: 'scripted',
  } }] };
  const a = await startTestApp({ dbPath: db.dbPath, env: {}, seams: { github: gh }, plugins });
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
    await waitFor(() => gh.issue(REPO, issue.number).labels.includes('hopper:done'), { what: 'hopper:done' });
    expect(gh.issue(REPO, issue.number).state).toBe('open');
    expect(bodies(gh, issue.number)).toEqual([]);
    await a.sync();
    expect(await a.events('types=job.queued')).toHaveLength(1);
  });

  it('a draft pull request is not done: the job ends failed, saying why (issue #579)', async () => {
    const gh = createFakeGitHub();
    const a = await boot(gh);
    const issue = gh.createIssue({ repo: REPO, body: body({ op: 'echo' }), labels: ['hopper'] });
    a.scripted.ships((j) => { gh.openPullRequest(REPO, j.source!.number!, { createdAt: new Date().toISOString(), isDraft: true }); });
    await a.sync();
    const job = (await jobFor(a, issue.url))!;
    const failed = await a.waitForStatus(job.id, 'failed');
    expect(failed.error).toBe(`not complete: no pull request opened by this job, ready for review, closes ${issue.url}`);
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
