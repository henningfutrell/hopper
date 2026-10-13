// One read per sync pass (issue #822): in one sync of a GitHub source, the same issue, pull request or list is asked of
// GitHub once. A write to a repository makes the next read of that repository go to GitHub again, so a pass never acts
// on what it changed itself. A read outside a pass (a job's end, reported when it happens) always goes to GitHub.
// Real daemon, real database; the in-memory fake GitHub at the GitHubApi seam counts the calls.
import { afterEach, describe, expect, it } from 'vitest';
import type { Job } from '../../src/domain/types.ts';
import { createFakeGitHub, type FakeGitHub } from '../../src/sources/index.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { connectGitHub } from '../support/github-account.ts';
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

const WRITES = new Set(['ensureLabel', 'addLabels', 'removeLabels', 'addAssignees', 'reopenIssue', 'closeAsCompleted', 'postComment', 'merge', 'closeWithoutMerge', 'toDraft']);
const body = (op: Record<string, unknown>) => `${JSON.stringify(op)}\n\nPlease do the thing.`;
const jobFor = async (app: TestApp, url: string): Promise<Job> =>
  (await app.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs.find((j) => j.source?.key === url)!;
const now = () => new Date().toISOString();

/** The reads asked again with nothing written to their repository in between: what one pass asked twice. */
function repeatedReads(calls: FakeGitHub['calls']): string[] {
  const seen = new Set<string>();
  const repeated: string[] = [];
  for (const c of calls) {
    if (WRITES.has(c.method)) { seen.clear(); continue; }
    const k = `${c.method} ${JSON.stringify(c.args)}`;
    if (seen.has(k)) repeated.push(k);
    seen.add(k);
  }
  return repeated;
}

/** Three issues of one repository whose jobs ended done, each pull request open and followed. */
async function followed(gh: FakeGitHub, app: TestApp) {
  const issues = [1, 2, 3].map(() => gh.createIssue({ repo: REPO, body: body({ op: 'echo' }), labels: ['hopper'] }));
  app.scripted.ships((job) => {
    const issue = issues.find((i) => i.url === job.source?.key);
    if (issue) gh.openPullRequest(REPO, issue.number, { createdAt: now(), checks: 'pending' });
  });
  await app.sync();
  for (const issue of issues) await app.waitForStatus((await jobFor(app, issue.url)).id, 'finished');
  for (const issue of issues) await waitFor(() => gh.issue(REPO, issue.number).labels.includes('hopper:pr-ready'), { what: 'hopper:pr-ready' });
  return issues;
}

describe('one read per sync pass (issue #822)', () => {
  it('a sync that follows three pull requests of one repository asks each thing of GitHub once', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    await followed(gh, app);
    gh.calls.length = 0;
    await app.sync();
    expect(gh.calls.filter((c) => c.method === 'getIssue')).toHaveLength(3);
    expect(repeatedReads(gh.calls)).toEqual([]);
  });

  it('the next sync asks GitHub again: what a pass read is kept only for that pass', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const [first] = await followed(gh, app);
    await app.sync();
    gh.closeIssue(REPO, first!.number, 'owner', { at: now(), reason: 'completed' });
    // Its pull request still open is followed to its end (issue #927): closed, the follow ends.
    gh.closePullRequest(((await jobFor(app, first!.url)).sourceState?.source as { pullRequest: string }).pullRequest);
    gh.calls.length = 0;
    await app.sync();
    await waitFor(() => gh.issue(REPO, first!.number).labels.includes('hopper:done'), { what: 'hopper:done' });
    // The changed one is read again; the others' pull requests are answered by the in-motion cycle's batch (issue #985).
    expect(gh.calls.filter((c) => c.method === 'getIssue').map((c) => c.args[1])).toContain(first!.number);
    expect(gh.calls.map((c) => c.method)).toContain('pullRequestStates');
  });
});
