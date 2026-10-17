// The job leases (issue #1662): a hopper that crashed releases nothing, and its leases end by themselves. Two hoppers'
// leases over one user's store, with the clock moved past the lease of the one that stopped renewing.
import { describe, expect, it } from 'vitest';
import { createJobLeases } from '../../src/engine/leases.ts';
import { fixedClock, spec, useTempStore } from './helpers.ts';

const t = useTempStore();

describe('the job leases', () => {
  it('a running job is held by one hopper until its lease ends; then another takes it', () => {
    const clock = fixedClock('2026-10-17T10:00:00.000Z');
    const store = t.open(t.url(), clock);
    const job = store.jobs.create(spec, 1);
    store.jobs.update(job.id, { status: 'running' });
    const a = createJobLeases({ store, clock, owner: 'a', leaseMs: 60_000 });
    const b = createJobLeases({ store, clock, owner: 'b', leaseMs: 60_000 });
    expect(b.unheld()).toEqual([job.id]);
    expect(a.take(job.id)).toBe(true);
    expect(b.take(job.id)).toBe(false);
    expect(b.unheld()).toEqual([]);
    expect(b.heldByOthers()).toEqual(new Set([job.id]));

    // Renewed while a drives it.
    clock.set('2026-10-17T10:00:50.000Z');
    expect(a.renew([job.id])).toEqual([]);
    clock.set('2026-10-17T10:01:30.000Z');
    expect(b.take(job.id)).toBe(false);

    // a crashed: nothing renews its lease, and it ends.
    clock.set('2026-10-17T10:01:51.000Z');
    expect(b.unheld()).toEqual([job.id]);
    expect(b.take(job.id)).toBe(true);
    // a, back, finds it lost: it drives the job no more.
    expect(a.renew([job.id])).toEqual([job.id]);
    expect(a.take(job.id)).toBe(false);
    store.close();
  });

  it('a claim takes the lease whoever held it, and a release ends it at once', () => {
    const clock = fixedClock('2026-10-17T10:00:00.000Z');
    const store = t.open(t.url(), clock);
    const job = store.jobs.create(spec, 1);
    const a = createJobLeases({ store, clock, owner: 'a' });
    const b = createJobLeases({ store, clock, owner: 'b' });
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
    const clock = fixedClock('2026-10-17T10:00:00.000Z');
    const store = t.open(t.url(), clock);
    const job = store.jobs.create(spec, 1);
    store.jobs.update(job.id, { status: 'running' });
    const a = createJobLeases({ store, clock, owner: 'a', leaseMs: 60_000 });
    const b = createJobLeases({ store, clock, owner: 'b', leaseMs: 60_000 });
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
    clock.set('2026-10-17T10:01:01.000Z');
    expect(b.relay(job.id, { kind: 'park' })).toBe(false);
    store.close();
  });

  it('an act relayed to a hopper that crashed goes to the hopper that takes the job over; a claim drops it', () => {
    const clock = fixedClock('2026-10-17T10:00:00.000Z');
    const store = t.open(t.url(), clock);
    const job = store.jobs.create(spec, 1);
    store.jobs.update(job.id, { status: 'running' });
    const a = createJobLeases({ store, clock, owner: 'a', leaseMs: 60_000 });
    const b = createJobLeases({ store, clock, owner: 'b', leaseMs: 60_000 });
    expect(a.take(job.id)).toBe(true);
    expect(b.relay(job.id, { kind: 'park' })).toBe(true);
    clock.set('2026-10-17T10:01:01.000Z');
    expect(b.take(job.id)).toBe(true);
    expect(b.relayed()).toEqual([{ jobId: job.id, act: { kind: 'park' } }]);

    expect(a.take(job.id, true)).toBe(true);
    expect(b.relay(job.id, { kind: 'park' })).toBe(true);
    expect(b.take(job.id, true)).toBe(true);
    expect(b.relayed()).toEqual([]);
    store.close();
  });
});
