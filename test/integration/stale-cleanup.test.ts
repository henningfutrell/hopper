// Stale data clears itself (issue #529): a hand-off whose item has a newer job, or whose item is closed at its source,
// leaves Needs a person and its failure leaves Recent failures — closed with why, never deleted —, by the sweep and at
// start, so a row recorded before the rule existed clears too. The profile still counts the original failure. A
// failure nothing has superseded stays. Real daemon, real database, the manual source.
import { afterEach, describe, expect, it } from 'vitest';
import type { FailuresView, Job } from '../../src/domain/types.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { createManualSource, manualItem, type ManualSource } from '../support/manual-source.ts';
import { waitFor } from '../support/wait.ts';

const apps: TestApp[] = [];
let cleanup: (() => void) | undefined;

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  cleanup?.();
});

async function boot(dbPath: string, source: ManualSource): Promise<TestApp> {
  const a = await startTestApp({ dbPath, source, plugins: { machines: lanes(4) } });
  apps.push(a);
  return a;
}

function fresh(): { dbPath: string; source: ManualSource } {
  const db = tempDbPath();
  cleanup = db.cleanup;
  return { dbPath: db.dbPath, source: createManualSource() };
}

const failuresOf = async (a: TestApp): Promise<FailuresView> => (await a.api<FailuresView>('GET', '/api/failures')).body;
const FAIL = { op: 'fail', message: 'HOPPER_FAILED the tests do not pass', ms: 0 };
const openHandoff = async (a: TestApp, jobId: string) =>
  waitFor(async () => (await failuresOf(a)).handoffs.find((h) => h.jobId === jobId && h.status === 'open'), { what: `job ${jobId} handed off` });
/** Its end reported, so its source offers the item again only when told. */
const reported = async (a: TestApp, jobId: string) =>
  waitFor(async () => ((await a.job(jobId)).sourceState?.sync?.finalReported === true ? true : undefined), { what: `job ${jobId} reported` });
