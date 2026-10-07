// Run again on a failed GitHub job end to end (issues #313, #348, #362): the source clears the job's end
// and offers the issue again, or refuses while the issue is closed; each sync tells the job whether its
// issue is closed, so the UI offers Run again only on an open one. Real daemon, in-memory fake
// GitHub at the GitHubApi seam.
import { afterEach, describe, expect, it } from 'vitest';
import type { Job } from '../../src/domain/types.ts';
import { createFakeGitHub, type FakeGitHub } from '../../src/sources/index.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
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
    enabled: true, pollSeconds: 3600, authors: ['owner'], executor: 'scripted', defaultCwd: '/tmp',
  } }] };
  const a = await startTestApp({ dbPath: db.dbPath, env: {}, seams: { github: gh }, plugins });
  apps.push(a);
  connectGitHub(a, [REPO]);
  return a;
}

describe('Run again on a failed GitHub job', () => {
  it('Run again on a failed job clears its end at the source and runs the issue again, no label touched by hand (issue #313)', async () => {
    const gh = createFakeGitHub();
    const a = await boot(gh);
    const token = await a.login();
    // An empty body is an invalid item: the job is created and failed at once.
    const issue = gh.createIssue({ repo: REPO, body: '', labels: ['hopper'] });
    const jobsFor = async () => (await a.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs.filter((j) => j.source?.key === issue.url);
    await a.sync();
    await waitFor(() => gh.issue(REPO, issue.number).labels.includes('hopper:failed'), { what: 'hopper:failed' });
    const [first] = await jobsFor();

    const r = await a.ui<Job>(`/ui/api/jobs/${first!.id}/rerun`, {}, { token });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: first!.id, status: 'failed' });
    // The sync the re-run starts may already have failed the new job again: read the label write, not the labels.
    expect(gh.calls).toContainEqual(expect.objectContaining({ method: 'removeLabels', args: [REPO, issue.number, ['hopper:failed', 'hopper:claimed']] }));
    expect((await a.events('types=job.rerun')).map((e) => e.jobId)).toEqual([first!.id]);

    await waitFor(async () => (await jobsFor()).length === 2, { what: 'the re-run job' });
    const second = (await jobsFor()).find((j) => j.id !== first!.id)!;
    await waitFor(() => gh.issue(REPO, issue.number).labels.includes('hopper:failed'), { what: 'hopper:failed again' });
    // Only the newest job of an item runs again: the first one is history now.
    expect((await a.ui(`/ui/api/jobs/${first!.id}/rerun`, {}, { token })).status).toBe(409);
    expect((await a.job(second.id)).status).toBe('failed');
  });

  it('Run again on a failed job whose issue is closed is refused with 409 and records nothing (issue #348)', async () => {
    const gh = createFakeGitHub();
    const a = await boot(gh);
    const token = await a.login();
    const issue = gh.createIssue({ repo: REPO, body: '', labels: ['hopper'] });
    const jobsFor = async () => (await a.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs.filter((j) => j.source?.key === issue.url);
    await a.sync();
    await waitFor(() => gh.issue(REPO, issue.number).labels.includes('hopper:failed'), { what: 'hopper:failed' });
    const [first] = await jobsFor();
    gh.closeIssue(REPO, issue.number);

    const r = await a.ui<{ error: string }>(`/ui/api/jobs/${first!.id}/rerun`, {}, { token });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/cannot run again: its issue is closed/);
    expect(gh.issue(REPO, issue.number)).toMatchObject({ state: 'closed', labels: expect.arrayContaining(['hopper:failed']) });
    expect(await a.events('types=job.rerun')).toEqual([]);
    // The refusal is kept on the job at once: the UI stops offering Run again before the next sync (issue #362).
    expect((await a.job(first!.id)).sourceState?.sync?.itemClosed).toBe(true);
    await a.sync();
    expect(await jobsFor()).toHaveLength(1);
  });

  it('each sync tells a failed job whether its issue is closed, asking GitHub only for an issue its listing did not show (issue #362)', async () => {
    const gh = createFakeGitHub();
    const a = await boot(gh);
    const issue = gh.createIssue({ repo: REPO, body: '', labels: ['hopper'] });
    const jobsFor = async () => (await a.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs.filter((j) => j.source?.key === issue.url);
    const itemClosed = async (id: string) => (await a.job(id)).sourceState?.sync?.itemClosed;
    const reads = () => gh.calls.filter((c) => c.method === 'getIssue').length;
    await a.sync();
    await waitFor(() => gh.issue(REPO, issue.number).labels.includes('hopper:failed'), { what: 'hopper:failed' });
    const [first] = await jobsFor();
    await a.sync();
    expect(await itemClosed(first!.id)).toBe(false);

    // Open, the issue is in the sync's own listing: no read of its own.
    let before = reads();
    await a.sync();
    expect(reads()).toBe(before);

    gh.closeIssue(REPO, issue.number);
    await a.sync();
    expect(await itemClosed(first!.id)).toBe(true);
    // Known closed, it is not read again every sync.
    before = reads();
    await a.sync();
    expect(reads()).toBe(before);

    gh.reopenIssue(REPO, issue.number);
    await a.sync();
    expect(await itemClosed(first!.id)).toBe(false);
  });
});
