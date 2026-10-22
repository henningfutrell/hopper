// A timer's long loop gives back the event loop between its items (issue #2392). Every store call blocks the event
// loop ("Database": the Store port stays synchronous), so a pass that offers hundreds of items with no real wait between
// them held every request until it ended: a sync of a source with about 200 items stalled the hopper for seconds, one
// `SELECT work_items` an item. Now the loop yields between items, and a request is answered while the pass still runs.
// The test asserts the order, not a time: `/api/health` and a plan read answer before the sync that runs ends.
import { afterEach, describe, expect, it } from 'vitest';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { manualItem } from '../support/manual-source.ts';

/** Items the sync offers in one pass: each a new job, each several store calls. */
const ITEMS = 300;

let a: TestApp | undefined;
let temp: ReturnType<typeof tempDbPath> | undefined;
afterEach(async () => { await a?.stop(); temp?.cleanup(); a = undefined; });

describe('a sync of many items (issue #2392)', () => {
  it('answers /api/health and a plan read while its loop still runs', async () => {
    temp = tempDbPath();
    // No machines: the jobs stay queued, so only the sync's own loop works.
    a = await startTestApp({ dbPath: temp.dbPath });
    for (let i = 0; i < ITEMS; i++) a.source.add(manualItem({ prompt: JSON.stringify({ op: 'echo', message: `${i}` }) }));
    let synced = false;
    const sync = a.sync().then(() => { synced = true; });
    const answered: { path: string; status: number; duringSync: boolean }[] = [];
    const read = (path: string) => a!.api('GET', path).then((r) => { answered.push({ path, status: r.status, duringSync: !synced }); });
    await Promise.all([read('/api/health'), read('/api/infra-plans'), sync]);
    expect(answered.map((x) => x.status)).toEqual([200, 200]);
    expect(answered.filter((x) => !x.duringSync).map((x) => x.path), 'requests that waited for the whole sync').toEqual([]);
    const jobs = a.user().store.jobs.list();
    expect(jobs.length).toBe(ITEMS);
  }, 120_000);
});
