// Issue #1238 part 4: Run again is a row of the GitHub outbox, over the real daemon and its store. A Run again that GitHub
// refused for now is kept: after a restart the outbox sends it again, the issue is given back and the new job follows,
// with who pressed it. In-memory fake GitHub at the GitHubApi seam.
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
const jobsOf = async (app: TestApp, key: string) => (await app.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs.filter((j) => j.source?.key === key);

describe('Run again in the GitHub outbox (issue #1238 part 4)', () => {
  it('a Run again not sent yet is sent after a restart: the issue is given back and the new job follows, with who pressed it', { timeout: 30_000 }, async () => {
    const db = tempDbPath();
    cleanup = db.cleanup;
    const gh = createFakeGitHub();
    const first = await boot(db.dbPath, gh);
    const issue = gh.createIssue({ repo: REPO, body: '{"op":"fail","message":"boom"}\n\nFix the typo.', labels: ['hopper'] });
    await first.sync();
    const [job] = await jobsOf(first, issue.url);
    await first.waitForStatus(job!.id, 'failed', 8000);
    await waitFor(async () => (await first.job(job!.id)).sourceState?.sync?.finalReported === true, { what: 'its end reported' });
    gh.closeIssue(REPO, issue.number, undefined, { reason: 'not_planned' });

    // GitHub refuses the reopen for now: the row is kept, due again in two seconds.
    gh.failNext('reopenIssue', new GitHubApiError('Server Error (HTTP 502)', false, 502, Date.now() + 2_000));
    const token = await first.login();
    expect(await first.ui(`/ui/api/jobs/${job!.id}/rerun`, {}, { token })).toMatchObject({ status: 202, body: { jobId: job!.id, giveBack: 'rerun' } });
    await waitFor(() => gh.calls.some((c) => c.method === 'reopenIssue'), { what: 'the reopen tried' });
    expect((await jobsOf(first, issue.url)).filter((j) => j.rerunOf === job!.id)).toEqual([]);
    expect(await detail(first)).toMatchObject({ writeBehindPending: 1 });
    expect(first.user().store.events.recent(10, ['job.give_back_failed'])).toEqual([]);
    await first.stop();
    apps.splice(0);
    expect(gh.issue(REPO, issue.number).state).toBe('closed');

    const second = await boot(db.dbPath, gh);
    const rerun = await waitFor(() => second.user().store.events.recent(10, ['job.rerun']).find((e) => e.jobId === job!.id), { what: 'run again after the restart', timeoutMs: 15_000 });
    expect(rerun.data).toMatchObject({ person: expect.any(String), via: 'ui' });
    expect(gh.issue(REPO, issue.number).state).toBe('open');
    expect((await jobsOf(second, issue.url)).filter((j) => j.rerunOf === job!.id)).toHaveLength(1);
    await waitFor(async () => (await detail(second)).writeBehindPending === undefined, { what: 'no row left' });
  });
});
