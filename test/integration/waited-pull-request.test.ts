// A job waiting on a pull request (issue #1433), over the real daemon and the in-memory fake GitHub: when no job follows
// that pull request, no follow records its end, so the sync reads it. Closed without a merge, or merged, the job is woken
// within one sync (`job.waited_pull_request_ended`, then `job.wait_ended { by: hopper }`); open, it still waits.
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

/** A job of the github source, on its own wait on pull request `number` of its repository; no job follows that one. */
function waitingOn(app: TestApp, gh: FakeGitHub, number: number): Job {
  // Labelled and assigned, so the source's check keeps it: only the pull request it waits on ends its wait.
  const issue = gh.createIssue({ repo: REPO, body: 'Waits on another change.', labels: ['hopper'], assignees: ['owner'] });
  const { store } = app.user();
  return store.tx(() => {
    const job = store.jobs.create({ executor: 'scripted', payload: {} }, 50, { source: 'github', kind: 'github-account', key: issue.url, url: issue.url, repo: REPO, number: issue.number });
    return store.jobs.update(job.id, { status: 'waiting_on', wait: { for: 'the other change to land', on: { kind: 'pull_request', number, about: 'merge' }, since: new Date().toISOString() } });
  });
}

const numberOf = (url: string) => Number(url.slice(url.lastIndexOf('/') + 1));
const endedWaits = async (app: TestApp, jobId: string) => (await app.events('types=job.wait_ended')).filter((e) => e.jobId === jobId).map((e) => e.data);

describe('a job waiting on a pull request no job follows (issue #1433)', () => {
  it('closed without a merge: woken at the next sync, told it was closed; open, it still waits', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const other = gh.createIssue({ repo: REPO });
    const pr = gh.openPullRequest(REPO, other.number, { createdAt: new Date().toISOString() });
    const job = waitingOn(app, gh, numberOf(pr.url));

    await app.sync();
    expect((await app.job(job.id)).status).toBe('waiting_on');
    expect(await endedWaits(app, job.id)).toEqual([]);

    gh.closePullRequest(pr.url);
    await app.sync();
    await waitFor(async () => (await endedWaits(app, job.id)).length > 0, { what: 'job.wait_ended' });
    expect(await endedWaits(app, job.id)).toEqual([{ by: 'hopper', note: `${pr.url} was closed` }]);
    expect((await app.events('types=job.waited_pull_request_ended')).map((e) => [e.jobId, e.data])).toEqual([[job.id, { pullRequest: pr.url, state: 'closed' }]]);
  });

  it('merged: woken at the next sync, told it was merged', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const other = gh.createIssue({ repo: REPO });
    const pr = gh.openPullRequest(REPO, other.number, { createdAt: new Date().toISOString() });
    const job = waitingOn(app, gh, numberOf(pr.url));
    gh.mergePullRequest(pr.url);
    await app.sync();
    await waitFor(async () => (await endedWaits(app, job.id)).length > 0, { what: 'job.wait_ended' });
    expect(await endedWaits(app, job.id)).toEqual([{ by: 'hopper', note: `${pr.url} was merged` }]);
  });
});
