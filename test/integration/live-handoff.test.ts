// A failed job that is live again (issue #1777): a Continue, Push it or a resume took it back to the queue. Its failure
// record waits on nothing any more, so its problem's release runs nothing and opens no hand-off, in either order and
// after a restart; an open hand-off of it closes by itself (`resumed`), at the event and at the sweep; and its card offers
// no resolution while it is live. Real daemon, real database, the manual source.
import { afterEach, describe, expect, it } from 'vitest';
import { TERMINAL_STATUSES, type FailuresView, type Job } from '../../src/domain/types.ts';
import { LIVE_AGAIN_NOTE } from '../../src/failures/continued.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { createManualSource, type ManualSource } from '../support/manual-source.ts';
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

const FAIL = { op: 'fail', message: 'HOPPER_FAILED the tests do not pass', ms: 0 };
const BY = { person: 'admin', via: 'ui' as const };
const failuresOf = async (a: TestApp): Promise<FailuresView> => (await a.api<FailuresView>('GET', '/api/failures')).body;
const openHandoff = async (a: TestApp, jobId: string) =>
  waitFor(async () => (await failuresOf(a)).handoffs.find((h) => h.jobId === jobId && h.status === 'open'), { what: `job ${jobId} handed off` });
const reported = async (a: TestApp, jobId: string) =>
  waitFor(async () => ((await a.job(jobId)).sourceState?.sync?.finalReported === true ? true : undefined), { what: `job ${jobId} reported` });

/** A failed job held on an open problem, as the assessor holds one: its hand-off gone, its record `held`. The problem's id. */
async function heldJob(a: TestApp): Promise<{ job: Job; problemId: string }> {
  const job = await a.pull(FAIL);
  const h = await openHandoff(a, job.id);
  await reported(a, job.id);
  const { store } = a.user();
  const problemId = store.tx(() => {
    const at = new Date().toISOString();
    const r = store.failures.forJob(job.id)!;
    store.handoffs.update(h.id, { status: 'closed', closedAt: at, end: 'cleared' });
    const p = store.problems.create({ signature: r.signature, title: 'Recurring: pane lost', decision: 'hold', scope: {}, status: 'open', openedAt: at, updatedAt: at, general: true, jobIds: [job.id] });
    store.failures.update(r.id, { outcome: 'held', outcomeAt: at, problemId: p.id, handoffId: undefined, auto: true });
    return p.id;
  });
  holdStarts(a);
  return { job, problemId };
}

/**
 * An open problem that holds every start (a machine down): a job queued again stays queued, so nothing ends it again. A
 * resume goes past every hold, so the tests' live jobs carry no pending answer.
 */
function holdStarts(a: TestApp): void {
  const at = new Date().toISOString();
  a.user().store.problems.create({ signature: 'machine down', title: 'Machine down', decision: 'hold', scope: {}, status: 'open', openedAt: at, updatedAt: at, general: false, jobIds: [] });
}

/** Push it: the host's Continue with kept work. */
function pushIt(a: TestApp, jobId: string): void {
  const r = a.user().engine.sourceHost.continueJob(jobId, 'Push the kept work.', { keptWork: true });
  expect(r.ok).toBe(true);
  a.user().store.jobs.update(jobId, { pendingAnswer: undefined });
}

async function resolveAndSweep(a: TestApp, problemId: string): Promise<void> {
  const { failures } = a.user();
  expect(failures.resolve(problemId, BY).ok).toBe(true);
  await failures.sweep();
  await failures.sweep();
}

async function noHandoffOpens(a: TestApp, jobId: string): Promise<void> {
  await new Promise((res) => setTimeout(res, 300));
  expect(a.user().store.handoffs.forJob(jobId)?.status).not.toBe('open');
  expect(TERMINAL_STATUSES).not.toContain((await a.job(jobId)).status);
  const r = a.user().store.failures.forJob(jobId)!;
  expect(r).toMatchObject({ outcome: 'retried', nextJobId: jobId });
  expect(r.pending).toBeUndefined();
}

