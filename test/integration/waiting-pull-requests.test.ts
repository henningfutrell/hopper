// Pull requests of a waiting job (issue #1143 reopened): the newest job of an item is on its own wait on something outside
// (a person's window), and a pull request a job of the item opened through the hopper gets merge conflicts. No follow and no
// tend reaches it while the job waits, so the hopper wakes the job to rebase it, says so on the pull request, and records
// which pull request woke it. Real daemon, in-memory fake GitHub at the GitHubApi seam.
import { afterEach, describe, expect, it } from 'vitest';
import type { Job, JobWait } from '../../src/domain/types.ts';
import { createFakeGitHub, type FakeGitHub } from '../../src/sources/index.ts';
import { tendNote } from '../../src/sources/github/pr-notes.ts';
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

/** A claimed job of the github source on its own wait on something outside, with a pull request it opened through the hopper. */
function waiting(app: TestApp, gh: FakeGitHub): { job: Job; pull: string; wait: JobWait } {
  const issue = gh.createIssue({ repo: REPO, body: 'Get the cutover ready.', labels: ['hopper', 'hopper:claimed'], assignees: ['owner'] });
  const pull = gh.openUnlinkedPullRequest(REPO, { createdAt: new Date().toISOString(), headRef: `issue-${issue.number}-cutover`, base: 'main', headOid: 'a1' }).url;
  const { store } = app.user();
  const since = new Date().toISOString();
  const wait: JobWait = { for: 'the cutover window', on: { kind: 'outside', what: 'the cutover window' }, since };
  const job = store.tx(() => {
    const j = store.jobs.create({ executor: 'scripted', payload: {} }, 50, { source: 'github', kind: 'github-account', key: issue.url, url: issue.url, repo: REPO, number: issue.number });
    store.events.append({ type: 'github_proxy.done', jobId: j.id, data: { requestId: 'r1', op: 'pr.create', repo: REPO, number: Number(pull.split('/').at(-1)), url: pull } });
    return store.jobs.update(j.id, { status: 'waiting_on', startedAt: since, wait });
  });
  return { job, pull, wait };
}

const wakes = async (app: TestApp, id: string) => (await app.events('types=job.wait_ended')).filter((e) => e.jobId === id).map((e) => e.data);

describe('pull requests of a waiting job (issue #1143 reopened)', () => {
  it('its pull request that gets merge conflicts wakes it to rebase, with no comment from anyone, and says so on it', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const { job, pull } = waiting(app, gh);
    await app.sync();
    expect(await wakes(app, job.id)).toEqual([]);
    expect((await app.job(job.id)).status).toBe('waiting_on');

    gh.setConflicting(pull, true);
    await app.sync();
    await waitFor(async () => (await wakes(app, job.id)).length > 0, { what: 'the hopper wakes the waiting job' });
    expect(await wakes(app, job.id)).toEqual([{ by: 'hopper', note: `${pull} has merge conflicts`, conflicting: pull }]);
    expect((await app.job(job.id)).status).not.toBe('waiting_on');
    await waitFor(async () => gh.pullRequestComments(pull).length > 0, { what: 'the note on the pull request' });
    expect(gh.pullRequestComments(pull)).toEqual([tendNote('rebase')]);
  });

  it('the same head wakes it once: back on its wait with the conflict not resolved, it is not woken again', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const { job, pull, wait } = waiting(app, gh);
    gh.setConflicting(pull, true);
    await app.sync();
    await waitFor(async () => (await wakes(app, job.id)).length > 0, { what: 'the hopper wakes the waiting job' });
    const { store } = app.user();
    await waitFor(async () => !['queued', 'running'].includes(store.jobs.get(job.id)!.status), { what: 'the woken job ends its turn' });
    const since = new Date().toISOString();
    store.tx(() => store.jobs.update(job.id, { status: 'waiting_on', pendingAnswer: undefined, wait: { ...wait, since } }));
    await app.sync();
    await app.sync();
    expect(await wakes(app, job.id)).toHaveLength(1);
    expect(gh.pullRequestComments(pull)).toHaveLength(1);
  });
});
