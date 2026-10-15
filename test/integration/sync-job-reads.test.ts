// One sync of a job source reads its jobs a few times, not each job again and again (issue #1154). A source with about
// 740 ended jobs made thousands of reads of `jobs` on each sync, one round trip each, and each blocks the event loop.
import { afterEach, describe, expect, it } from 'vitest';
import { slowStoreCalls } from '../../src/store/slow-calls.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { manualItem } from '../support/manual-source.ts';
import { waitFor } from '../support/wait.ts';

const JOBS = 40;

let a: TestApp | undefined;
let temp: ReturnType<typeof tempDbPath> | undefined;
afterEach(async () => { await a?.stop(); temp?.cleanup(); a = undefined; });

describe('a sync of a source with many ended jobs (issue #1154)', () => {
  it('reads the jobs table a few times, not once or more for each job', async () => {
    temp = tempDbPath();
    a = await startTestApp({ dbPath: temp.dbPath, plugins: { machines: lanes(8) } });
    for (let i = 0; i < JOBS; i++) a.source.add(manualItem({ prompt: JSON.stringify({ op: 'echo', message: `${i}` }) }));
    await a.sync();
    await waitFor(async () => {
      const { jobs } = (await a!.api<{ jobs: { status: string }[] }>('GET', '/api/jobs?limit=1000')).body;
      return jobs.length === JOBS && jobs.every((j) => j.status === 'finished') ? true : undefined;
    }, { timeoutMs: 60_000 });
    // Each job's end reported to its source.
    await waitFor(async () => (a!.source.reports.filter((r) => r.kind === 'finished').length >= JOBS ? true : undefined), { timeoutMs: 30_000 });
    await a.sync();
    const before = slowStoreCalls.count('SELECT jobs');
    await a.sync();
    // A few whole-table reads (ids and versions only) at each step of the sync; before, about eight reads for each job.
    expect(slowStoreCalls.count('SELECT jobs') - before).toBeLessThan(JOBS);
  }, 120_000);
});
