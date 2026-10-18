// The failure assessor and Needs a person under the crash harness (issue #1961, design.md "The crash harness"): hoppers
// as processes of their own on one database, the first killed with SIGKILL inside or just after the transaction of an
// assessment. The failed jobs are written into the database by the test, failed two minutes ago, as a restart leaves
// them: the failure sweep of the host that holds its lease assesses them.
//
// Feature: a kill during assessment, across two hosts
//   Scenario: killed in the assessment's transaction, or just after it
//     Given hosts A (armed at the kill point) and B on one database, A holding the failure sweep's lease
//     When failed jobs are left to assess and A is killed at its third assessment
//     Then B takes the sweep and each failure is assessed once: one record, one decision, one job.assessed
//     And each job-specific failure has one open hand-off; the transient one waits for its retry
//   Scenario: Needs a person stays across restarts and hosts
//     When B is killed and a host C starts on the database
//     Then every hand-off is still open, and none is assessed again
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { UserStore } from '../../src/domain/ports.ts';
import { ADMIN_ID, type Job } from '../../src/domain/types.ts';
import { openDb } from '../../src/store/db.ts';
import { openInstanceStore } from '../../src/store/index.ts';
import { tempDbPath } from '../support/app.ts';
import { databaseUrlFor } from '../support/database.ts';
import { waitFor } from '../support/wait.ts';
import { endLeases, startHost, stopHosts, type CrashHost } from './harness.ts';

const SCENARIO_MS = 180_000;
/** No provider is used here; the host only needs a URL for each. */
const NO_PROVIDER = { cloudflare: 'http://127.0.0.1:9', ngrok: 'http://127.0.0.1:9' };
/** Job-specific failures, each its own cause, so no Recurring problem groups them; and one transient failure. */
const PERSON = ['the tests do not pass', 'lint found problems', 'the docs are out of date', 'a type error', 'the build broke', 'a migration is missing']
  .map((t) => `HOPPER_FAILED ${t}`);
const TRANSIENT = 'read ECONNRESET';

const cleanups: (() => void)[] = [];
afterEach(async () => {
  await stopHosts();
  for (const c of cleanups.splice(0).reverse()) c();
});

interface World { url: string; store: UserStore; host(killPoint?: string): Promise<CrashHost> }

/** A fresh database, its first host started (it makes the admin), and the admin's store in this process. */
async function world(killPoint?: string): Promise<World & { a: CrashHost }> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const url = databaseUrlFor(db.dbPath);
  const host = (k?: string) => startHost({ dbPath: db.dbPath, databaseUrl: url, fakes: NO_PROVIDER, ...(k ? { killPoint: k } : {}) });
  const a = await host(killPoint);
  const instance = openInstanceStore({ url, clock: { now: () => new Date() }, idGen: randomUUID });
  const store = instance.userStore(instance.users.get(ADMIN_ID)!);
  cleanups.push(() => { store.close(); instance.close(); });
  return { url, store, host, a };
}

/** The failed jobs, not assessed yet. */
function leaveFailed(store: UserStore, errors: readonly string[]): Job[] {
  const at = new Date(Date.now() - 120_000).toISOString();
  return errors.map((error) => {
    const job = store.jobs.create({ executor: 'test', payload: {} }, 50);
    return store.jobs.update(job.id, { status: 'failed', error, startedAt: at, finishedAt: at });
  });
}

/** Ends the failure sweep's lease too, as its time would: a killed host's sweeps are due again on another. */
function endSweepLeases(url: string): void {
  endLeases(url);
  const db = openDb(url);
  try { db.run("UPDATE sweep_leases SET until = '1970-01-01T00:00:00.000Z'"); } finally { db.close(); }
}

/** Each job assessed exactly once: one record, one `job.assessed`, the assessment on the job naming that record. */
function assessedOnce(store: UserStore, jobs: readonly Job[]): void {
  const records = store.failures.list({ limit: 10_000 });
  const assessed = store.events.recent(10_000, ['job.assessed']);
  for (const j of jobs) {
    const mine = records.filter((r) => r.jobId === j.id);
    expect(mine, `records of job ${j.id}`).toHaveLength(1);
    expect(assessed.filter((e) => e.jobId === j.id), `job.assessed of job ${j.id}`).toHaveLength(1);
    expect(store.jobs.get(j.id)!.assessment?.recordId).toBe(mine[0]!.id);
  }
}

/** The job-specific failures each have one open hand-off; the transient one has none and waits for its retry. */
function handedOff(store: UserStore, person: readonly Job[], transient: Job): void {
  const open = store.handoffs.list({ status: 'open', limit: 10_000 });
  for (const j of person) expect(open.filter((h) => h.jobId === j.id), `hand-off of job ${j.id}`).toHaveLength(1);
  expect(open.some((h) => h.jobId === transient.id)).toBe(false);
  expect(store.failures.forJob(transient.id)).toMatchObject({ decision: 'retry', pending: 'retry' });
}

const settled = (store: UserStore, jobs: readonly Job[]) => () => jobs.every((j) => store.jobs.get(j.id)!.assessment !== undefined);

describe('a kill during assessment (issue #1961)', () => {
  for (const point of ['failures:assess:before-commit', 'failures:assess:after-commit']) {
    it(`killed at ${point}: the other host assesses each failure once, and Needs a person stays across hosts`, async () => {
      const w = await world(`${point}#3`);
      const b = await w.host();
      const person = leaveFailed(w.store, PERSON);
      const [transient] = leaveFailed(w.store, [TRANSIENT]);
      const jobs = [...person, transient!];

      const e = await w.a.exited;
      expect(e.signal, w.a.stderr()).toBe('SIGKILL');
      expect(w.a.stderr()).toContain(`hopper: kill point ${point}`);
      expect(b.stderr()).not.toContain('kill point');
      endSweepLeases(w.url);
      // Its log on a timeout: a loaded runner is where this test is slow.
      await waitFor(settled(w.store, jobs), { timeoutMs: 90_000, what: 'host B to assess every failure' })
        .catch((e: Error) => { throw new Error(`${e.message}; host B said:\n${b.stderr().slice(-4000)}`); });
      assessedOnce(w.store, jobs);
      handedOff(w.store, person, transient!);

      // B is killed too; C starts on the same database: Needs a person is as it was.
      await b.kill();
      endSweepLeases(w.url);
      const c = await w.host();
      await new Promise((r) => setTimeout(r, 2000));
      expect(c.stderr()).not.toContain('the failure sweep failed');
      assessedOnce(w.store, jobs);
      handedOff(w.store, person, transient!);
    }, SCENARIO_MS);
  }
});
