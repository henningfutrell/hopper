// A busy hopper reads the jobs table a fixed number of times a pass, however many jobs it holds (issue #1411). Each
// store call blocks the event loop; before, each job that ended started a pass over every failed job, and the failure
// sweep and the engine read one job at a time: with about 150 jobs in the store, a busy round stalled the loop for seconds,
// hundreds of `SELECT jobs` in each stall. The bound is per job of the round and per tick, and does not grow with the
// failed jobs already in the store: a pass that read each of them for each job that ends would pass it many times over.
// The idle path's bound: `idle-store-calls.test.ts`.
import { afterEach, describe, expect, it } from 'vitest';
import type { Job } from '../../src/domain/types.ts';
import { slowStoreCalls } from '../../src/store/slow-calls.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { manualItem } from '../support/manual-source.ts';
import { waitFor } from '../support/wait.ts';

/** Failed jobs in the store before the round: each a hand-off nothing ends. */
const FAILED = 60;
/** Jobs the round runs to their end. */
const ROUND = 10;
/** The test app's engine tick (test/support/app.ts `HOPPER_TICK_MS`). */
const TICK_MS = 50;
/** Reads of `jobs` a tick (as `idle-store-calls.test.ts`). */
const PER_TICK = 20;
/** Reads of `jobs` for each job of the round, from its intake to its report: about 70 now, whatever the failed jobs. */
const PER_JOB = 100;

let a: TestApp | undefined;
let temp: ReturnType<typeof tempDbPath> | undefined;
afterEach(async () => { await a?.stop(); temp?.cleanup(); a = undefined; });

const ended = (j: Job): boolean => ['finished', 'failed', 'cancelled', 'rejected'].includes(j.status);

async function runToTheirEnd(app: TestApp, ops: Record<string, unknown>[]): Promise<void> {
  const keys = new Set<string>();
  for (const op of ops) {
    const item = manualItem({ prompt: JSON.stringify(op) });
    keys.add(item.key);
    app.source.add(item);
  }
  await app.sync();
  await waitFor(async () => {
    const { jobs } = (await app.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body;
    const mine = jobs.filter((j) => j.source && keys.has(j.source.key));
    return mine.length >= keys.size && jobs.every(ended) ? true : undefined;
  }, { what: `${keys.size} jobs ended`, timeoutMs: 60_000 });
}

describe('a busy hopper with many failed jobs (issue #1411)', () => {
  it('reads the jobs table a fixed number of times a pass, not once or more for each job', async () => {
    temp = tempDbPath();
    a = await startTestApp({ dbPath: temp.dbPath, plugins: { machines: lanes(8) } });
    await runToTheirEnd(a, Array.from({ length: FAILED }, (_, i) => ({ op: 'fail', message: `boom ${i}` })));
    // The failures' own follow-up (assessment, hand-offs) settles first.
    await new Promise((r) => setTimeout(r, 1000));

    const before = slowStoreCalls.count('SELECT jobs');
    const from = performance.now();
    await runToTheirEnd(a, Array.from({ length: ROUND }, (_, i) => ({ op: 'echo', message: `${i}` })));
    await waitFor(async () => (a!.source.reports.filter((r) => r.kind === 'finished').length >= ROUND ? true : undefined), { timeoutMs: 30_000 });
    const reads = slowStoreCalls.count('SELECT jobs') - before;
    const ticks = Math.ceil((performance.now() - from) / TICK_MS);
    expect(reads, `${reads} reads of jobs for ${ROUND} jobs in ${ticks} ticks, with ${FAILED} failed jobs in the store`).toBeLessThan(ticks * PER_TICK + ROUND * PER_JOB);
  }, 180_000);
});
