// A poison failure (issue #1961): a failed job whose own data makes the assessor throw — here a spec with no payload,
// as an older build or a broken plugin can leave — is handed to a person with a plain reason, and never blocks the
// assessment of the other failures. Real daemon, real database.
//
// Feature: a poison failure
//   Scenario: the assessor throws on one failure
//     Given failed jobs not assessed yet, one of them with a spec the assessor cannot read
//     When the failure sweep assesses them
//     Then each other failure is assessed as usual
//     And the poison failure is assessed once, as "a person", and handed off with the reason the assessor gave
//     And a later sweep assesses it no more
import { afterEach, describe, expect, it } from 'vitest';
import type { FailuresView, Job, JobSpec } from '../../src/domain/types.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
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
  const a = await startTestApp({ dbPath: db.dbPath, plugins: { machines: lanes(1) } });
  apps.push(a);
  return a;
}

/** A failed job not assessed yet, as a restart leaves it: failed two minutes ago, so the sweep takes it. */
function failed(a: TestApp, spec: JobSpec, error: string): Job {
  const { store } = a.user();
  const job = store.jobs.create(spec, 50);
  const at = new Date(Date.now() - 120_000).toISOString();
  return store.jobs.update(job.id, { status: 'failed', error, startedAt: at, finishedAt: at });
}

const failuresOf = async (a: TestApp): Promise<FailuresView> => (await a.api<FailuresView>('GET', '/api/failures')).body;

describe('a poison failure (issue #1961)', () => {
  it('is handed to a person with a plain reason, and the other failures are assessed', async () => {
    const a = await boot();
    const { store } = a.user();
    // The sweep reads the newest first: good failures on both sides of the poison one.
    // Four other causes, so no Recurring problem groups them.
    const good = (error: string) => failed(a, { executor: 'test', payload: {} }, error);
    const before = ['HOPPER_FAILED the tests do not pass', 'HOPPER_FAILED lint found problems'].map(good);
    const poison = failed(a, { executor: 'test' } as unknown as JobSpec, 'HOPPER_FAILED the build broke');
    const after = ['HOPPER_FAILED the docs are out of date', 'HOPPER_FAILED a type error'].map(good);

    for (const j of [...before, ...after]) {
      const assessed = await waitFor(() => store.jobs.get(j.id)!.assessment, { what: `job ${j.id} assessed` });
      expect(assessed).toMatchObject({ decision: 'person', class: 'job' });
    }
    const assessed = await waitFor(() => store.jobs.get(poison.id)!.assessment, { what: 'the poison failure assessed' });
    expect(assessed).toMatchObject({ decision: 'person', class: 'job' });
    expect(assessed.summary).toMatch(/^Needs a person\. The hopper could not assess this failure: .+\. Failed: HOPPER_FAILED the build broke\.$/);

    const h = await waitFor(async () => (await failuresOf(a)).handoffs.find((x) => x.jobId === poison.id && x.status === 'open'), { what: 'the poison failure handed off' });
    expect(h).toMatchObject({ reason: 'person', decision: 'person' });
    expect(h.reasons.join(' ')).toMatch(/the hopper could not assess this failure/);

    // Assessed once: later sweeps leave it.
    await new Promise((r) => setTimeout(r, 500));
    const records = store.failures.list({ limit: 1000 }).filter((r) => r.jobId === poison.id);
    expect(records).toHaveLength(1);
    expect((await a.events('types=job.assessed&limit=1000')).filter((e) => e.jobId === poison.id)).toHaveLength(1);
  });
});
