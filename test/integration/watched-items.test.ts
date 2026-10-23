// Waits on other items (issue #1508), over the real daemon and the in-memory fake GitHub: a job on an outside wait whose text
// names issues of other repositories, or a workflow run, is woken at a sync once every one ended (`job.waited_items_ended`,
// then `job.wait_ended { by: hopper }`); while one is open, it still waits. An item that ended before the wait began is not
// its event (issue #2219): it does not wake the job. A job woken so that waits again on the same items is not woken for them again.
import { afterEach, describe, expect, it } from 'vitest';
import type { Job, JobWait } from '../../src/domain/types.ts';
import { createFakeGitHub, type FakeGitHub } from '../../src/sources/index.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { connectGitHub } from '../support/github-account.ts';
import { waitFor } from '../support/wait.ts';

const REPO = 'owner/hopper-sandbox';
/** When each test's wait begins: before the fake GitHub's own stamps, which start on 2026-10-02. */
const SINCE = '2026-10-02T00:00:00.000Z';
/** Before the wait began (issue #2219). */
const BEFORE = '2026-10-01T00:00:00.000Z';
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

/** A job of the github source, on its own outside wait `what`, `forText` its `for:`. */
function waitingOn(app: TestApp, gh: FakeGitHub, what: string, forText = 'the other changes'): Job {
  // Labelled and assigned, so the source's check keeps it: only what it waits on ends its wait.
  const issue = gh.createIssue({ repo: REPO, body: 'Waits on other changes.', labels: ['hopper'], assignees: ['owner'] });
  const { store } = app.user();
  return store.tx(() => {
    const job = store.jobs.create({ executor: 'scripted', payload: {} }, 50, { source: 'github', kind: 'github-account', key: issue.url, url: issue.url, repo: REPO, number: issue.number });
    return store.jobs.update(job.id, { status: 'waiting_on', wait: { for: forText, on: { kind: 'outside', what }, since: SINCE } });
  });
}

/** The job waits again, as it was: a new wait on the same items. */
function waitsAgain(app: TestApp, job: Job): void {
  const { store } = app.user();
  store.tx(() => store.jobs.update(job.id, { status: 'waiting_on', wait: { ...(job.wait as JobWait), since: new Date(Date.now() + 1000).toISOString() } }));
}

const endedWaits = async (app: TestApp, jobId: string) => (await app.events('types=job.wait_ended')).filter((e) => e.jobId === jobId).map((e) => e.data);

