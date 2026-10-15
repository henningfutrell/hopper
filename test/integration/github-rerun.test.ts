// Run again on a GitHub job end to end (issues #313, #354): the source clears the job's end — reopening a
// closed issue — and the new job is queued at once, linked to the one it runs again. Real daemon, in-memory fake
// GitHub at the GitHubApi seam.
import { afterEach, describe, expect, it } from 'vitest';
import type { Job } from '../../src/domain/types.ts';
import { createFakeGitHub, type FakeGitHub } from '../../src/sources/index.ts';
import { runAgain } from '../support/give-back.ts';
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
    enabled: true, pollSeconds: 3600, executor: 'scripted',
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

    const r = await runAgain(a, first!.id, token);
    expect(r.status).toBe(200);
    // The answer is the new job, already in the hopper: no later sync is needed to create it.
    expect(r.body).toMatchObject({ rerunOf: first!.id, source: { key: issue.url } });
    expect(r.body.id).not.toBe(first!.id);
    // A person's Run again makes no tend job (issue #967): only tending's may elbow in past a lane cap.
    expect(r.body.spec.tend).toBeUndefined();
    expect((await jobsFor()).map((j) => j.id)).toContain(r.body.id);
    expect(gh.calls).toContainEqual(expect.objectContaining({ method: 'removeLabels', args: [REPO, issue.number, expect.arrayContaining(['hopper:failed', 'hopper:claimed'])] }));
    expect((await a.events('types=job.rerun')).map((e) => e.jobId)).toEqual([first!.id]);
    expect((await a.events('types=job.queued')).filter((e) => e.jobId === r.body.id)).toHaveLength(1);

    await a.sync();
    expect(await jobsFor()).toHaveLength(2);
    await waitFor(() => gh.issue(REPO, issue.number).labels.includes('hopper:failed'), { what: 'hopper:failed again' });
    // Only the newest job of an item runs again: the first one is history now.
    expect((await runAgain(a, first!.id, token)).status).toBe(409);
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

    const r = await runAgain(a, first!.id, token);
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
  it('Run again on a job whose issue is no longer assigned to the connected account assigns it again and runs (issues #527, #1010)', async () => {
    const gh = createFakeGitHub();
    const a = await boot(gh);
    const token = await a.login();
    const issue = gh.createIssue({ repo: REPO, body: '{"op":"fail","message":"boom"}', labels: ['hopper'] });
    const jobsFor = async () => (await a.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs.filter((j) => j.source?.key === issue.url);
    await a.sync();
    await waitFor(() => gh.issue(REPO, issue.number).labels.includes('hopper:failed'), { what: 'hopper:failed' });
    const [first] = await jobsFor();
    gh.unassign(REPO, issue.number, 'owner');
    gh.closeIssue(REPO, issue.number, undefined, { reason: 'not_planned' });

    const r = await runAgain(a, first!.id, token);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ rerunOf: first!.id });
    // The hopper took the step a person had to take in Sources: the issue is the connected account's again, and open.
    expect(gh.issue(REPO, issue.number)).toMatchObject({ state: 'open', assignees: expect.arrayContaining(['owner']) });
    // So its new job runs to its own end, never cancelled as unassigned.
    const second = await a.waitForStatus(r.body.id, 'failed');
    expect(second.error).toBe('boom');
  });
});
