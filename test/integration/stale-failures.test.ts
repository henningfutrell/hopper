// Issue #1123: a failed job that nothing waits on any more — a newer job of its item took its place, or its item is done or
// dropped — is dismissed by itself, so it leaves the locked entries, the open failures and the failure alerts, and opens no
// hand-off. A person dismisses many at once (`POST /ui/api/jobs/dismiss`, `hopper job dismiss <id>... | --superseded`) for
// what the automatic path missed. Real daemon, the manual source.
import { afterEach, describe, expect, it } from 'vitest';
import type { FailuresView, Job } from '../../src/domain/types.ts';
import { runAgain } from '../support/give-back.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

const apps: TestApp[] = [];
const cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) c();
});

async function boot(): Promise<TestApp> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const a = await startTestApp({ dbPath: db.dbPath });
  apps.push(a);
  return a;
}

async function failedJob(a: TestApp, item: Parameters<TestApp['pull']>[1] = {}): Promise<Job> {
  const job = await a.pull({ op: 'fail', message: 'it broke' }, item);
  await a.waitForStatus(job.id, 'failed');
  await waitFor(async () => (await a.job(job.id)).sourceState?.sync?.finalReported === true, { what: 'the failure reported' });
  return a.job(job.id);
}

const dismissals = async (a: TestApp) => (await a.events('types=job.dismissed')).map((e) => [e.jobId, e.data]);
const openFailures = async (a: TestApp) => (await a.api<FailuresView>('GET', '/api/failures')).body.recent.map((r) => r.jobId);

describe('a failed job nothing waits on is dismissed by itself (issue #1123)', () => {
  it('a newer job of its item dismisses it: out of the open failures, no hand-off', async () => {
    const a = await boot();
    const token = await a.login();
    const old = await failedJob(a);
    const again = await runAgain(a, old.id, token);
    expect(again.status).toBe(200);
    await waitFor(async () => (await a.job(old.id)).dismissedAt !== undefined, { what: 'the superseded failure dismissed' });
    expect(await a.job(old.id)).toMatchObject({ status: 'failed' });
    expect(await dismissals(a)).toEqual([[old.id, { by: 'superseded' }]]);
    expect(await openFailures(a)).not.toContain(old.id);
    expect((await a.api<FailuresView>('GET', '/api/failures')).body.handoffs.filter((h) => h.status === 'open').map((h) => h.jobId)).not.toContain(old.id);
  });

  it('its item closed as complete dismisses it and closes its hand-off; the item counts as done', async () => {
    const a = await boot();
    const failed = await failedJob(a);
    const parts = a.user();
    // A failure waits on a person: its hand-off.
    expect(parts.store.workItems.counts()).toMatchObject({ needs_you: 1, failed: 0 });
    parts.store.events.append({ type: 'work_item.issue_closed', data: { key: failed.source!.key, reason: 'completed', via: 'delivery' } });
    await waitFor(async () => (await a.job(failed.id)).dismissedAt !== undefined, { what: 'the closed item\'s failure dismissed' });
    expect(await dismissals(a)).toEqual([[failed.id, { by: 'item_closed' }]]);
    expect(parts.store.workItems.counts()).toMatchObject({ needs_you: 0, failed: 0, done: 1 });
    expect(parts.store.handoffs.forJob(failed.id)).toMatchObject({ status: 'closed', end: 'item_closed' });
    expect(await openFailures(a)).not.toContain(failed.id);
  });

  it('a live failure stays: the newest job of an open item is not dismissed', async () => {
    const a = await boot();
    const failed = await failedJob(a);
    await a.user().failures.sweep();
    expect((await a.job(failed.id)).dismissedAt).toBeUndefined();
    expect(await dismissals(a)).toEqual([]);
    expect(a.user().store.workItems.counts().needs_you).toBe(1);
    expect(a.user().store.handoffs.forJob(failed.id)).toMatchObject({ status: 'open' });
  });
});

describe('dismiss many failed jobs at once (issue #1123)', () => {
  it('jobIds: each failed job is dismissed as a person dismisses one; the others are refused, each with why', async () => {
    const a = await boot();
    const token = await a.login();
    const one = await failedJob(a);
    const two = await failedJob(a);
    const done = await a.pull({ op: 'echo' });
    await a.waitForStatus(done.id, 'finished');
    const r = await a.ui<{ dismissed: string[]; refused: { id: string; why: string }[] }>('/ui/api/jobs/dismiss', { jobIds: [one.id, two.id, done.id, 'nope'] }, { token });
    expect(r.status).toBe(200);
    expect(r.body.dismissed).toEqual([one.id, two.id]);
    expect(r.body.refused.map((x) => x.id)).toEqual([done.id, 'nope']);
    expect(await dismissals(a)).toEqual([[one.id, { by: 'user' }], [two.id, { by: 'user' }]]);
  });

  it('superseded: every failed job nothing waits on that is still not dismissed, now', async () => {
    const a = await boot();
    const token = await a.login();
    const old = await failedJob(a);
    expect((await runAgain(a, old.id, token)).status).toBe(200);
    await waitFor(async () => (await a.job(old.id)).dismissedAt !== undefined, { what: 'the superseded failure dismissed' });
    // A store from the build before: the superseded failure was never dismissed.
    a.user().store.jobs.update(old.id, { dismissedAt: undefined });
    const r = await a.ui<{ dismissed: string[] }>('/ui/api/jobs/dismiss', { superseded: true }, { token });
    expect(r.status).toBe(200);
    expect(r.body.dismissed).toEqual([old.id]);
    expect((await a.job(old.id)).dismissedAt).toEqual(expect.any(String));
  });

  it('refuses a body with neither jobIds nor superseded, or with both', async () => {
    const a = await boot();
    const token = await a.login();
    expect((await a.ui('/ui/api/jobs/dismiss', {}, { token })).status).toBe(400);
    expect((await a.ui('/ui/api/jobs/dismiss', { jobIds: ['x'], superseded: true }, { token })).status).toBe(400);
  });
});
