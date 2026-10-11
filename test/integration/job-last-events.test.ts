// Issue #434: the Jobs view's cards each show their job's last event. GET /api/jobs/last-events answers the newest
// event of each job /api/queue holds, one per job, from the event log, so a card names it whatever the UI's capped
// event list still holds.
import { afterEach, describe, expect, it } from 'vitest';
import type { DomainEvent, Job } from '../../src/domain/types.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;

afterEach(async () => {
  await t?.stop();
  t = undefined;
  cleanup?.();
});

async function start(): Promise<TestApp> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  t = await startTestApp({ dbPath: db.dbPath });
  return t;
}

describe('GET /api/jobs/last-events (issue #434)', () => {
  it('answers the newest event of each job the queue holds, one per job', async () => {
    const a = await start();
    const one = await a.pull({ op: 'echo' }, { key: 'item-1' });
    await a.waitForStatus(one.id, 'finished');
    const two = await a.pull({ op: 'echo' }, { key: 'item-2' });
    await a.waitForStatus(two.id, 'finished');

    const r = await a.api<{ events: DomainEvent[] }>('GET', '/api/jobs/last-events');
    expect(r.status).toBe(200);
    const all = await a.events('after=0&limit=1000');
    const newest = (id: string) => all.filter((e) => e.jobId === id).sort((x, y) => y.seq - x.seq)[0]!;
    const byJob = new Map(r.body.events.map((e) => [e.jobId, e]));
    expect(r.body.events).toHaveLength(byJob.size);
    expect(byJob.get(one.id)).toEqual(newest(one.id));
    expect(byJob.get(two.id)).toEqual(newest(two.id));

    const queue = (await a.api<Record<string, unknown>>('GET', '/api/queue')).body;
    const held = new Set(Object.values(queue).filter(Array.isArray).flat().map((j) => (j as Job).id));
    for (const e of r.body.events) expect(held.has(e.jobId!)).toBe(true);
  });

  it('answers none for a hopper with no job', async () => {
    const a = await start();
    const r = await a.api<{ events: DomainEvent[] }>('GET', '/api/jobs/last-events');
    expect(r.status).toBe(200);
    expect(r.body.events).toEqual([]);
  });
});
