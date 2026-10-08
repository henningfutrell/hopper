// The failure assessor end to end (issue #509): real daemon, real database, the manual source. Every failed job is
// assessed — an event with its decision and reasons, the assessment on the job. A transient failure runs again
// with backoff until the retry limit, then goes to a person. Several jobs failing with one shared cause are one
// problem: affected and queued jobs are held or redirected, and released when the problem is resolved. Retries
// and holds outlive a restart. The settings apply without one. The API refuses what the view does not offer.
import { afterEach, describe, expect, it } from 'vitest';
import type { DomainEvent, FailureSettings, FailuresView, Job } from '../../src/domain/types.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { createManualSource } from '../support/manual-source.ts';
import { waitFor } from '../support/wait.ts';

const apps: TestApp[] = [];
let cleanup: (() => void) | undefined;

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  cleanup?.();
});

async function boot(o: { dbPath?: string; source?: ReturnType<typeof createManualSource> } = {}) {
  let dbPath = o.dbPath;
  if (!dbPath) {
    const db = tempDbPath();
    cleanup = db.cleanup;
    dbPath = db.dbPath;
  }
  const a = await startTestApp({ dbPath, plugins: { machines: lanes(4) }, ...(o.source ? { source: o.source } : {}) });
  apps.push(a);
  return a;
}

const failuresOf = async (a: TestApp): Promise<FailuresView> => (await a.api<FailuresView>('GET', '/api/failures')).body;
const fail = (message: string, ms = 0) => ({ op: 'fail', message, ms });
const assessedOf = async (a: TestApp, jobId: string): Promise<DomainEvent> =>
  waitFor(async () => (await a.events('types=job.assessed&limit=1000')).find((e) => e.jobId === jobId), { what: `job ${jobId} assessed` });
/** Every job of the item `key`, oldest first. */
const chain = async (a: TestApp, key: string): Promise<Job[]> =>
  (await a.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs.filter((j) => j.source?.key === key).reverse();

async function settings(a: TestApp, token: string, patch: Partial<FailureSettings>): Promise<FailureSettings> {
  const r = await a.ui<FailureSettings>('/ui/api/failures/settings', patch, { token });
  expect(r.status).toBe(200);
  return r.body;
}

describe('every failed job is assessed', () => {
  it('a job-specific failure: an event with its decision and reasons, the assessment on the job, a summary for a person', async () => {
    const a = await boot();
    const job = await a.pull(fail('HOPPER_FAILED the tests do not pass'));
    await a.waitForStatus(job.id, 'failed');
    const e = await assessedOf(a, job.id);
    expect(e.data).toMatchObject({ class: 'job', decision: 'person', auto: true, attempt: 1 });
    expect((e.data.reasons as string[]).length).toBeGreaterThan(0);
    const assessed = await waitFor(async () => (await a.job(job.id)).assessment);
    expect(assessed).toMatchObject({ decision: 'person', class: 'job' });
    expect(assessed.summary).toMatch(/^Needs a person\. Ran 1 time on .+\. Failed: HOPPER_FAILED the tests do not pass\.$/);
    const view = await failuresOf(a);
    expect(view.recent[0]).toMatchObject({ jobId: job.id, decision: 'person', outcome: 'surfaced' });
    expect(view.problems).toEqual([]);
    expect(view.profile.signatures[0]).toMatchObject({ count: 1, jobs: 1, cls: 'job' });
  });
});

describe('a transient failure', () => {
  it('runs again with backoff, by the assessor, until the retry limit; then it goes to a person', async () => {
    const a = await boot();
    const token = await a.login();
    // Settings apply without a restart.
    await settings(a, token, { maxAttempts: 2, backoffSec: 1, backoffFactor: 1 });
    const first = await a.pull(fail('read ECONNRESET'));
    const key = first.source!.key;
    const jobs = await waitFor(async () => { const c = await chain(a, key); return c.length === 3 && c[2]!.status === 'failed' ? c : undefined; }, { timeoutMs: 10_000, what: 'two retries' });
    const reruns = (await a.events('types=job.rerun&limit=1000')).filter((e) => jobs.some((j) => j.id === e.jobId));
    expect(reruns.map((e) => [e.jobId, e.data.by])).toEqual([[jobs[0]!.id, 'assessor'], [jobs[1]!.id, 'assessor']]);
    const firstAssessed = await assessedOf(a, jobs[0]!.id);
    expect(firstAssessed.data).toMatchObject({ class: 'transient', decision: 'retry', attempt: 1 });
    // Backoff: not run again before its retry time.
    const retryAt = Date.parse(firstAssessed.data.retryAt as string);
    expect(retryAt - Date.parse(firstAssessed.at)).toBeGreaterThanOrEqual(900);
    expect(Date.parse(reruns[0]!.at)).toBeGreaterThanOrEqual(retryAt);
    const last = await assessedOf(a, jobs[2]!.id);
    expect(last.data).toMatchObject({ decision: 'person', attempt: 3 });
    expect((last.data.reasons as string[]).join(' ')).toMatch(/retry limit reached: 2 retries/);
    await new Promise((r) => setTimeout(r, 1500));
    expect(await chain(a, key)).toHaveLength(3);
  });

  it('automatic retry off: recommended, and run again only by a person', async () => {
    const a = await boot();
    const token = await a.login();
    await settings(a, token, { auto: { retry: false, hold: true, redirect: true } });
    const job = await a.pull(fail('read ECONNRESET'));
    expect((await assessedOf(a, job.id)).data).toMatchObject({ decision: 'retry', auto: false });
    const record = await waitFor(async () => (await failuresOf(a)).recent.find((r) => r.jobId === job.id && r.actions.retry.ok));
    expect(await chain(a, job.source!.key)).toHaveLength(1);
    const r = await a.ui<Job>(`/ui/api/failures/${record.id}/retry`, {}, { token });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ rerunOf: job.id });
    // Once done, it is not offered again, and the API says why.
    const again = await a.ui<{ error: string }>(`/ui/api/failures/${record.id}/retry`, {}, { token });
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/already/);
  });
});

