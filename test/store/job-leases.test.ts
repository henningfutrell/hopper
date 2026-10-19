// The job leases (issue #1662): a hopper that crashed releases nothing, and its leases end by themselves. Two hoppers'
// leases over one user's store. A lease is timed on the database's clock (issue #1954), so a test ends the lease of the
// one that stopped renewing in the database (`endLeases`), as its time would.
import { describe, expect, it, vi } from 'vitest';
import { createJobLeases } from '../../src/engine/leases.ts';
import { openDb } from '../../src/store/db.ts';
import { spec, useTempStore } from './helpers.ts';

const t = useTempStore();

/** Ends every job lease of the admin's schema of `url` at once. */
function endLeases(url: string): void {
  const u = new URL(url);
  u.searchParams.set('schema', `${u.searchParams.get('schema')!}_u_admin`);
  const db = openDb(u.toString());
  try { db.run("UPDATE job_leases SET until = '1970-01-01T00:00:00.000Z'"); } finally { db.close(); }
}

describe('the job leases', () => {
  it('a running job is held by one hopper until its lease ends; then another takes it', () => {
    const url = t.url();
    const store = t.open(url);
    const job = store.jobs.create(spec, 1);
    store.jobs.update(job.id, { status: 'running' });
    const a = createJobLeases({ store, owner: 'a', leaseMs: 60_000 });
    const b = createJobLeases({ store, owner: 'b', leaseMs: 60_000 });
    expect(b.unheld()).toEqual([job.id]);
    expect(a.take(job.id)).toBe(true);
    expect(b.take(job.id)).toBe(false);
    expect(b.unheld()).toEqual([]);
    expect(b.heldByOthers()).toEqual(new Set([job.id]));

    // Renewed while a drives it.
    expect(a.renew([job.id])).toEqual([]);
    expect(b.take(job.id)).toBe(false);

    // a crashed: nothing renews its lease, and it ends.
    endLeases(url);
    expect(b.unheld()).toEqual([job.id]);
    expect(b.take(job.id)).toBe(true);
    // a, back, finds it lost: it drives the job no more.
    expect(a.renew([job.id])).toEqual([job.id]);
    expect(a.take(job.id)).toBe(false);
    store.close();
  });

  it('a claim takes the lease whoever held it, and a release ends it at once', () => {
    const url = t.url();
    const store = t.open(url);
    const job = store.jobs.create(spec, 1);
    const a = createJobLeases({ store, owner: 'a' });
    const b = createJobLeases({ store, owner: 'b' });
    expect(a.take(job.id)).toBe(true);
    expect(b.take(job.id, true)).toBe(true);
    expect(a.heldByOthers()).toEqual(new Set([job.id]));
    b.releaseAll();
    expect(a.heldByOthers()).toEqual(new Set());
    expect(a.take(job.id)).toBe(true);
    // A lease on a job it no longer drives is released at the next renewal.
    expect(a.renew([])).toEqual([]);
    expect(b.take(job.id)).toBe(true);
    store.close();
  });

  it('a person\'s act on a job another hopper drives is written on its lease, and that hopper takes it once', () => {
    const url = t.url();
    const store = t.open(url);
    const job = store.jobs.create(spec, 1);
    store.jobs.update(job.id, { status: 'running' });
    const a = createJobLeases({ store, owner: 'a', leaseMs: 60_000 });
    const b = createJobLeases({ store, owner: 'b', leaseMs: 60_000 });
    // No lease, or this hopper's own: nothing to relay.
    expect(b.relay(job.id, { kind: 'park' })).toBe(false);
    expect(a.take(job.id)).toBe(true);
    expect(a.relay(job.id, { kind: 'park' })).toBe(false);
    expect(b.relayed()).toEqual([]);

    expect(b.relay(job.id, { kind: 'cancel', reason: 'cancelled in UI', note: 'wrong repo' })).toBe(true);
    expect(b.relayed()).toEqual([]);
    expect(a.relayed()).toEqual([{ jobId: job.id, act: { kind: 'cancel', reason: 'cancelled in UI', note: 'wrong repo' } }]);
    expect(a.relayed()).toEqual([]);

    // The lease ended: no hopper drives the job, so nothing is relayed.
    endLeases(url);
    expect(b.relay(job.id, { kind: 'park' })).toBe(false);
    store.close();
  });

  it('an act relayed to a hopper that crashed goes to the hopper that takes the job over; a claim drops it', () => {
    const url = t.url();
    const store = t.open(url);
    const job = store.jobs.create(spec, 1);
    store.jobs.update(job.id, { status: 'running' });
    const a = createJobLeases({ store, owner: 'a', leaseMs: 60_000 });
    const b = createJobLeases({ store, owner: 'b', leaseMs: 60_000 });
    expect(a.take(job.id)).toBe(true);
    expect(b.relay(job.id, { kind: 'park' })).toBe(true);
    endLeases(url);
    expect(b.take(job.id)).toBe(true);
    expect(b.relayed()).toEqual([{ jobId: job.id, act: { kind: 'park' } }]);

    expect(a.take(job.id, true)).toBe(true);
    expect(b.relay(job.id, { kind: 'park' })).toBe(true);
    expect(b.take(job.id, true)).toBe(true);
    expect(b.relayed()).toEqual([]);
    store.close();
  });

  // Issue #1954: the hosts on one database whose clocks do not agree. Each host's clock is `Date`, faked here.
  const skewed = <T>(ms: number, f: () => T): T => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + ms });
    try { return f(); } finally { vi.useRealTimers(); }
  };

  it('a hopper whose clock is ahead takes no lease another hopper holds (issue #1954)', () => {
    const store = t.open(t.url());
    const job = store.jobs.create(spec, 1);
    store.jobs.update(job.id, { status: 'running' });
    const a = createJobLeases({ store, owner: 'a', leaseMs: 60_000 });
    const b = createJobLeases({ store, owner: 'b', leaseMs: 60_000 });
    expect(a.take(job.id)).toBe(true);
    // B's clock is ahead by two leases: by it, A's lease ended long ago.
    skewed(120_000, () => {
      expect(b.unheld()).toEqual([]);
      expect(b.take(job.id)).toBe(false);
      expect(b.heldByOthers()).toEqual(new Set([job.id]));
      expect(b.relay(job.id, { kind: 'park' })).toBe(true);
    });
    expect(a.renew([job.id])).toEqual([]);
    store.close();
  });

  it('a hopper whose clock is behind holds its lease for its length, not past it, and the others see it live (issue #1954)', () => {
    const store = t.open(t.url());
    const job = store.jobs.create(spec, 1);
    store.jobs.update(job.id, { status: 'running' });
    const a = createJobLeases({ store, owner: 'a', leaseMs: 60_000 });
    const b = createJobLeases({ store, owner: 'b', leaseMs: 60_000 });
    // A's clock is behind by two leases: the end it writes is already past for the others.
    skewed(-120_000, () => expect(a.take(job.id)).toBe(true));
    expect(b.unheld()).toEqual([]);
    expect(b.take(job.id)).toBe(false);
    skewed(-120_000, () => expect(a.renew([job.id])).toEqual([]));
    expect(b.heldByOthers()).toEqual(new Set([job.id]));
    store.close();
  });
});
