// Intake by label and assignee (issue #387), end to end through the real daemon against the in-memory
// fake GitHub at the GitHubApi seam. A user's source takes an open issue that carries the source label and
// is assigned to the user's connected account, whoever filed it. Rejecting it is the user's own record: the
// issue gets no label, no comment, is never closed, and is not taken again until it is assigned to the user
// again or run again. Unassigned while waiting, its job leaves the queue; while running, the job is flagged
// and the user decides.
import { afterEach, describe, expect, it } from 'vitest';
import type { Job } from '../../src/domain/types.ts';
import { createFakeGitHub, type FakeGitHub } from '../../src/sources/index.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { connectGitHub } from '../support/github-account.ts';
import { waitFor } from '../support/wait.ts';

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
const jobsFor = async (a: TestApp, url: string): Promise<Job[]> =>
  (await a.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs.filter((j) => j.source?.key === url);
const setGate = (a: TestApp, token: string, mode: string) => a.ui('/ui/api/queue-gate', { mode, autoAcceptPerHour: null }, { token });

describe('intake by label and assignee (issue #387)', () => {
  it('an issue filed by any account, labelled and assigned to the user, becomes a job on the next sync', async () => {
    const gh = createFakeGitHub();
    const a = await boot(gh);
    const issue = gh.createIssue({ repo: REPO, author: 'stranger', assignees: ['owner'], body: body({ op: 'sleep', ms: 10000 }), labels: ['hopper'] });
    await a.sync();
    const [job] = await jobsFor(a, issue.url);
    expect(job).toMatchObject({ source: { author: 'stranger', assignee: 'owner' } });
  });

  it('not assigned, assigned to someone else, or without the label: no job', async () => {
    const gh = createFakeGitHub();
    const a = await boot(gh);
    const unassigned = gh.createIssue({ repo: REPO, assignees: [], body: body({ op: 'echo' }), labels: ['hopper'] });
    const someoneElse = gh.createIssue({ repo: REPO, assignees: ['someone'], body: body({ op: 'echo' }), labels: ['hopper'] });
    const unlabelled = gh.createIssue({ repo: REPO, assignees: ['owner'], body: body({ op: 'echo' }), labels: [] });
    await a.sync();
    for (const i of [unassigned, someoneElse, unlabelled]) expect(await jobsFor(a, i.url)).toEqual([]);
    expect(gh.issue(REPO, unassigned.number).labels).toEqual(['hopper']);
  });

  it('a config with the old authors option loads; the option is ignored', async () => {
    const gh = createFakeGitHub();
    const db = tempDbPath();
    cleanup = db.cleanup;
    const plugins = { jobSources: [{ name: 'github', plugin: 'github-account', options: {
      pollSeconds: 3600, authors: ['someone-else'], executor: 'scripted',
    } }] };
    const a = await startTestApp({ dbPath: db.dbPath, env: {}, seams: { github: gh }, plugins });
    apps.push(a);
    connectGitHub(a, [REPO]);
    const issue = gh.createIssue({ repo: REPO, author: 'owner', body: body({ op: 'sleep', ms: 10000 }), labels: ['hopper'] });
    await a.sync();
    expect(await jobsFor(a, issue.url)).toHaveLength(1);
  });

  it('reject with a reason: the job ends rejected, the issue is left alone, and it is not taken again until reassigned', async () => {
    const gh = createFakeGitHub();
    const a = await boot(gh);
    const token = await a.login();
    await setGate(a, token, 'review');
    const issue = gh.createIssue({ repo: REPO, author: 'stranger', body: body({ op: 'echo' }), labels: ['hopper'] });
    await a.sync();
    const [job] = await jobsFor(a, issue.url);
    const r = await a.ui<Job>(`/ui/api/jobs/${job!.id}/reject`, { reason: 'not mine to do' }, { token });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'rejected', error: 'not mine to do' });
    expect((await a.events('types=job.rejected')).map((e) => [e.jobId, e.data])).toEqual([[job!.id, { by: 'user', reason: 'not mine to do' }]]);
    await waitFor(() => !gh.issue(REPO, issue.number).labels.includes('hopper:claimed'), { what: 'claim label removed' });
    expect(gh.issue(REPO, issue.number)).toMatchObject({ state: 'open', labels: ['hopper'], assignees: ['owner'] });
    expect(gh.commentsOn(REPO, issue.number)).toEqual([]);

    await a.sync();
    expect(await jobsFor(a, issue.url)).toHaveLength(1);

    gh.unassign(REPO, issue.number, 'owner');
    await a.sync();
    gh.assign(REPO, issue.number, 'owner');
    await a.sync();
    const jobs = await jobsFor(a, issue.url);
    expect(jobs).toHaveLength(2);
    expect(jobs.find((j) => j.id !== job!.id)).toMatchObject({ status: 'held', accepted: false });
  });

  it('reject without a reason says the user rejected it; Run again queues the rejected issue again', async () => {
    const gh = createFakeGitHub();
    const a = await boot(gh);
    const token = await a.login();
    await setGate(a, token, 'review');
    const issue = gh.createIssue({ repo: REPO, body: body({ op: 'echo' }), labels: ['hopper'] });
    await a.sync();
    const [job] = await jobsFor(a, issue.url);
    expect((await a.ui<Job>(`/ui/api/jobs/${job!.id}/reject`, {}, { token })).body).toMatchObject({ status: 'rejected', error: 'rejected by the user' });
    await waitFor(async () => (await jobsFor(a, issue.url))[0]!.sourceState?.sync?.finalReported === true, { what: 'rejection reported' });
    const again = await a.ui<Job>(`/ui/api/jobs/${job!.id}/rerun`, {}, { token });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ rerunOf: job!.id, source: { key: issue.url } });
  });

  it('unassigned while waiting: the job leaves the queue', async () => {
    const gh = createFakeGitHub();
    const a = await boot(gh);
    const token = await a.login();
    await setGate(a, token, 'review');
    const issue = gh.createIssue({ repo: REPO, body: body({ op: 'echo' }), labels: ['hopper'] });
    await a.sync();
    const [job] = await jobsFor(a, issue.url);
    gh.unassign(REPO, issue.number, 'owner');
    await a.sync();
    await a.waitForStatus(job!.id, 'cancelled');
    expect((await a.events('types=job.cancelled')).map((e) => [e.jobId, e.data.reason])).toEqual([[job!.id, 'unassigned']]);
  });

  it('unassigned while running: the job runs on, flagged; assigned again, the flag goes; the user may stop it', async () => {
    const gh = createFakeGitHub();
    const a = await boot(gh);
    const token = await a.login();
    const issue = gh.createIssue({ repo: REPO, body: body({ op: 'sleep', ms: 10000 }), labels: ['hopper'] });
    await a.sync();
    const [job] = await jobsFor(a, issue.url);
    await a.waitForStatus(job!.id, 'running');

    gh.unassign(REPO, issue.number, 'owner');
    await a.sync();
    await a.sync();
    const flagged = (await jobsFor(a, issue.url))[0]!;
    expect(flagged.status).toBe('running');
    expect(flagged.sourceState?.sync?.unassignedAt).toEqual(expect.any(String));
    expect((await a.events('types=job.unassigned')).map((e) => [e.jobId, e.data])).toEqual([[job!.id, { assignee: 'owner' }]]);

    gh.assign(REPO, issue.number, 'owner');
    await a.sync();
    expect((await jobsFor(a, issue.url))[0]!.sourceState?.sync?.unassignedAt).toBeUndefined();
    expect((await a.events('types=job.reassigned')).map((e) => [e.jobId, e.data])).toEqual([[job!.id, { assignee: 'owner' }]]);

    gh.unassign(REPO, issue.number, 'owner');
    await a.sync();
    expect((await a.ui(`/ui/api/jobs/${job!.id}/cancel`, {}, { token })).status).toBe(200);
    await a.waitForStatus(job!.id, 'cancelled');
  });
});
