// Run again on a GitHub job end to end (issues #313, #354): the source clears the job's end — reopening a
// closed issue — and the new job is queued at once, linked to the one it runs again. Real daemon, in-memory fake
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

describe('Run again on a GitHub job', () => {
  it('Run again on a failed job queues a new job at once, linked to the failed one, its end cleared at the source (issues #313, #354)', async () => {
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
    // The answer is the new job, already in the hopper: no later sync is needed to create it.
    expect(r.body).toMatchObject({ rerunOf: first!.id, source: { key: issue.url } });
    expect(r.body.id).not.toBe(first!.id);
    expect((await jobsFor()).map((j) => j.id)).toContain(r.body.id);
    expect(gh.calls).toContainEqual(expect.objectContaining({ method: 'removeLabels', args: [REPO, issue.number, expect.arrayContaining(['hopper:failed', 'hopper:claimed'])] }));
    expect((await a.events('types=job.rerun')).map((e) => e.jobId)).toEqual([first!.id]);
    expect((await a.events('types=job.queued')).filter((e) => e.jobId === r.body.id)).toHaveLength(1);

    await a.sync();
    expect(await jobsFor()).toHaveLength(2);
    await waitFor(() => gh.issue(REPO, issue.number).labels.includes('hopper:failed'), { what: 'hopper:failed again' });
    // Only the newest job of an item runs again: the first one is history now.
    expect((await a.ui(`/ui/api/jobs/${first!.id}/rerun`, {}, { token })).status).toBe(409);
  });

  it('Run again on a failed job whose issue is closed reopens the issue and runs the new job against it (issue #354)', async () => {
    const gh = createFakeGitHub();
    const a = await boot(gh);
    const token = await a.login();
    const issue = gh.createIssue({ repo: REPO, body: '{"op":"fail","message":"boom"}', labels: ['hopper'] });
    const jobsFor = async () => (await a.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs.filter((j) => j.source?.key === issue.url);
    await a.sync();
    await waitFor(() => gh.issue(REPO, issue.number).labels.includes('hopper:failed'), { what: 'hopper:failed' });
    const [first] = await jobsFor();
    gh.closeIssue(REPO, issue.number, undefined, { reason: 'not_planned' });

    const r = await a.ui<Job>(`/ui/api/jobs/${first!.id}/rerun`, {}, { token });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ rerunOf: first!.id });
    expect(gh.issue(REPO, issue.number).state).toBe('open');
    expect((await a.events('types=job.rerun')).map((e) => e.jobId)).toEqual([first!.id]);

    // It runs through the queue to its own end, never cancelled for a closed issue.
    const second = await a.waitForStatus(r.body.id, 'failed');
    expect(second.error).toBe('boom');
    await a.sync();
    expect((await jobsFor()).map((j) => j.status)).toEqual(['failed', 'failed']);
  });
});
