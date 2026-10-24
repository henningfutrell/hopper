// A heap abort pattern (issue #2722, design.md "Heap abort patterns"): a command that ran out of heap in several jobs
// within a day. A failed job of it is not run again, nor handed to a person: it is held on a problem of the command, which
// holds only its own jobs. A heap abort the reap reads after the job's assessment holds its pending retry too. A person
// resolves the problem once the command is fixed or has more heap, and the held jobs run again.
//
// Feature: a heap abort pattern
//   Scenario: a job of a command that ran out of heap in two jobs before fails
//     Then it is held on a problem of the command, not run again and not handed to a person, and other jobs still start
//   Scenario: the heap abort is recorded after the failed job's assessment
//     Then its pending retry is held on the problem in its place
//   Scenario: a person resolves the problem
//     Then the held job's item runs again
import { afterEach, describe, expect, it } from 'vitest';
import type { FailuresView, Job } from '../../src/domain/types.ts';
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
  return a;
}

const TSC = 'tsc --noEmit -p .';
const BY = { person: 'admin', via: 'ui' as const };
const failuresOf = async (a: TestApp): Promise<FailuresView> => (await a.api<FailuresView>('GET', '/api/failures')).body;
const chain = async (a: TestApp, key: string): Promise<Job[]> =>
  (await a.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs.filter((j) => j.source?.key === key).reverse();

/** Two earlier jobs that ran out of heap with the same command, as their reaps recorded it. */
async function earlierAborts(a: TestApp): Promise<void> {
  for (const n of [1, 2]) {
    const job = await a.pull({ op: 'echo', message: `earlier ${n}` });
    await a.waitForStatus(job.id, 'finished');
    a.user().store.events.append({ type: 'job.heap_aborted', jobId: job.id, data: { command: TSC, heapLimitBytes: 2_248_146_944, rssPeakBytes: 2_400_000_000 } });
  }
}

/** A job that fails with a transient error (a retry, by the rules); its heap abort recorded as it is queued, or `later`. */
async function abortsThenFails(a: TestApp, later = false) {
  const key = `manual:heap:${Date.now()}`;
  const store = a.user().store;
  const abort = (jobId: string) => store.events.append({ type: 'job.heap_aborted', jobId, data: { command: TSC } });
  const unsubscribe = store.events.subscribe((e) => {
    if (later || e.type !== 'job.queued' || !e.jobId || (e.data as { source?: { key?: string } }).source?.key !== key) return;
    abort(e.jobId);
  });
  const job = await a.pull({ op: 'fail', message: 'read ECONNRESET', ms: 1500 }, { key }).finally(unsubscribe);
  await a.waitForStatus(job.id, 'failed');
  if (later) {
    const record = await waitFor(async () => (await failuresOf(a)).recent.find((r) => r.jobId === job.id), { what: 'its assessment' });
    expect(record).toMatchObject({ decision: 'retry', pending: 'retry' });
    abort(job.id);
  }
  const problem = await waitFor(async () => (await failuresOf(a)).problems.find((p) => p.jobIds.includes(job.id)), { what: 'its problem' });
  return { job, problem };
}

describe('a heap abort pattern (issue #2722)', () => {
  it('holds a failed job of the command on its problem, not run again and not a person\'s; other jobs still start', async () => {
    const a = await boot();
    await earlierAborts(a);
    const { job, problem } = await abortsThenFails(a);
    expect(problem).toMatchObject({ title: `Heap abort: ${TSC}`, causeId: 'heap-abort', status: 'open', decision: 'hold', general: false, scope: {} });
    const view = await failuresOf(a);
    expect(view.recent.find((r) => r.jobId === job.id)).toMatchObject({ decision: 'hold', outcome: 'held', problemId: problem.id });
    expect(view.handoffs.filter((h) => h.jobId === job.id)).toEqual([]);
    const assessed = await waitFor(async () => (await a.job(job.id)).assessment);
    expect(assessed.reasons[0]).toBe(`${TSC} ran out of heap in 3 jobs within a day: running it again does not help, it waits for a fix or more heap`);
    await a.user().failures.sweep();
    expect(await chain(a, job.source!.key)).toHaveLength(1);

    const other = await a.pull({ op: 'echo' });
    await a.waitForStatus(other.id, 'finished');
  });

  it('holds a pending retry when the heap abort is recorded after the assessment', async () => {
    const a = await boot();
    await earlierAborts(a);
    const { job, problem } = await abortsThenFails(a, true);
    expect(problem).toMatchObject({ title: `Heap abort: ${TSC}`, causeId: 'heap-abort' });
    const record = (await failuresOf(a)).recent.find((r) => r.jobId === job.id);
    expect(record).toMatchObject({ decision: 'hold', outcome: 'held', problemId: problem.id });
    expect(record?.pending).toBeUndefined();
    expect((await a.job(job.id)).assessment).toMatchObject({ decision: 'hold', problemId: problem.id, problemTitle: problem.title });
  });

  it('runs the held job again once a person resolves the problem', async () => {
    const a = await boot();
    await earlierAborts(a);
    const { job, problem } = await abortsThenFails(a);
    expect(a.user().failures.resolve(problem.id, BY).ok).toBe(true);
    await a.user().failures.sweep();
    await waitFor(async () => (await chain(a, job.source!.key)).length === 2 || undefined, { what: 'its item run again' });
  });
});