const SHARED = [
  { name: 'the socket path crash', messages: ['/tmp/a1b2c3d4/herdr-11/control.sock', '/home/x/.hopper-scratch/77aa88bb/sock', '/var/tmp/9/s.sock'].map((p) => `herdr: Error: Socket path too long: ${p}`), title: /^Socket path too long/ },
  { name: 'an expired login', messages: ['claude: Not logged in · Please run /login', 'claude: Not logged in · Please run /login', 'claude: Not logged in · Please run /login'], title: /^Login expired/ },
  { name: 'a full disk', messages: ['write /w/1: ENOSPC: no space left on device', 'write /w/2: ENOSPC: no space left on device', 'write /w/3: ENOSPC: no space left on device'], title: /^Disk full/ },
  { name: 'an offline machine', messages: ['machine desk did not reconnect within 60 s after the daemon restart', 'machine desk did not reconnect within 90 s after the daemon restart', 'machine desk did not reconnect within 30 s after the daemon restart'], title: /^Machine offline/ },
];

describe('one shared cause on several jobs', () => {
  it.each(SHARED)('$name: one problem with its jobs; queued jobs held; released when resolved', async ({ messages, title }) => {
    const a = await boot();
    const token = await a.login();
    const failing = await Promise.all(messages.map((m) => a.pull(fail(m, 800))));
    for (const j of failing) await a.waitForStatus(j.id, 'failed');
    const problem = await waitFor(async () => {
      const open = (await failuresOf(a)).problems.filter((p) => p.status === 'open');
      return open.length === 1 && open[0]!.jobIds.length === 3 ? open[0] : undefined;
    }, { what: 'one open problem with three jobs' });
    expect(problem.title).toMatch(title);
    expect(problem.actions.resolve).toEqual({ ok: true });
    const grouped = (await a.events('types=failure.grouped&limit=1000'));
    expect(grouped.filter((e) => e.data.opened === true)).toHaveLength(1);
    expect(grouped.map((e) => e.jobId).sort()).toEqual(failing.map((j) => j.id).sort());
    // Each affected job is held, or already run again elsewhere (redirected) and held there in the queue.
    const records = (await failuresOf(a)).recent.filter((r) => problem.jobIds.includes(r.jobId));
    for (const r of records) expect(['held', 'redirected']).toContain(r.outcome);

    // A job queued now waits for the problem.
    const queued = await a.pull({ op: 'echo', message: 'hi' });
    const held = await a.waitForStatus(queued.id, 'held');
    expect(held.holdReason).toBe(`held by problem: ${problem.title}`);

    const r = await a.ui(`/ui/api/failures/problems/${problem.id}/resolve`, {}, { token });
    expect(r.status).toBe(200);
    const resolved = await waitFor(async () => (await a.events('types=failure.resolved')).find((e) => e.data.problemId === problem.id));
    expect(resolved.data).toMatchObject({ by: 'user' });
    await a.waitForStatus(queued.id, 'finished');
    // Every affected job's item ran again.
    for (const j of failing) await waitFor(async () => (await chain(a, j.source!.key)).length >= 2, { what: `job ${j.id} released` });
    // Resolved: no longer offered, and the API refuses with the reason.
    const again = await a.ui<{ error: string }>(`/ui/api/failures/problems/${problem.id}/resolve`, {}, { token });
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/already resolved/);
  });

  it('an automatic hold switched off: still one problem, but queued jobs run', async () => {
    const a = await boot();
    const token = await a.login();
    await settings(a, token, { auto: { retry: true, hold: false, redirect: false } });
    const job = await a.pull(fail('claude: Not logged in · Please run /login'));
    await waitFor(async () => (await failuresOf(a)).problems.find((p) => p.jobIds.includes(job.id)));
    const queued = await a.pull({ op: 'echo' });
    await a.waitForStatus(queued.id, 'finished');
  });
});