describe('a job waiting on other items (issue #1508)', () => {
  it('a pull request and an issue closed before the wait began (issue #2219): not woken for them; an item that closes after, woken for it alone', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const issue = gh.createIssue({ repo: 'owner/gitops' });
    const pr = gh.openPullRequest('owner/gitops', issue.number, { createdAt: BEFORE });
    gh.closePullRequest(pr.url, BEFORE);
    const old = gh.createIssue({ repo: 'owner/identity' });
    gh.closeIssue('owner/identity', old.number, undefined, { at: BEFORE });
    const open = gh.createIssue({ repo: 'owner/platform' });
    const prNumber = Number(pr.url.split('/').pop());
    const job = waitingOn(app, gh, `gated: the apply after gitops#${prNumber}, identity#${old.number} and platform#${open.number}`);

    await app.sync();
    expect((await app.job(job.id)).status).toBe('waiting_on');
    expect(await endedWaits(app, job.id)).toEqual([]);

    gh.closeIssue('owner/platform', open.number);
    await app.sync();
    await waitFor(async () => (await endedWaits(app, job.id)).length > 0, { what: 'job.wait_ended' });
    expect(await endedWaits(app, job.id)).toEqual([{ by: 'hopper', note: `${open.url} was closed` }]);
  });

  it('only an item closed before the wait began: not woken for it', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const issue = gh.createIssue({ repo: 'owner/gitops' });
    const pr = gh.openPullRequest('owner/gitops', issue.number, { createdAt: BEFORE });
    gh.closePullRequest(pr.url, BEFORE);
    const job = waitingOn(app, gh, `gated: the apply of owner/gitops#${pr.url.split('/').pop()}`);

    await app.sync();
    expect((await app.job(job.id)).status).toBe('waiting_on');
    expect(await app.events('types=job.waited_items_ended')).toEqual([]);
  });

  it('an issue of another repository, closed after the wait began: woken at the next sync, told so; waiting again on it, not woken again', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const other = gh.createIssue({ repo: 'owner/identity' });
    const job = waitingOn(app, gh, `until identity#${other.number} closes`);
    gh.closeIssue('owner/identity', other.number);

    await app.sync();
    await waitFor(async () => (await endedWaits(app, job.id)).length > 0, { what: 'job.wait_ended' });
    expect(await endedWaits(app, job.id)).toEqual([{ by: 'hopper', note: `${other.url} was closed` }]);
    expect((await app.events('types=job.waited_items_ended')).map((e) => [e.jobId, e.data])).toEqual([[job.id, { items: [{ url: other.url, state: 'closed' }] }]]);

    waitsAgain(app, job);
    await app.sync();
    expect((await app.job(job.id)).status).toBe('waiting_on');
    expect(await endedWaits(app, job.id)).toHaveLength(1);
  });

  it('two items: one closed, it still waits; both, it is woken', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const first = gh.createIssue({ repo: 'owner/ops-tools' });
    const second = gh.createIssue({ repo: 'owner/platform' });
    const job = waitingOn(app, gh, `until ops-tools#${first.number} and platform#${second.number} close with merged pull requests`);

    gh.closeIssue('owner/ops-tools', first.number);
    await app.sync();
    expect((await app.job(job.id)).status).toBe('waiting_on');
    expect(await endedWaits(app, job.id)).toEqual([]);

    gh.closeIssue('owner/platform', second.number);
    await app.sync();
    await waitFor(async () => (await endedWaits(app, job.id)).length > 0, { what: 'job.wait_ended' });
    expect(await endedWaits(app, job.id)).toEqual([{ by: 'hopper', note: `${first.url} was closed; ${second.url} was closed` }]);
  });

  it('an item that does not exist (issue #1691): woken at once at the next sync, told so, though another item is still open', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const open = gh.createIssue({ repo: 'owner/ops-tools' });
    const job = waitingOn(app, gh, `until ledger#330 and ops-tools#${open.number} close`);

    await app.sync();
    await waitFor(async () => (await endedWaits(app, job.id)).length > 0, { what: 'job.wait_ended' });
    const missing = 'https://github.com/owner/ledger/issues/330';
    expect(await endedWaits(app, job.id)).toEqual([{ by: 'hopper', note: `${missing} cannot be read: no such repository or item, or the hopper has no access to it, so the wait never ends on it; check the owner and name you wrote` }]);
    expect((await app.events('types=job.waited_items_ended')).map((e) => [e.jobId, e.data])).toEqual([[job.id, { items: [{ url: missing, state: 'not_found' }] }]]);
  });

  it('an issue of another owner, its name alone in for: (issue #2066): it still waits while that issue is open; closed, it is woken', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const other = gh.createIssue({ repo: 'other-org/identity' });
    const job = waitingOn(app, gh, `other-org/identity#${other.number}`, `the fix in identity#${other.number} to merge`);

    await app.sync();
    expect((await app.job(job.id)).status).toBe('waiting_on');
    expect(await endedWaits(app, job.id)).toEqual([]);

    gh.closeIssue('other-org/identity', other.number);
    await app.sync();
    await waitFor(async () => (await endedWaits(app, job.id)).length > 0, { what: 'job.wait_ended' });
    expect(await endedWaits(app, job.id)).toEqual([{ by: 'hopper', note: `${other.url} was closed` }]);
  });

  it('a workflow run: waiting for a deployment decision, it still waits; completed, it is woken', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    gh.setWorkflowRun('owner/platform', 37998997248, { status: 'waiting' });
    const job = waitingOn(app, gh, "the Production approver's decision on platform run 37998997248");

    await app.sync();
    expect((await app.job(job.id)).status).toBe('waiting_on');

    gh.setWorkflowRun('owner/platform', 37998997248, { status: 'completed', conclusion: 'failure' });
    await app.sync();
    await waitFor(async () => (await endedWaits(app, job.id)).length > 0, { what: 'job.wait_ended' });
    expect(await endedWaits(app, job.id)).toEqual([{ by: 'hopper', note: 'https://github.com/owner/platform/actions/runs/37998997248 completed (failure)' }]);
  });
});