describe('a held job that goes on before its problem is released', () => {
  it('Push it ends its record\'s hold at once; the release then runs nothing and opens no hand-off', async () => {
    const { dbPath, source } = fresh();
    const a = await boot(dbPath, source);
    const { job, problemId } = await heldJob(a);
    pushIt(a, job.id);
    expect(a.user().store.failures.forJob(job.id)).toMatchObject({ outcome: 'retried', nextJobId: job.id, note: LIVE_AGAIN_NOTE });
    await resolveAndSweep(a, problemId);
    await noHandoffOpens(a, job.id);
  });

  it('the same after a restart between Push it and the release', async () => {
    const { dbPath, source } = fresh();
    const first = await boot(dbPath, source);
    const { job, problemId } = await heldJob(first);
    pushIt(first, job.id);
    await first.stop();
    apps.splice(apps.indexOf(first), 1);
    const second = await boot(dbPath, source);
    await resolveAndSweep(second, problemId);
    await noHandoffOpens(second, job.id);
  });

  it('live again by a way that leaves its record held: the release reads the job first and settles it taken', async () => {
    const { dbPath, source } = fresh();
    const a = await boot(dbPath, source);
    const { job, problemId } = await heldJob(a);
    // A resume that did not touch its record.
    a.user().store.jobs.update(job.id, { status: 'queued', finishedAt: undefined, error: undefined });
    expect(a.user().store.failures.forJob(job.id)?.outcome).toBe('held');
    await resolveAndSweep(a, problemId);
    await noHandoffOpens(a, job.id);
    expect(a.user().store.failures.forJob(job.id)?.note).toBe(LIVE_AGAIN_NOTE);
  });
});

describe('an open hand-off whose job is live again', () => {
  it('its card offers no resolution, and the sweep closes it `resumed`, its record taken', async () => {
    const { dbPath, source } = fresh();
    const a = await boot(dbPath, source);
    const job = await a.pull(FAIL);
    const h = await openHandoff(a, job.id);
    holdStarts(a);
    const { store, failures } = a.user();
    store.jobs.update(job.id, { status: 'queued', finishedAt: undefined, error: undefined });
    // Read before any sweep: in the same turn as the change.
    const shown = failures.view().handoffs.find((x) => x.id === h.id)!;
    const why = 'it is already queued again: it runs when a lane is free, and this hand-off closes by itself';
    expect(shown.actions).toEqual({ continue: { ok: false, why }, fixed: { ok: false, why }, doneByHand: { ok: false, why }, wontDo: { ok: false, why } });
    expect(shown.card.why).toBe('Nothing to do: its job is already queued again: it runs when a lane is free.');
    expect(failures.handoffResolvable(h.id, 'wont_do')).toMatchObject({ ok: false, message: expect.stringContaining('already queued again') });
    await failures.sweep();
    expect(store.handoffs.get(h.id)).toMatchObject({ status: 'closed', end: 'resumed' });
    expect(store.failures.forJob(job.id)).toMatchObject({ outcome: 'retried', nextJobId: job.id, note: LIVE_AGAIN_NOTE });
    const closed = await waitFor(async () => (await a.events('types=handoff.closed&limit=100')).find((e) => e.data.handoffId === h.id));
    expect(closed.data).toMatchObject({ end: 'resumed' });
  });

  it('closes `resumed` on its job\'s `job.continued`', async () => {
    const { dbPath, source } = fresh();
    const a = await boot(dbPath, source);
    const job = await a.pull(FAIL);
    const h = await openHandoff(a, job.id);
    holdStarts(a);
    const { store } = a.user();
    store.tx(() => {
      store.jobs.update(job.id, { status: 'queued', finishedAt: undefined, error: undefined });
      store.events.append({ type: 'job.continued', jobId: job.id, data: { keptWork: true } });
    });
    await waitFor(() => (store.handoffs.get(h.id)?.status === 'closed' ? true : undefined), { what: 'its hand-off closed' });
    expect(store.handoffs.get(h.id)).toMatchObject({ end: 'resumed' });
    expect(TERMINAL_STATUSES).not.toContain((await a.job(job.id)).status);
  });

  it('a person\'s Continue on it still closes it `continued`, not `resumed`', async () => {
    const { dbPath, source } = fresh();
    const a = await boot(dbPath, source);
    const job = await a.pull(FAIL);
    const h = await openHandoff(a, job.id);
    await reported(a, job.id);
    const r = await a.user().failures.resolveHandoff(h.id, { action: 'continue' }, BY);
    expect(r.ok).toBe(true);
    expect(a.user().store.handoffs.get(h.id)).toMatchObject({ status: 'closed', end: expect.stringMatching(/^(continued|run_again)$/) });
  });
});
