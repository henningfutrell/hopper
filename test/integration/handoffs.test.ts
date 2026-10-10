// Needs a person (issue #516): a failed job automatic handling has ended for — its retries used up, a job-specific
// failure, an automatic action switched off, a run again refused, or a locked entry dismissed — is handed off to a
// person and stays open until a person resolves it (issue #551, handoff-resolve.test.ts) or its item runs again. Real daemon, real database, the manual source.
// A hand-off outlives a restart; the view offers only what the API takes; entering and leaving are events.
import { afterEach, describe, expect, it } from 'vitest';
import type { DomainEvent, FailureSettings, FailuresView, Handoff, Job } from '../../src/domain/types.ts';
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
const fail = (message: string) => ({ op: 'fail', message, ms: 0 });
const handoffOf = async (a: TestApp, jobId: string) =>
  waitFor(async () => (await failuresOf(a)).handoffs.find((h) => h.jobId === jobId && h.status === 'open'), { what: `job ${jobId} handed off` });
const eventsOf = async (a: TestApp, type: string): Promise<DomainEvent[]> => a.events(`types=${type}&limit=1000`);
const openCount = async (a: TestApp) => (await failuresOf(a)).handoffs.filter((h) => h.status === 'open').length;

async function settings(a: TestApp, token: string, patch: Partial<FailureSettings>): Promise<FailureSettings> {
  const r = await a.ui<FailureSettings>('/ui/api/failures/settings', patch, { token });
  expect(r.status).toBe(200);
  return r.body;
}

describe('a failed job is handed off to a person when automatic handling ends', () => {
  it('retries used up: handed off with the reason, an event, and its assessment summary', async () => {
    const a = await boot();
    const token = await a.login();
    await settings(a, token, { maxAttempts: 1, backoffSec: 1, backoffFactor: 1 });
    const first = await a.pull(fail('read ECONNRESET'));
    const last = await waitFor(async () => {
      const jobs = (await a.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs.filter((j) => j.source?.key === first.source!.key);
      return jobs.length === 2 && jobs[0]!.status === 'failed' ? jobs[0] : undefined;
    }, { timeoutMs: 10_000, what: 'the retry failed too' });
    const h = await handoffOf(a, last.id);
    expect(h).toMatchObject({ reason: 'retry_limit', decision: 'person', class: 'transient' });
    expect(h.summary).toMatch(/^Needs a person\. Ran 2 times/);
    expect(h.reasons.join(' ')).toMatch(/retry limit reached/);
    // The first job ran again by itself: never handed off.
    expect((await failuresOf(a)).handoffs.some((x) => x.jobId === first.id)).toBe(false);
    const opened = await waitFor(async () => (await eventsOf(a, 'handoff.opened')).find((e) => e.jobId === last.id));
    expect(opened.data).toMatchObject({ handoffId: h.id, reason: 'retry_limit', notify: true });
  });

  it('a job-specific failure (decision person): handed off, with every resolution offered', async () => {
    const a = await boot();
    const job = await a.pull(fail('HOPPER_FAILED the tests do not pass'));
    const h = await handoffOf(a, job.id);
    expect(h).toMatchObject({ reason: 'person', error: 'HOPPER_FAILED the tests do not pass' });
    const view = (await failuresOf(a)).handoffs.find((x) => x.id === h.id)!;
    expect(view.actions).toEqual({ continue: { ok: true }, fixed: { ok: true }, doneByHand: { ok: true }, wontDo: { ok: true } });
  });

  it('automatic retry off: the decision waits on a person, so it is handed off', async () => {
    const a = await boot();
    const token = await a.login();
    await settings(a, token, { auto: { retry: false, hold: true, redirect: true, continue: true } });
    const job = await a.pull(fail('read ECONNRESET'));
    expect(await handoffOf(a, job.id)).toMatchObject({ reason: 'auto_off', decision: 'retry' });
  });
});

describe('a person acts on a hand-off', () => {
  it('Won\'t do: it leaves Needs a person and the queue, with an event; refused once done', async () => {
    const a = await boot();
    const token = await a.login();
    const job = await a.pull(fail('HOPPER_FAILED the tests do not pass'));
    const h = await handoffOf(a, job.id);
    expect(await openCount(a)).toBe(1);
    const r = await a.ui<{ handoff: Handoff }>(`/ui/api/failures/handoffs/${h.id}/resolve`, { action: 'wont_do', note: 'not wanted' }, { token });
    expect(r.status).toBe(200);
    expect(r.body.handoff).toMatchObject({ status: 'closed', end: 'wont_do' });
    expect(await openCount(a)).toBe(0);
    const closed = await waitFor(async () => (await eventsOf(a, 'handoff.closed')).find((e) => e.data.handoffId === h.id));
    expect(closed.data).toMatchObject({ end: 'wont_do', resolution: 'wont_do' });
    // Cleared means no more work: the locked entry leaves the queue too, and is not handed off again.
    await waitFor(async () => (await a.job(job.id)).dismissedAt, { what: 'the locked entry dismissed' });
    await new Promise((res) => setTimeout(res, 300));
    expect(await openCount(a)).toBe(0);
    // Still shown, closed, for a day: no action offered, and the API refuses with the same reason.
    const shown = (await failuresOf(a)).handoffs.find((x) => x.id === h.id)!;
    expect(shown.actions.wontDo).toEqual({ ok: false, why: 'already resolved: won\'t do' });
    const again = await a.ui<{ error: string }>(`/ui/api/failures/handoffs/${h.id}/resolve`, { action: 'wont_do', note: 'again' }, { token });
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/already resolved/);
  });

  it('I fixed it: its item is queued again and it leaves Needs a person', async () => {
    const a = await boot();
    const token = await a.login();
    const job = await a.pull(fail('HOPPER_FAILED the tests do not pass'));
    const h = await handoffOf(a, job.id);
    const r = await a.ui<{ job: Job }>(`/ui/api/failures/handoffs/${h.id}/resolve`, { action: 'fixed' }, { token });
    expect(r.status).toBe(200);
    expect(r.body.job).toMatchObject({ rerunOf: job.id });
    const closed = (await failuresOf(a)).handoffs.find((x) => x.id === h.id)!;
    expect(closed).toMatchObject({ status: 'closed', end: 'run_again', nextJobId: r.body.job.id });
    expect(closed.actions.fixed.ok).toBe(false);
    // The new job fails the same way: it is handed off on its own; the first one is not again.
    expect((await failuresOf(a)).handoffs.filter((x) => x.jobId === job.id && x.status === 'open')).toEqual([]);
  });

  it('Run again from the Queue also takes it out of Needs a person', async () => {
    const a = await boot();
    const token = await a.login();
    const job = await a.pull(fail('HOPPER_FAILED the tests do not pass'));
    const h = await handoffOf(a, job.id);
    expect((await a.ui(`/ui/api/jobs/${job.id}/rerun`, {}, { token })).status).toBe(200);
    await waitFor(async () => (await failuresOf(a)).handoffs.find((x) => x.id === h.id && x.status === 'closed' && x.end === 'run_again'), { what: 'closed by the run again' });
  });

  it('dismissing the locked entry does not forget it: the hand-off stays open', async () => {
    const a = await boot();
    const token = await a.login();
    const job = await a.pull(fail('HOPPER_FAILED the tests do not pass'));
    const h = await handoffOf(a, job.id);
    expect((await a.ui(`/ui/api/jobs/${job.id}/dismiss`, {}, { token })).status).toBe(200);
    await new Promise((res) => setTimeout(res, 300));
    expect((await failuresOf(a)).handoffs.find((x) => x.id === h.id)).toMatchObject({ status: 'open' });
  });
});