/** The item offered again: a newer job of it. */
async function newerJob(a: TestApp, source: ManualSource, key: string): Promise<Job> {
  source.add(manualItem({ key, prompt: JSON.stringify({ op: 'echo', message: 'again' }) }));
  await a.sync();
  const jobs = (await a.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs.filter((j) => j.source?.key === key);
  return jobs[0]!;
}

describe('a newer job of its item supersedes a failure waiting on a person', () => {
  it('the sweep closes a hand-off left open with a newer job (as the build before left one): superseded, its record out of Recent failures, still in the profile', async () => {
    const { dbPath, source } = fresh();
    const a = await boot(dbPath, source);
    const job = await a.pull(FAIL);
    const h = await openHandoff(a, job.id);
    await reported(a, job.id);
    const newer = await newerJob(a, source, job.source!.key);
    expect(newer.id).not.toBe(job.id);
    await waitFor(async () => (await failuresOf(a)).handoffs.find((x) => x.id === h.id && x.status === 'closed'), { what: 'closed by the run again' });
    // A row the build before left: open, though its item has a newer job.
    const { store, failures } = a.user();
    const { id: _id, actions: _actions, ...was } = h;
    const stale = store.handoffs.create({ ...was, status: 'open', openedAt: new Date().toISOString() });
    const record = store.failures.forJob(job.id)!;
    store.failures.update(record.id, { outcome: 'surfaced', nextJobId: undefined, note: undefined });
    expect((await failuresOf(a)).counts.needsPerson).toBe(1);

    // A sweep already under way may have read before the row was written: the next one sees it.
    await failures.sweep();
    await failures.sweep();
    const view = await failuresOf(a);
    expect(view.handoffs.find((x) => x.id === stale.id)).toMatchObject({ status: 'closed', end: 'superseded', nextJobId: newer.id });
    expect(view.counts.needsPerson).toBe(0);
    expect(view.recent.some((r) => r.jobId === job.id)).toBe(false);
    expect(store.failures.forJob(job.id)).toMatchObject({ outcome: 'superseded', nextJobId: newer.id });
    expect(view.profile.signatures.reduce((n, s) => n + s.count, 0)).toBe(1);
    const closed = (await a.events('types=handoff.closed&limit=1000')).find((e) => e.data.handoffId === stale.id);
    expect(closed?.data).toMatchObject({ end: 'superseded', nextJobId: newer.id });
  });

  it('backfill at start: a hand-off a newer job never closed (nothing followed its events) is closed when the hopper starts', async () => {
    const { dbPath, source } = fresh();
    const first = await boot(dbPath, source);
    const job = await first.pull(FAIL);
    const h = await openHandoff(first, job.id);
    await reported(first, job.id);
    // The build before: nothing closes a hand-off on a newer job.
    await first.user().failures.stop();
    const newer = await newerJob(first, source, job.source!.key);
    await first.waitForStatus(newer.id, 'finished');
    expect(first.user().store.handoffs.get(h.id)).toMatchObject({ status: 'open' });
    await first.stop();

    const second = await boot(dbPath, source);
    const view = await waitFor(async () => {
      const v = await failuresOf(second);
      return v.handoffs.find((x) => x.id === h.id)?.status === 'closed' ? v : undefined;
    }, { what: 'the hand-off closed at start' });
    expect(view.handoffs.find((x) => x.id === h.id)).toMatchObject({ end: 'superseded', nextJobId: newer.id });
    expect(view.counts.needsPerson).toBe(0);
    expect(view.recent.some((r) => r.jobId === job.id)).toBe(false);
    expect(view.profile.signatures.reduce((n, s) => n + s.count, 0)).toBe(1);
  });
});

describe('a closed item resolves its failure', () => {
  it('its item closed at the source: the hand-off closes (item_closed), the record says so, Recent failures drops it, the profile keeps it', async () => {
    const { dbPath, source } = fresh();
    const first = await boot(dbPath, source);
    const job = await first.pull(FAIL);
    const h = await openHandoff(first, job.id);
    source.close(job.source!.key);
    await first.stop();

    const second = await boot(dbPath, source);
    const view = await waitFor(async () => {
      const v = await failuresOf(second);
      return v.handoffs.find((x) => x.id === h.id)?.status === 'closed' ? v : undefined;
    }, { what: 'the hand-off closed by its closed item' });
    expect(view.handoffs.find((x) => x.id === h.id)).toMatchObject({ end: 'item_closed', actions: { continue: { ok: false }, fixed: { ok: false }, doneByHand: { ok: false }, wontDo: { ok: false } } });
    expect(view.counts.needsPerson).toBe(0);
    expect(view.recent.some((r) => r.jobId === job.id)).toBe(false);
    expect(second.user().store.failures.forJob(job.id)).toMatchObject({ outcome: 'item_closed' });
    expect(view.ended.find((r) => r.jobId === job.id)).toMatchObject({ outcome: 'item_closed' });
    expect(view.profile.signatures.reduce((n, s) => n + s.count, 0)).toBe(1);
  });
});

describe('a failure whose job ends finished leaves the open failures (issue #618)', () => {
  it('its job found done later: the hand-off closes (finished), its failure moves from Recent failures to Ended, the badge drops it', async () => {
    const { dbPath, source } = fresh();
    const a = await boot(dbPath, source);
    const job = await a.pull(FAIL);
    const h = await openHandoff(a, job.id);
    // Its work landed after all (its issue closed as complete): the job ends finished.
    const { store } = a.user();
    store.jobs.update(job.id, { status: 'finished', error: undefined, result: 'done', finishedAt: new Date().toISOString() });
    store.events.append({ type: 'job.finished', jobId: job.id, data: { result: 'done' } });
    const view = await waitFor(async () => {
      const v = await failuresOf(a);
      return v.handoffs.find((x) => x.id === h.id)?.status === 'closed' ? v : undefined;
    }, { what: 'the hand-off closed by its finished job' });
    expect(view.handoffs.find((x) => x.id === h.id)).toMatchObject({ end: 'finished' });
    expect(view.counts.needsPerson).toBe(0);
    expect(view.recent.some((r) => r.jobId === job.id)).toBe(false);
    expect(view.ended.find((r) => r.jobId === job.id)).toMatchObject({ outcome: 'surfaced' });
  });
});

describe('a failure nothing superseded stays', () => {
  it('no newer job, its item open: still open after the sweep and a restart, still in Recent failures, still counted', async () => {
    const { dbPath, source } = fresh();
    const first = await boot(dbPath, source);
    const job = await first.pull(FAIL);
    const h = await openHandoff(first, job.id);
    await first.user().failures.sweep();
    await first.stop();

    const second = await boot(dbPath, source);
    await second.user().failures.sweep();
    await second.user().failures.sweep();
    const view = await failuresOf(second);
    expect(view.handoffs.find((x) => x.id === h.id)).toMatchObject({ status: 'open', actions: { continue: { ok: true }, fixed: { ok: true }, doneByHand: { ok: true }, wontDo: { ok: true } } });
    expect(view.counts.needsPerson).toBe(1);
    expect(view.recent.find((r) => r.jobId === job.id)).toMatchObject({ outcome: 'surfaced' });
    expect(view.ended.some((r) => r.jobId === job.id)).toBe(false);
  });
});
