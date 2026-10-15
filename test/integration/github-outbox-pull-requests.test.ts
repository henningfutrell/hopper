// Issue #1238 part 3: Merge now is a row of the GitHub outbox, over the real daemon and its store. A Merge now that
// GitHub refused for now is kept: after a restart the outbox sends it again, and the merge is recorded with who pressed
// it. In-memory fake GitHub at the GitHubApi seam.
import { afterEach, describe, expect, it } from 'vitest';
import type { Job } from '../../src/domain/types.ts';
import type { GitHubApi } from '../../src/sources/github/api.ts';
import { createFakeGitHub } from '../../src/sources/index.ts';
import { GitHubApiError } from '../../src/sources/github/index.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { connectGitHub } from '../support/github-account.ts';
import { waitFor } from '../support/wait.ts';

const REPO = 'owner/hopper-sandbox';
const apps: TestApp[] = [];
let cleanup: (() => void) | undefined;

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  cleanup?.();
  cleanup = undefined;
});

async function boot(dbPath: string, github: GitHubApi): Promise<TestApp> {
  const plugins = { jobSources: [{ name: 'github', plugin: 'github-account', options: { enabled: true, pollSeconds: 3600, executor: 'scripted' } }] };
  const a = await startTestApp({ dbPath, env: {}, seams: { github }, plugins });
  apps.push(a);
  connectGitHub(a, [REPO]);
  return a;
}

type Detail = { writeBehindPending?: number };
const detail = async (app: TestApp): Promise<Detail> =>
  (await app.api<{ sources: { name: string; detail?: Detail }[] }>('GET', '/api/sources')).body.sources.find((s) => s.name === 'github')?.detail ?? {};

describe('Merge now in the GitHub outbox (issue #1238 part 3)', () => {
  it('a Merge now not sent yet is sent after a restart, and recorded with who pressed it', { timeout: 30_000 }, async () => {
    const db = tempDbPath();
    cleanup = db.cleanup;
    const gh = createFakeGitHub();
    const first = await boot(db.dbPath, gh);
    const issue = gh.createIssue({ repo: REPO, body: '{"op":"echo"}\n\nFix the typo.', labels: ['hopper'] });
    let pr = '';
    first.scripted.ships((j) => { if (j.source?.key === issue.url) pr = gh.openPullRequest(REPO, issue.number, { createdAt: new Date().toISOString(), checks: 'pending' }).url; });
    await first.sync();
    const [job] = (await first.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs.filter((j) => j.source?.key === issue.url);
    await first.waitForStatus(job!.id, 'finished');
    await waitFor(() => gh.issue(REPO, issue.number).labels.includes('hopper:pr-ready'), { what: 'hopper:pr-ready' });

    // GitHub refuses the merge for now: the row is kept, due again in a second.
    gh.failNext('merge', new GitHubApiError('Server Error (HTTP 502)', false, 502, Date.now() + 1_000));
    const token = await first.login();
    expect(await first.ui('/ui/api/pull-requests/merge', { jobId: job!.id }, { token })).toMatchObject({ status: 202, body: { jobId: job!.id, act: 'merge' } });
    await waitFor(() => gh.calls.some((c) => c.method === 'merge'), { what: 'the merge tried' });
    expect(await detail(first)).toMatchObject({ writeBehindPending: 1 });
    expect(first.user().store.events.recent(10, ['job.pull_request_act_failed'])).toEqual([]);
    await first.stop();
    apps.splice(0);
    expect(gh.issue(REPO, issue.number).state).toBe('open');

    const second = await boot(db.dbPath, gh);
    const merged = await waitFor(() => second.user().store.events.recent(10, ['job.pull_request_merged']).find((e) => e.jobId === job!.id), { what: 'merged after the restart', timeoutMs: 15_000 });
    expect(merged.data).toEqual({ pullRequest: pr, part: false, person: expect.any(String), via: 'ui' });
    expect(gh.calls.filter((c) => c.method === 'merge')).toHaveLength(2);
    await waitFor(async () => (await detail(second)).writeBehindPending === undefined, { what: 'no row left' });
  });
});
