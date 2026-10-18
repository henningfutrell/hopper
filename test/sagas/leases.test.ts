// A host's sweep leases (issues #1627, #1662, design.md "Sweep leases: one host per sweep"): a pass asks its lease on each
// tick, so the database is asked once a second per lease at most; between asks the last answer stands.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SweepLeaseRepository } from '../../src/domain/leases.ts';
import { createHostLeases, type HostLeases } from '../../src/sagas/index.ts';

const quiet = { warn: () => {} };

/** One lease row per name, as the database keeps them; counts each ask for a lease that is not a host lease. */
function repo(): SweepLeaseRepository & { asks: () => number; holder: Map<string, string> } {
  const holder = new Map<string, string>();
  let asks = 0;
  return {
    holder,
    asks: () => asks,
    hold(name, owner) {
      if (!name.startsWith('host/')) asks++;
      const h = holder.get(name);
      if (h && h !== owner) return false;
      holder.set(name, owner);
      return true;
    },
    renew: () => 0,
    release(owner) { for (const [n, h] of holder) if (h === owner) holder.delete(n); },
    live: (name) => holder.has(name),
  };
}

const leases: HostLeases[] = [];
beforeEach(() => { vi.useFakeTimers({ now: 0 }); });
afterEach(() => { for (const l of leases.splice(0)) l.stop(); vi.useRealTimers(); });

const host = (r: SweepLeaseRepository, owner: string): HostLeases => {
  const l = createHostLeases({ repo: r, owner, logger: quiet });
  leases.push(l);
  return l;
};

describe('a host\'s sweep leases', () => {
  it('asks the database once a second per lease, not on each pass', () => {
    const r = repo();
    const lease = host(r, 'a').lease('u/auto-park');
    expect(lease.hold()).toEqual({ held: true, taken: true });
    for (let i = 0; i < 19; i++) { vi.advanceTimersByTime(50); expect(lease.hold()).toEqual({ held: true, taken: false }); }
    expect(r.asks()).toBe(1);
    vi.advanceTimersByTime(50);
    expect(lease.hold()).toEqual({ held: true, taken: false });
    expect(r.asks()).toBe(2);
  });

  it('a host that does not hold a lease takes it within a second of its holder\'s stop', () => {
    const r = repo();
    const a = host(r, 'a'), b = host(r, 'b');
    expect(a.lease('u/sweep').hold().held).toBe(true);
    const onB = b.lease('u/sweep');
    expect(onB.hold().held).toBe(false);
    a.stop();
    expect(onB.hold().held).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(onB.hold()).toEqual({ held: true, taken: true });
  });
});
