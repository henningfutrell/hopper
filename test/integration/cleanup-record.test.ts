// Issue #1570: the cleanup after a job's end, and a person's discard of kept work, are records kept until they end, so a
// stop of the hopper between a job's end and its cleanup, or during a discard, leaves nothing behind. Two daemons over one
// database and ONE fake herdr, which stands for the machine that outlives the daemon.
//
// Feature: the cleanup record
//   Scenario: the hopper stops between a job's end and its cleanup
//     Given a herdr-claude job that finished, its cleanup cut off by a stop of the hopper
//     When the hopper starts again
//     Then the job's pane is closed and its scratch dir and job worktree are reaped
//     And `job.cleaned_up` says the cleanup was done after the stop
//   Scenario: the hopper stops while a person's discard of kept work is under way
//     Then the next start removes the kept work, and `job.work_removed` names who discarded it
import { afterEach, describe, expect, it } from 'vitest';
import { createFakeHerdrClient, type FakeHerdrClient } from '../../src/executors/herdr/index.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { createManualSource } from '../support/manual-source.ts';
import { waitFor } from '../support/wait.ts';

const EXECUTORS = [{ name: 'herdr-claude', plugin: 'herdr-claude', options: { pollMs: 10, idleNudgeMs: 5000, promptSteadyMs: 100 } }];
const DONE = { output: ['● Painted the shed.', '  HOPPER_DONE'] };
const FAIL = { output: ['● The paint ran out halfway.', '  HOPPER_FAILED the paint ran out'] };
const item = { executor: 'herdr-claude', prompt: 'Paint the shed', cwd: '/tmp', env: {} };
const KEPT = '/tmp/.worktrees/@scratch/kept/repo';

const apps: TestApp[] = [];
const releases: (() => void)[] = [];
let cleanup: (() => void) | undefined;
let dbPath = '';
let source = createManualSource();

afterEach(async () => {
  for (const r of releases.splice(0)) r();
  for (const a of apps.splice(0)) await a.stop();
  cleanup?.();
});

function freshDb(): void {
  source = createManualSource();
  const db = tempDbPath();
  cleanup = db.cleanup;
  dbPath = db.dbPath;
}

async function boot(herdr: FakeHerdrClient): Promise<TestApp> {
  const a = await startTestApp({ dbPath, source, plugins: { executors: EXECUTORS, machines: lanes(1) }, seams: { herdr, levels: [] } });
  apps.push(a);
  return a;
}

/**
 * The same herdr, but each call `hangs` names never answers while `held`, as a hopper that stops in the middle of it sees.
 * `reached` lists the calls held.
 */
function holding(herdr: FakeHerdrClient, hangs: (method: string, args: unknown[]) => boolean): { herdr: FakeHerdrClient; held: { on: boolean }; reached: string[] } {
  const held = { on: true };
  const reached: string[] = [];
  const proxied = new Proxy(herdr, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver) as unknown;
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (held.on && hangs(String(key), args)) {
          reached.push(String(key));
          // Never answered to the stopped hopper: it rejects once the test ends.
          return new Promise((_, reject) => releases.push(() => reject(new Error('the hopper stopped'))));
        }
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { herdr: proxied, held, reached };
}

const eventsOf = async (a: TestApp, type: string, jobId: string) => (await a.events(`types=${type}`)).filter((e) => e.jobId === jobId);

