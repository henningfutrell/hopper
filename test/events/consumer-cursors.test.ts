// Issue #1572: an event committed just before a stop is still seen by each consumer after the next start. Each consumer
// keeps the last event it handled (its cursor) in the database, and catches up from it at start. The store, the event log
// and the webhook receiver are real; the search index is a recording double at its seam (SearchIndex).
//
// Feature: Event consumers catch up after a stop
//   Scenario: an event committed while the webhook dispatcher was stopped is sent once after the next start
//   Scenario: a job changed while search was stopped is written to the index after the next start
//   Scenario: a hand-off closed while the decider comparisons were stopped is compared once after the next start
//   Scenario: a consumer started for the first time does not replay the events from before
//   Scenario: an event handed again at a catch-up (a build before ran meanwhile, and kept no cursor) is sent no more
import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { SearchDocument, SearchIndex } from '../../src/domain/search.ts';
import type { UserStore } from '../../src/domain/ports.ts';
import { createMinorDecisions } from '../../src/minor-decisions/index.ts';
import { createOutbound, createOutboundGuard } from '../../src/outbound/index.ts';
import { createUserSearch } from '../../src/search/index.ts';
import { openInstanceStore } from '../../src/store/index.ts';
import { openDb } from '../../src/store/db.ts';
import { createWebhookDispatcher } from '../../src/webhooks/index.ts';
import { installFromBefore, testDatabaseUrl } from '../support/database.ts';
import { startReceiver, type Receiver } from '../support/receiver.ts';
import { waitFor } from '../support/wait.ts';

const clock = { now: () => new Date() };
const quiet = { info: () => undefined, warn: () => undefined };
const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

/** One user's database; each `open()` is a new start of the hopper on it: a new connection, nothing kept in memory. */
function database() {
  const url = installFromBefore(testDatabaseUrl());
  const instance = openInstanceStore({ url, clock });
  cleanups.push(() => instance.close());
  const admin = instance.users.get('admin')!;
  return {
    open(): UserStore {
      const store = instance.userStore(admin);
      cleanups.push(() => store.close());
      return store;
    },
    /** Raw SQL on the user's schema: what a build before, which keeps no cursor, leaves behind. */
    sql(statement: string): void {
      const u = new URL(url);
      u.searchParams.set('schema', `${u.searchParams.get('schema')!}_u_admin`);
      const raw = openDb(u.toString());
      try { raw.run(statement); } finally { raw.close(); }
    },
  };
}

/** A job, and its `job.queued` event, as the engine appends it. */
function queue(store: UserStore, goal?: string) {
  const spec = { executor: 'test', payload: {}, ...(goal ? { goal } : {}) };
  const job = store.jobs.create(spec, 5);
  store.events.append({ type: 'job.queued', jobId: job.id, data: { spec, priority: 5 } });
  return job;
}

function dispatcher(store: UserStore) {
  const outbound = createOutbound({ guard: createOutboundGuard({ clock, logger: quiet }), clock, log: store.outboundSends });
  const d = createWebhookDispatcher({ store, clock, secretOf: () => 'shh', outbound, baseMs: 20, sweepMs: 10 });
  cleanups.push(async () => { await d.stop(); outbound.stop(); });
  return d;
}

async function receiver(): Promise<Receiver> {
  const r = await startReceiver();
  cleanups.push(() => r.close());
  return r;
}

/** A search index that keeps what it is given. */
function recordingIndex(): SearchIndex & { docs: Map<string, SearchDocument> } {
  const docs = new Map<string, SearchDocument>();
  return {
    docs,
    ensureSchema: async () => {},
    put: async (ds) => { for (const d of ds) docs.set(d.id, d); },
    remove: async (ids) => { for (const id of ids) docs.delete(id); },
    count: async () => docs.size,
    search: async () => ({ total: 0, hits: [], facets: { type: {}, status: {}, labels: {}, repo: {} } } as never),
    suggest: async () => [],
  };
}

function search(store: UserStore, index: SearchIndex) {
  const s = createUserSearch({ scope: { instance: 'test', user: 'admin' }, store, index, access: undefined, url: (_t, ref) => ref, clock, logger: quiet, passMs: 20 });
  cleanups.push(() => s.stop());
  return s;
}