describe('a hand-off does not go away by itself', () => {
  it('outlives a restart', async () => {
    const db = tempDbPath();
    cleanup = db.cleanup;
    const source = createManualSource();
    const first = await boot({ dbPath: db.dbPath, source });
    const job = await first.pull(fail('HOPPER_FAILED the tests do not pass'));
    const h = await handoffOf(first, job.id);
    await first.stop();

    const second = await boot({ dbPath: db.dbPath, source });
    expect((await failuresOf(second)).handoffs.find((x) => x.id === h.id)).toMatchObject({ status: 'open', reason: 'person' });
    expect((await eventsOf(second, 'handoff.opened')).filter((e) => e.jobId === job.id)).toHaveLength(1);
  });
});

describe('settings', () => {
  it('notify off: entering still records the event, marked so nothing is told', async () => {
    const a = await boot();
    const token = await a.login();
    expect((await failuresOf(a)).settings).toMatchObject({ handoffNotify: true, handoffRetentionDays: 30 });
    await settings(a, token, { handoffNotify: false, handoffRetentionDays: 7 });
    expect((await failuresOf(a)).settings).toMatchObject({ handoffNotify: false, handoffRetentionDays: 7 });
    const job = await a.pull(fail('HOPPER_FAILED the tests do not pass'));
    await handoffOf(a, job.id);
    const opened = await waitFor(async () => (await eventsOf(a, 'handoff.opened')).find((e) => e.jobId === job.id));
    expect(opened.data).toMatchObject({ notify: false });
    expect((await a.ui('/ui/api/failures/settings', { handoffRetentionDays: 0 }, { token })).status).toBe(400);
  });
});
