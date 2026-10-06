// The GitHub source's completion end to end (issue #187): where a job's work must get before the
// job is finished — the merge, or a pull request left open for review. Real daemon, in-memory fake
// GitHub at the GitHubApi seam; issues carry a scripted-executor op as their first body line.
import { afterEach, describe, expect, it } from 'vitest';
import type { Job } from '../../src/domain/types.ts';
import { createFakeGitHub, type FakeGitHub } from '../../src/sources/index.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { opensPullRequest } from '../support/scripted-executor.ts';
import { waitFor } from '../support/wait.ts';

const REPO = 'owner/hopper-sandbox';
const apps: TestApp[] = [];
let cleanup: (() => void) | undefined;

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  cleanup?.();
});

async function boot(gh: FakeGitHub, o: { config?: Record<string, unknown> } = {}) {
  const db = tempDbPath();
  cleanup = db.cleanup;
  const plugins = { jobSources: [{ name: 'github', plugin: 'github-gh', options: {
    enabled: true, pollSeconds: 3600, repos: [REPO], authors: ['owner'], executor: 'scripted', defaultCwd: '/tmp', ...o.config,
  } }] };
  const a = await startTestApp({ dbPath: db.dbPath, env: {}, seams: { github: gh }, plugins });
  apps.push(a);
  return a;
}

const body = (op: Record<string, unknown>) => `${JSON.stringify(op)}\n\nPlease do the thing.`;
const jobFor = async (a: TestApp, url: string): Promise<Job | undefined> =>
  (await a.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs.find((j) => j.source?.key === url);
const bodies = (gh: FakeGitHub, n: number) => gh.commentsOn(REPO, n).map((c) => c.body);

describe('GitHub completion: merge or a pull request open for review', () => {
  it('completion pull-request: a job that opens a ready pull request is finished; the issue stays open for the merge (issue #187)', async () => {
    const gh = createFakeGitHub();
    const a = await boot(gh, { config: { completion: 'pull-request' } });
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

  it('completion merge: an open pull request is not done, the job ends failed (issue #187)', async () => {
    const gh = createFakeGitHub();
    const a = await boot(gh);
    const issue = gh.createIssue({ repo: REPO, body: body({ op: 'echo' }), labels: ['hopper'] });
    a.scripted.ships(opensPullRequest(gh));
    await a.sync();
    const job = (await jobFor(a, issue.url))!;
    const failed = await a.waitForStatus(job.id, 'failed');
    expect(failed.error).toBe(`not complete: no merged pull request opened by this job closes ${issue.url}`);
  });
});
