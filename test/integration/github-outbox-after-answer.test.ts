// Issue #1238 part 5: Failures' Retry is a row of the GitHub outbox, over the real daemon and its store. The press keeps
// one row naming the failure record; the sync loop checks it again at the send and runs it: the issue is given back, the
// new job follows with who pressed it, and the record is retried. A row a stopped hopper left in the store is sent by the
// sync loop on its own. In-memory fake GitHub at the GitHubApi seam, held to see the row before its send.
import { afterEach, describe, expect, it } from 'vitest';
import type { FailuresView, Job } from '../../src/domain/types.ts';
import { createFakeGitHub, type FakeGitHub } from '../../src/sources/index.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { connectGitHub } from '../support/github-account.ts';
import { slowGitHub } from '../support/slow-github.ts';
import { waitFor } from '../support/wait.ts';

const REPO = 'owner/hopper-sandbox';
const apps: TestApp[] = [];
let cleanup: (() => void) | undefined;

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  cleanup?.();
  cleanup = undefined;
});

async function boot() {
  const gh = createFakeGitHub();
  const slow = slowGitHub(gh);
  const db = tempDbPath();
  cleanup = db.cleanup;
  const plugins = { jobSources: [{ name: 'github', plugin: 'github-account', options: { enabled: true, pollSeconds: 3600, executor: 'scripted' } }] };
  const a = await startTestApp({ dbPath: db.dbPath, env: {}, seams: { github: slow.api }, plugins });
  apps.push(a);
  connectGitHub(a, [REPO]);
  return { a, gh, slow, token: await a.login() };
}

const failuresOf = async (a: TestApp) => (await a.api<FailuresView>('GET', '/api/failures')).body;
const jobsOf = async (a: TestApp, key: string) => (await a.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs.filter((j) => j.source?.key === key);

/** A GitHub issue whose first job fails, its end reported, and its failure record that Retry takes. */
async function failed(a: TestApp, gh: FakeGitHub) {
  const issue = gh.createIssue({ repo: REPO, body: '{"op":"echo"}\n\nFix the typo.', labels: ['hopper'] });
  await a.sync();
  const [job] = await jobsOf(a, issue.url);
  await a.waitForStatus(job!.id, 'failed', 8000);
  await waitFor(async () => (await a.job(job!.id)).sourceState?.sync?.finalReported === true, { what: 'its end reported' });
  const record = await waitFor(async () => (await failuresOf(a)).recent.find((r) => r.jobId === job!.id && r.actions.retry.ok), { what: 'the failure' });
  return { issue, job: job!, record };
}

describe('Failures\' Retry in the GitHub outbox (issue #1238 part 5)', () => {
  it('the press keeps one row naming the record; sent, the new job follows with who pressed it, and the record is retried', { timeout: 30_000 }, async () => {
    const { a, gh, slow, token } = await boot();
    const { job, record } = await failed(a, gh);
    slow.hold();
    expect(await a.ui(`/ui/api/failures/${record.id}/retry`, {}, { token })).toMatchObject({ status: 202, body: { jobId: job.id, giveBack: 'retry' } });
    const rows = a.user().store.githubOutbox.open('github').filter((r) => r.change.op === 'give_back');
    expect(rows).toMatchObject([{ act: 'retry', tag: job.id, change: { op: 'give_back', act: 'retry', jobId: job.id, target: record.id, acting: { via: 'ui' } } }]);
    slow.release();
    const next = await waitFor(async () => (await jobsOf(a, job.source!.key)).find((j) => j.rerunOf === job.id), { what: 'the new job', timeoutMs: 10_000 });
    await waitFor(async () => (await failuresOf(a)).ended.find((x) => x.id === record.id && x.outcome === 'retried' && x.nextJobId === next.id), { what: 'the record retried' });
    const rerun = a.user().store.events.recent(10, ['job.rerun']).find((e) => e.jobId === job.id);
    expect(rerun?.data).toMatchObject({ person: expect.any(String), via: 'ui' });
    await waitFor(() => a.user().store.githubOutbox.open('github').length === 0, { what: 'no row left' });
  });

  it('a Retry row a stopped hopper left in the store is sent by the sync loop: checked again, then run', { timeout: 30_000 }, async () => {
    const { a, gh } = await boot();
    const { job, record } = await failed(a, gh);
    const at = new Date().toISOString();
    a.user().store.githubOutbox.add([{
      source: 'github', repo: REPO, key: job.source!.key, act: 'retry', tag: job.id, createdBy: 'Pat',
      change: { op: 'give_back', act: 'retry', jobId: job.id, acting: { person: 'Pat', via: 'ui' }, target: record.id, at },
    }], at);
    const next = await waitFor(async () => (await jobsOf(a, job.source!.key)).find((j) => j.rerunOf === job.id), { what: 'the new job', timeoutMs: 15_000 });
    await waitFor(async () => (await failuresOf(a)).ended.find((x) => x.id === record.id && x.outcome === 'retried' && x.nextJobId === next.id), { what: 'the record retried' });
    expect(a.user().store.events.recent(10, ['job.rerun']).find((e) => e.jobId === job.id)?.data).toMatchObject({ person: 'Pat', via: 'ui' });
  });
});