function minorDecisions(store: UserStore) {
  const jev = { available: () => ({ available: false as const, why: 'off' }), pick: async () => ({ ok: false as const, why: 'off' }) };
  const m = createMinorDecisions({ store, clock, jev: jev as never, typesafeKey: () => ({ set: false }) as never, timeoutMs: 1000, logger: quiet });
  cleanups.push(() => m.stop());
  return m;
}

describe('event consumers catch up from their cursor (issue #1572)', () => {
  it('sends a webhook once for an event committed while the dispatcher was stopped', async () => {
    const db = database();
    const rx = await receiver();
    const first = db.open();
    first.webhooks.add({ name: 'hook', url: rx.url, events: ['job.queued'], active: true });
    const before = dispatcher(first);
    before.start();
    await before.stop();
    queue(first);

    const after = db.open();
    dispatcher(after).start();
    await waitFor(() => rx.received.length === 1, { what: 'the webhook of the event committed while stopped' });
    expect(JSON.parse(rx.received[0]!.body)).toMatchObject({ type: 'job.queued' });

    // A second start sends it no more.
    const again = db.open();
    dispatcher(again).start();
    await new Promise((r) => setTimeout(r, 200));
    expect(rx.received).toHaveLength(1);
  });

  it('writes a job changed while search was stopped to the index after the next start', async () => {
    const db = database();
    const index = recordingIndex();
    const first = db.open();
    // The index holds the user's documents already, so no backfill writes the job.
    queue(first, 'an older job');
    const before = search(first, index);
    before.start();
    await waitFor(() => index.docs.size === 1, { what: 'the older job in the index' });
    await before.stop();
    const job = queue(first, 'clear the cache');

    const after = search(db.open(), index);
    after.start();
    await waitFor(() => [...index.docs.values()].some((d) => d.ref === job.id), { what: 'the job in the index' });
  });

  it('compares a hand-off closed while the decider comparisons were stopped, once, after the next start', async () => {
    const db = database();
    const first = db.open();
    const before = minorDecisions(first);
    before.start();
    const job = first.jobs.create({ executor: 'test', payload: {} }, 5);
    const pickId = randomUUID();
    first.events.append({
      type: 'minor_decision.picked', jobId: job.id,
      data: { pickId, point: 'failure-assessment', by: 'jev', options: [{ id: 'retry', label: 'retry' }, { id: 'person', label: 'person' }], pick: 'retry', confidence: 0.9, mode: 'shadow', threshold: 0.8, applied: false, notApplied: 'shadow' },
    });
    before.stop();
    first.events.append({ type: 'handoff.closed', jobId: job.id, data: { handoffId: 'h1', end: 'run_again' } });

    const compared = (s: UserStore) => s.events.recent(100, ['minor_decision.compared']);
    const after = db.open();
    minorDecisions(after).start();
    const got = await waitFor(() => { const c = compared(after); return c.length > 0 ? c : undefined; }, { what: 'the comparison' });
    expect(got[0]!.data).toMatchObject({ pickId, actual: 'retry', agreed: true, decidedBy: 'person' });

    const again = db.open();
    minorDecisions(again).start();
    await new Promise((r) => setTimeout(r, 100));
    expect(compared(again)).toHaveLength(1);
  });

  it('does not replay the events from before a consumer\'s first start', async () => {
    const db = database();
    const rx = await receiver();
    const store = db.open();
    store.webhooks.add({ name: 'hook', url: rx.url, events: ['job.queued'], active: true });
    queue(store);
    dispatcher(store).start();
    queue(store);
    await waitFor(() => rx.received.length === 1, { what: 'the webhook of the new event' });
    await new Promise((r) => setTimeout(r, 200));
    expect(rx.received).toHaveLength(1);
  });

  it('sends an event handed again at a catch-up no more', async () => {
    const db = database();
    const rx = await receiver();
    const first = db.open();
    first.webhooks.add({ name: 'hook', url: rx.url, events: ['job.queued'], active: true });
    const before = dispatcher(first);
    before.start();
    queue(first);
    await waitFor(() => rx.received.length === 1, { what: 'the first webhook' });
    await before.stop();
    db.sql("UPDATE event_cursors SET seq = 0 WHERE consumer = 'webhooks'");

    dispatcher(db.open()).start();
    await new Promise((r) => setTimeout(r, 200));
    expect(rx.received).toHaveLength(1);
  });
});
