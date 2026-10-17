// A job on its own wait whose item closes (issue #1460), over the real daemon and the in-memory fake GitHub. Its issue
// closed by its own work — the merge of its own pull request, or closed as completed — ends it finished at the next sync;
// closed any other way ends it cancelled, `issue closed`. Either way its claim labels come off. And a person cancels any job
// that has not ended, with a reason, through `POST /ui/api/jobs/:id/cancel` or `hopper job cancel`.
import { afterEach, describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../../src/cli.ts';
import type { Job } from '../../src/domain/types.ts';
import { createFakeGitHub, type FakeGitHub } from '../../src/sources/index.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { databaseUrlFor } from '../support/database.ts';
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

/** A claimed job of the github source on its own wait on something outside: nothing the hopper sees ends that wait. */
function waiting(app: TestApp, gh: FakeGitHub): Job {
  const issue = gh.createIssue({ repo: REPO, body: 'Waits on another change.', labels: ['hopper', 'hopper:claimed'], assignees: ['owner'] });
  const { store } = app.user();
  return store.tx(() => {
    const job = store.jobs.create({ executor: 'scripted', payload: {} }, 50, { source: 'github', kind: 'github-account', key: issue.url, url: issue.url, repo: REPO, number: issue.number });
    const since = new Date().toISOString();
    return store.jobs.update(job.id, { status: 'waiting_on', startedAt: since, wait: { for: 'the hopper to be reachable', on: { kind: 'outside', what: 'the hopper to be reachable' }, since } });
  });
}

const reported = (app: TestApp, id: string) => waitFor(async () => (await app.job(id)).sourceState?.sync?.finalReported === true, { what: 'its end reported' });
const claimLabels = (gh: FakeGitHub, number: number) => gh.issue(REPO, number).labels.filter((l) => l === 'hopper:claimed' || l.startsWith('hopper:held-by:'));

describe('a job on its own wait whose item closes (issue #1460)', () => {
  it('its issue closed by the merge of its own pull request: it ends finished, hopper:done, its claim labels off', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const job = waiting(app, gh);
    const now = new Date().toISOString();
    gh.closeByPullRequest(REPO, job.source!.number!, { createdAt: now, mergedAt: now });
    await app.sync();
    await app.waitForStatus(job.id, 'finished');
    expect((await app.events('types=job.finished')).find((e) => e.jobId === job.id)?.data).toEqual({ result: 'issue closed as complete' });
    expect((await app.job(job.id)).wait).toBeUndefined();
    await reported(app, job.id);
    expect(claimLabels(gh, job.source!.number!)).toEqual([]);
    expect(gh.issue(REPO, job.source!.number!).labels).toContain('hopper:done');
  });

  it('its issue closed as completed by hand: it ends finished', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const job = waiting(app, gh);
    gh.closeIssue(REPO, job.source!.number!, 'owner', { at: new Date().toISOString() });
    await app.sync();
    await app.waitForStatus(job.id, 'finished');
  });

  it('its issue closed as not planned: it ends cancelled with the reason, its claim labels off', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const job = waiting(app, gh);
    gh.closeIssue(REPO, job.source!.number!, 'owner', { at: new Date().toISOString(), reason: 'not_planned' });
    await app.sync();
    await app.waitForStatus(job.id, 'cancelled');
    expect((await app.events('types=job.cancelled')).find((e) => e.jobId === job.id)?.data).toEqual({ reason: 'issue closed' });
    await reported(app, job.id);
    expect(claimLabels(gh, job.source!.number!)).toEqual([]);
  });

  it('its issue still open: it still waits', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const job = waiting(app, gh);
    await app.sync();
    expect((await app.job(job.id)).status).toBe('waiting_on');
  });
});

describe('a person cancels a job with a reason (issue #1460)', () => {
  it('through the API: a job on its own wait ends cancelled, the reason kept on job.cancelled, its claim labels off', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const job = waiting(app, gh);
    const r = await app.api<Job>('POST', `/ui/api/jobs/${job.id}/cancel`, { reason: 'its work landed by hand' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: job.id, status: 'cancelled' });
    expect((await app.events('types=job.cancelled')).find((e) => e.jobId === job.id)?.data).toEqual({ reason: 'cancelled in UI', note: 'its work landed by hand' });
    await reported(app, job.id);
    expect(claimLabels(gh, job.source!.number!)).toEqual([]);
  });

  it('through the API: an ended job is refused, 409; a reason too long, 400', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const job = waiting(app, gh);
    expect((await app.api('POST', `/ui/api/jobs/${job.id}/cancel`, { reason: 'x'.repeat(501) })).status).toBe(400);
    expect((await app.api('POST', `/ui/api/jobs/${job.id}/cancel`, {})).status).toBe(200);
    expect((await app.events('types=job.cancelled')).find((e) => e.jobId === job.id)?.data).toEqual({ reason: 'cancelled in UI' });
    expect((await app.api('POST', `/ui/api/jobs/${job.id}/cancel`, {})).status).toBe(409);
  });

  it('through the CLI: hopper job cancel <id> --reason <text>', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const job = waiting(app, gh);
    const out: string[] = [];
    const err: string[] = [];
    const io: CliIo = { env: { HOPPER_DATABASE_URL: databaseUrlFor(app.dbPath) }, stdin: () => '', out: (x) => out.push(x), err: (x) => err.push(x) };
    expect(await runCli(['job', 'cancel', job.id, '--reason', 'superseded by hand', '--url', app.url], io)).toBe(0);
    expect(JSON.parse(out.join(''))).toMatchObject({ id: job.id, status: 'cancelled' });
    expect((await app.events('types=job.cancelled')).find((e) => e.jobId === job.id)?.data).toEqual({ reason: 'cancelled in UI', note: 'superseded by hand' });
  });
});
