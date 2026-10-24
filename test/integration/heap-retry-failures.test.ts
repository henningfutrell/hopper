// The heap retry (issue #2722 part 4, design.md "Heap retry"): a failed job whose command ran out of heap, which the rules
// would hand to a person, runs again once; its run again records the heap retry at its start. A second failure of the
// chain is a person's again. A heap abort the reap reads after the assessment turns the person's failure into the heap retry.
//
// Feature: the heap retry
//   Scenario: a job whose command ran out of heap fails for a person
//     Then it runs again once, and the run again records its heap retry
//     And when that run fails the same way, it stops for a person
//   Scenario: the heap abort is recorded after the failed job's assessment
//     Then its record becomes the heap retry, and its hand-off closes once its item runs again
import { afterEach, describe, expect, it } from 'vitest';
import type { DomainEvent, FailureSettings, FailuresView, Job } from '../../src/domain/types.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

const apps: TestApp[] = [];
let cleanup: (() => void) | undefined;

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  cleanup?.();
});

async function boot() {
  const db = tempDbPath();
  cleanup = db.cleanup;
  const a = await startTestApp({ dbPath: db.dbPath, plugins: { machines: lanes(4) } });
  apps.push(a);
  const token = await a.login();
  await a.ui<FailureSettings>('/ui/api/failures/settings', { backoffSec: 1, backoffFactor: 1 }, { token });
  return a;
}

const TSC = 'tsc --noEmit -p .';
const ERROR = 'HOPPER_FAILED the type check aborted';
const failuresOf = async (a: TestApp): Promise<FailuresView> => (await a.api<FailuresView>('GET', '/api/failures')).body;
const chain = async (a: TestApp, key: string): Promise<Job[]> =>
  (await a.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs.filter((j) => j.source?.key === key).reverse();
const heapRetries = (a: TestApp, jobId: string): DomainEvent[] => a.user().store.events.recent(10, ['job.heap_retry'], jobId);

/** A job of item `key` that fails for a person; each of its runs' heap abort recorded as it is queued, unless `later`. */
async function abortsThenFails(a: TestApp, key: string, later = false): Promise<Job> {
  const store = a.user().store;
  store.events.subscribe((e) => {
    if (later || e.type !== 'job.queued' || !e.jobId || (e.data as { source?: { key?: string } }).source?.key !== key) return;
    store.events.append({ type: 'job.heap_aborted', jobId: e.jobId, data: { command: TSC } });
  });
  const job = await a.pull({ op: 'fail', message: ERROR, ms: 500 }, { key });
  await a.waitForStatus(job.id, 'failed');
  return job;
}

describe('the heap retry (issue #2722 part 4)', () => {
  it('runs a failed job of a heap abort again once, and its second failure is a person\'s', async () => {
    const a = await boot();
    const key = `manual:heap-retry:${Date.now()}`;
    const job = await abortsThenFails(a, key);
    const record = await waitFor(async () => (await failuresOf(a)).recent.find((r) => r.jobId === job.id), { what: 'its assessment' });
    expect(record).toMatchObject({ decision: 'retry', pending: 'retry' });
    expect(record.reasons[0]).toBe(`${TSC} ran out of heap: it runs again once, with a larger heap when its machine has room`);

    const next = await waitFor(async () => { await a.user().failures.sweep(); return (await chain(a, key))[1]; }, { what: 'its item run again' });
    // The test machines read no memory: the run again records its heap retry, skipped, and runs with its own limits.
    await waitFor(async () => heapRetries(a, next.id).length > 0 || undefined, { what: 'its heap retry' });
    expect(heapRetries(a, next.id)[0]?.data).toMatchObject({ command: TSC, rerunOf: job.id });
    await a.waitForStatus(next.id, 'failed');
    const second = await waitFor(async () => (await failuresOf(a)).recent.find((r) => r.jobId === next.id), { what: 'its second assessment' });
    expect(second.decision).toBe('person');
    await a.user().failures.sweep();
    expect(await chain(a, key)).toHaveLength(2);
  });

  it('turns a person\'s failure into the heap retry when the heap abort is recorded after the assessment', async () => {
    const a = await boot();
    const key = `manual:heap-retry-late:${Date.now()}`;
    const job = await abortsThenFails(a, key, true);
    const before = await waitFor(async () => (await failuresOf(a)).recent.find((r) => r.jobId === job.id), { what: 'its assessment' });
    expect(before).toMatchObject({ decision: 'person', outcome: 'surfaced' });
    await waitFor(async () => (await failuresOf(a)).handoffs.find((h) => h.jobId === job.id && h.status === 'open'), { what: 'its hand-off' });

    a.user().store.events.append({ type: 'job.heap_aborted', jobId: job.id, data: { command: TSC } });
    const after = await waitFor(async () => (await failuresOf(a)).recent.find((r) => r.jobId === job.id && r.pending === 'retry'), { what: 'its heap retry' });
    expect(after).toMatchObject({ decision: 'retry', cls: 'transient' });
    expect(after.summary).toMatch(/^Heap retry in 1 s\. /);
    expect((await a.job(job.id)).assessment).toMatchObject({ decision: 'retry' });

    const next = await waitFor(async () => { await a.user().failures.sweep(); return (await chain(a, key))[1]; }, { what: 'its item run again' });
    await waitFor(async () => (await failuresOf(a)).handoffs.find((h) => h.jobId === job.id && h.status !== 'open'), { what: 'its hand-off closed' });
    await waitFor(async () => heapRetries(a, next.id).length > 0 || undefined, { what: 'the run again\'s heap retry' });
  });
});
