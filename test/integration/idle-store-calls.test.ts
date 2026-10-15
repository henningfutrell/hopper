// An idle hopper reads the jobs table a few times a tick, however many jobs it holds (issue #1154). Each store call
// blocks the event loop; before, a sync read each job about eight times and a list sent every job's body. The bound
// is per tick and does not grow with the jobs: a read for each job would pass it at 40 jobs.
import { afterEach, describe, expect, it } from 'vitest';
import { slowStoreCalls } from '../../src/store/slow-calls.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { manualItem } from '../support/manual-source.ts';
import { waitFor } from '../support/wait.ts';

const JOBS = 40;
/** The test app's engine tick (test/support/app.ts `HOPPER_TICK_MS`). */
const TICK_MS = 50;
const WINDOW_MS = 2000;
/** Reads of `jobs` a tick: about ten now (the engine's passes and a share of the source syncs). */
const PER_TICK = 20;

let a: TestApp | undefined;
let temp: ReturnType<typeof tempDbPath> | undefined;
afterEach(async () => { await a?.stop(); temp?.cleanup(); a = undefined; });

describe('an idle hopper with many ended jobs (issue #1154)', () => {
  it('reads the jobs table a few times a tick, not once or more for each job', async () => {
    temp = tempDbPath();
    a = await startTestApp({ dbPath: temp.dbPath, plugins: { machines: lanes(8) } });
    for (let i = 0; i < JOBS; i++) a.source.add(manualItem({ prompt: JSON.stringify({ op: 'echo', message: `${i}` }) }));
    await a.sync();
    await waitFor(async () => {
      const { jobs } = (await a!.api<{ jobs: { status: string }[] }>('GET', '/api/jobs?limit=1000')).body;
      return jobs.length === JOBS && jobs.every((j) => j.status === 'finished') ? true : undefined;
    }, { timeoutMs: 60_000 });
    await waitFor(async () => (a!.source.reports.filter((r) => r.kind === 'finished').length >= JOBS ? true : undefined), { timeoutMs: 30_000 });
    const before = slowStoreCalls.count('SELECT jobs');
    await new Promise((r) => setTimeout(r, WINDOW_MS));
    // Under load fewer ticks run, and the count only falls: the bound holds.
    expect(slowStoreCalls.count('SELECT jobs') - before).toBeLessThan((WINDOW_MS / TICK_MS) * PER_TICK);
  }, 120_000);
});