describe('across a restart', () => {
  it('a retry due later still runs after the daemon restarts', async () => {
    const db = tempDbPath();
    cleanup = db.cleanup;
    const source = createManualSource();
    const first = await boot({ dbPath: db.dbPath, source });
    const token = await first.login();
    await settings(first, token, { maxAttempts: 1, backoffSec: 3 });
    const job = await first.pull(fail('interrupted by daemon restart'));
    expect((await assessedOf(first, job.id)).data).toMatchObject({ decision: 'retry' });
    await first.stop();

    const second = await boot({ dbPath: db.dbPath, source });
    const rerun = await waitFor(async () => (await second.events('types=job.rerun')).find((e) => e.jobId === job.id), { timeoutMs: 10_000, what: 'the retry after the restart' });
    expect(rerun.data).toEqual({ by: 'assessor' });
    expect((await chain(second, job.source!.key)).length).toBeGreaterThanOrEqual(2);
    expect((await second.events('types=job.assessed')).filter((e) => e.jobId === job.id)).toHaveLength(1);
  });

  it('a hold outlives the restart: queued jobs wait, and resolving releases them', async () => {
    const db = tempDbPath();
    cleanup = db.cleanup;
    const source = createManualSource();
    const first = await boot({ dbPath: db.dbPath, source });
    const job = await first.pull(fail('claude: Not logged in · Please run /login'));
    const problem = await waitFor(async () => (await failuresOf(first)).problems.find((p) => p.jobIds.includes(job.id)));
    await first.stop();

    const second = await boot({ dbPath: db.dbPath, source });
    const token = await second.login();
    const queued = await second.pull({ op: 'echo' });
    expect((await second.waitForStatus(queued.id, 'held')).holdReason).toBe(`held by problem: ${problem.title}`);
    expect((await second.ui(`/ui/api/failures/problems/${problem.id}/release`, {}, { token })).status).toBe(200);
    await waitFor(async () => (await chain(second, job.source!.key)).length === 2, { what: 'the held job released' });
    expect((await second.ui(`/ui/api/failures/problems/${problem.id}/resolve`, {}, { token })).status).toBe(200);
    await second.waitForStatus(queued.id, 'finished');
  });
});

describe('settings and known causes', () => {
  it('defaults, validated edits, an admin\'s only', async () => {
    const a = await boot();
    const token = await a.login();
    expect((await failuresOf(a)).settings).toMatchObject({ maxAttempts: 3, auto: { retry: true, hold: true, redirect: true } });
    expect((await a.ui('/ui/api/failures/settings', { maxAttempts: 99 }, { token })).status).toBe(400);
    expect((await a.ui('/ui/api/failures/settings', {}, { token })).status).toBe(400);
    expect((await settings(a, token, { retentionDays: 30 })).retentionDays).toBe(30);
    expect((await failuresOf(a)).settings.retentionDays).toBe(30);
  });

  it('a person names a signature as a known cause with a default decision; the next failure of it follows', async () => {
    const a = await boot();
    const token = await a.login();
    const job = await a.pull(fail('HOPPER_FAILED the vendored build tool crashed'));
    const record = await waitFor(async () => (await failuresOf(a)).recent.find((r) => r.jobId === job.id));
    const named = await a.ui('/ui/api/failures/causes', { signature: record.signature, name: 'Build tool crash', description: 'the vendored tool', decision: 'hold' }, { token });
    expect(named.status).toBe(200);
    expect((await failuresOf(a)).causes).toContainEqual(expect.objectContaining({ id: `named:${record.signature}`, name: 'Build tool crash', decision: 'hold' }));
    const next = await a.pull(fail('HOPPER_FAILED the vendored build tool crashed'));
    expect((await assessedOf(a, next.id)).data).toMatchObject({ class: 'shared', decision: 'hold', causeId: `named:${record.signature}` });
    expect((await a.ui('/ui/api/failures/causes/forget', { signature: record.signature }, { token })).status).toBe(200);
    expect((await failuresOf(a)).causes.some((c) => c.id === `named:${record.signature}`)).toBe(false);
  });
});
