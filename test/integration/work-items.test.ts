// The work-item ledger end to end (issue #1067): real daemon, real database, the manual source. Each item's state moves
// with its job's events, and GET /api/work-items counts every state from the ledger alone.
import { afterEach, describe, expect, it } from 'vitest';
import type { WorkItem, WorkItemState } from '../../src/domain/work-items.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

const apps: TestApp[] = [];
let cleanup: (() => void) | undefined;

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  cleanup?.();
});

type Ledger = { counts: Record<WorkItemState, number>; items: WorkItem[] };

describe('GET /api/work-items', () => {
  it('counts each item once, in the state its newest job put it: a failure handed to a person needs you', async () => {
    const db = tempDbPath();
    cleanup = db.cleanup;
    const a = await startTestApp({ dbPath: db.dbPath, plugins: { machines: lanes(2) } });
    apps.push(a);
    const job = await a.pull({ op: 'fail', message: 'HOPPER_FAILED the tests do not pass', ms: 0 });
    await a.waitForStatus(job.id, 'failed');
    const ledger = await waitFor(async () => {
      const r = (await a.api<Ledger>('GET', '/api/work-items')).body;
      return r.counts.needs_you === 1 ? r : undefined;
    }, { what: 'the item handed to a person in the ledger' });
    expect(ledger.items).toEqual([expect.objectContaining({ key: job.source!.key, state: 'needs_you', waitingOn: 'a hand-off', failedJobId: job.id })]);
    expect(Object.values(ledger.counts).reduce((s, n) => s + n, 0)).toBe(1);
    expect((await a.api<Ledger>('GET', '/api/work-items?state=done')).body.items).toEqual([]);
    expect((await a.api('GET', '/api/work-items?state=nope')).status).toBe(400);
  });
});
