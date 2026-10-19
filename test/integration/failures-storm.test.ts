// A retry storm (issue #1961): more than 100 jobs fail within a minute, of two causes — a transient one (a reset
// connection) and a shared one (a full disk on the machine). Real daemon, real database, the manual source.
//
// Feature: a retry storm
//   Scenario: 110 jobs fail at once
//     Given a retry limit of 2 and a backoff of 1 s, doubled each time
//     When 60 jobs fail with a reset connection and 50 with a full disk, all queued in one sync
//     Then each failed job is assessed once
//     And each cause is one problem, which its jobs join: one problem opened per signature
//     And no job runs again before its backoff ends, and no item runs more than the retry limit allows
//     And each failure writes a bounded number of events, and each job's end is reported to its source at most once
//     And a failed job that needs a person has one open hand-off
import { afterEach, describe, expect, it } from 'vitest';
import type { FailureSettings, FailuresView, Job } from '../../src/domain/types.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { manualItem } from '../support/manual-source.ts';
import { waitFor } from '../support/wait.ts';

const apps: TestApp[] = [];
const cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) c();
});

const TRANSIENT = 60;
const SHARED = 50;
const SETTINGS: Partial<FailureSettings> = { maxAttempts: 2, backoffSec: 1, backoffFactor: 2, backoffMaxSec: 4 };
/** The states a job of the storm rests in: ended, or held by a problem. */
const AT_REST = new Set(['failed', 'held', 'finished', 'cancelled']);

const jobsOf = (a: TestApp): Job[] => a.user().store.jobs.list();

/** Every job at rest and every failed job assessed, the same two reads 1 s apart. */
async function quiet(a: TestApp): Promise<Job[]> {
  let last = '';
  return waitFor(async () => {
    const jobs = jobsOf(a);
    const now = JSON.stringify(jobs.map((j) => [j.id, j.status, j.assessment?.recordId]));
    const rest = jobs.every((j) => AT_REST.has(j.status) && (j.status !== 'failed' || j.assessment));
    const same = rest && now === last;
    last = now;
    return same ? jobs : undefined;
  }, { timeoutMs: 120_000, intervalMs: 1000, what: 'the storm to settle' });
}

describe('a retry storm (issue #1961)', () => {
  it('110 jobs failing at once: assessed once, grouped, backed off, bounded', async () => {
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    const a = await startTestApp({ dbPath: db.dbPath, plugins: { machines: lanes(8) } });
    apps.push(a);
    const token = await a.login();
    expect((await a.ui('/ui/api/failures/settings', SETTINGS, { token })).status).toBe(200);

    const fail = (message: string) => JSON.stringify({ op: 'fail', message, ms: 0 });
    for (let n = 0; n < TRANSIENT; n++) a.source.add(manualItem({ prompt: fail('read ECONNRESET') }));
    for (let n = 0; n < SHARED; n++) a.source.add(manualItem({ prompt: fail(`write /w/${n}: ENOSPC: no space left on device`) }));
    await a.sync();

    const jobs = await quiet(a);
    const { store } = a.user();
    const failed = jobs.filter((j) => j.status === 'failed');
    expect(failed.length).toBeGreaterThanOrEqual(2);

    // Assessed once each.
    const records = store.failures.list({ limit: 10_000 });
    const assessed = store.events.recent(10_000, ['job.assessed']);
    for (const j of failed) {
      expect(records.filter((r) => r.jobId === j.id), `records of job ${j.id}`).toHaveLength(1);
      expect(assessed.filter((e) => e.jobId === j.id), `job.assessed of job ${j.id}`).toHaveLength(1);
    }
    expect(records).toHaveLength(failed.length);

    // One problem per signature, opened once; each grouped record is in its problem.
    const problems = store.problems.list({ status: 'open' });
    expect(new Set(problems.map((p) => p.signature)).size).toBe(problems.length);
    expect(problems.some((p) => p.title === 'Disk full on local')).toBe(true);
    expect(store.events.recent(10_000, ['failure.grouped']).filter((e) => e.data.opened === true)).toHaveLength(problems.length);
    for (const r of records.filter((x) => x.problemId)) expect(problems.find((p) => p.id === r.problemId)!.jobIds).toContain(r.jobId);
    const view = (await a.api<FailuresView>('GET', '/api/failures')).body;
    expect(view.problems.filter((p) => p.status === 'open')).toHaveLength(problems.length);

    // Backoff and limits: a run again by the assessor comes at or after its retry time; no item runs past its limit.
    const reruns = store.events.recent(10_000, ['job.rerun']).filter((x) => x.data.by === 'assessor');
    expect(reruns.length).toBeGreaterThan(0);
    for (const e of reruns) {
      const r = records.find((x) => x.jobId === e.jobId)!;
      if (r.retryAt) expect(Date.parse(e.at)).toBeGreaterThanOrEqual(Date.parse(r.retryAt));
    }
    const byItem = new Map<string, Job[]>();
    for (const j of jobs) byItem.set(j.source!.key, [...(byItem.get(j.source!.key) ?? []), j]);
    expect(byItem.size).toBe(TRANSIENT + SHARED);
    for (const chain of byItem.values()) expect(chain.length).toBeLessThanOrEqual(SETTINGS.maxAttempts! + 1);

    // Bounded writes: per failure one assessment, one grouping at most, one hand-off at most; one end report per job.
    expect(store.events.recent(10_000, ['failure.grouped']).length).toBeLessThanOrEqual(failed.length);
    expect(store.events.recent(10_000, ['handoff.opened']).length).toBeLessThanOrEqual(failed.length);
    for (const j of jobs) {
      const mine = a.source.reports.filter((r) => r.job.id === j.id);
      expect(mine.filter((r) => r.kind === 'failed').length, `failed reports of job ${j.id}`).toBeLessThanOrEqual(1);
      expect(mine.filter((r) => r.kind === 'claimed').length, `claimed reports of job ${j.id}`).toBeLessThanOrEqual(1);
    }

    // Exhausted: a failure for a person is in Needs a person, once.
    const open = store.handoffs.list({ status: 'open', limit: 10_000 });
    for (const r of records.filter((x) => x.decision === 'person' && x.outcome === 'surfaced')) {
      expect(open.filter((h) => h.jobId === r.jobId), `hand-off of job ${r.jobId}`).toHaveLength(1);
    }
  }, 180_000);
});