describe('the cleanup record (issue #1570)', () => {
  it('a stop between a job\'s end and its cleanup: the next start closes its pane, reaps its work tree, and says so', { timeout: 30_000 }, async () => {
    freshDb();
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [DONE] });
    // The cleanup's first effect on the machine: the reap, then the close.
    const first = holding(herdr, (method, args) => method === 'reap' && args[3] !== true);
    const a = await boot(first.herdr);
    const pulled = await a.pull({}, item);
    const finished = await a.waitForStatus(pulled.id, 'finished', 8000);
    const { paneId } = finished.executorState as { paneId: string };
    await waitFor(() => first.reached.includes('reap'), { what: 'the cleanup at its machine' });
    // Recorded with the end, in its transaction, before the cleanup ran.
    expect((await a.job(pulled.id)).cleanupDue).toBeDefined();
    await a.stop();
    apps.splice(apps.indexOf(a), 1);
    expect(herdr.closed).toEqual([]);
    expect(herdr.reaps.filter((r) => r.jobId === pulled.id)).toEqual([]);

    const b = await boot(herdr);
    await waitFor(() => herdr.closed.includes(paneId), { what: 'its pane closed after the start' });
    await waitFor(() => herdr.reaps.some((r) => r.jobId === pulled.id && r.scratch !== undefined), { what: 'its work tree reaped' });
    const cleaned = await waitFor(async () => (await eventsOf(b, 'job.cleaned_up', pulled.id))[0], { what: 'job.cleaned_up' });
    expect(cleaned.data).toEqual({ dueAt: finished.cleanupDue?.at ?? expect.any(String) });
    const after = await b.job(pulled.id);
    expect(after.cleanupDue).toBeUndefined();
    expect(after.cleanupDeferred).toBeUndefined();
    // Done once: never again at the next tick.
    await new Promise((r) => setTimeout(r, 300));
    expect(herdr.closed.filter((p) => p === paneId)).toHaveLength(1);
    expect(await eventsOf(b, 'job.cleaned_up', pulled.id)).toHaveLength(1);
  });

  it('a job whose cleanup went through before the stop is not cleaned up again, and says nothing', { timeout: 30_000 }, async () => {
    freshDb();
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [DONE] });
    const a = await boot(herdr);
    const pulled = await a.pull({}, item);
    await a.waitForStatus(pulled.id, 'finished', 8000);
    await waitFor(async () => (await a.job(pulled.id)).cleanupDue === undefined, { what: 'the cleanup done' });
    await a.stop();
    apps.splice(apps.indexOf(a), 1);
    const closed = herdr.closed.length;

    const b = await boot(herdr);
    await new Promise((r) => setTimeout(r, 500));
    expect(herdr.closed).toHaveLength(closed);
    expect(await eventsOf(b, 'job.cleaned_up', pulled.id)).toEqual([]);
  });

  it('a stop while a person\'s discard of kept work is under way: the next start removes it', { timeout: 30_000 }, async () => {
    freshDb();
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [FAIL], reapKeeps: [KEPT] });
    const first = holding(herdr, (method, args) => method === 'reap' && args[3] === true);
    const a = await boot(first.herdr);
    const token = await a.login();
    const pulled = await a.pull({}, item);
    await a.waitForStatus(pulled.id, 'failed', 8000);
    await waitFor(async () => (await eventsOf(a, 'job.work_kept', pulled.id))[0], { what: 'its work kept' });
    const r = await a.ui<{ jobId: string; paths: string[] }>(`/ui/api/failures/kept-work/${pulled.id}/discard`, {}, { token });
    expect(r.status).toBe(200);
    await waitFor(() => first.reached.includes('reap'), { what: 'the discard at its machine' });
    expect((await a.job(pulled.id)).discard).toMatchObject({ scratch: r.body.paths[0], by: { via: 'ui' } });
    await a.stop();
    apps.splice(apps.indexOf(a), 1);
    expect(herdr.reaps.filter((x) => x.discard)).toEqual([]);

    const b = await boot(herdr);
    const removed = await waitFor(async () => (await eventsOf(b, 'job.work_removed', pulled.id))[0], { what: 'the kept work removed after the start' });
    expect(removed.data).toMatchObject({ paths: r.body.paths, discarded: true, via: 'ui' });
    expect(herdr.reaps.filter((x) => x.jobId === pulled.id && x.discard)).toEqual([{ jobId: pulled.id, scratch: r.body.paths[0], discard: true }]);
    expect((await b.job(pulled.id)).discard).toBeUndefined();
    expect(await eventsOf(b, 'job.work_discard_failed', pulled.id)).toEqual([]);
  });
});
