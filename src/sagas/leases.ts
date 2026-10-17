// The sweep leases of this process (issue #1627, design.md "Sweep leases: one host per sweep"): each sweep or recovery
// that must run on one host of those on one database asks its lease before each pass, and runs only while this host
// holds it. The host renews every lease it holds every 10 s, and its own host lease with them, so another host sees it
// live; it releases them all when it stops. A host that stops without that renews nothing: 30 s on, its leases end and
// another host takes each at its next pass. The lease owner is the saga coordinator's (`sagaOwner`).
import { hostLease, SWEEP_LEASE_MS, SWEEP_LEASE_RENEW_MS, type SweepLease, type SweepLeaseRepository } from '../domain/leases.ts';

export interface HostLeases {
  /** This process as a lease owner. */
  readonly owner: string;
  /** The lease of the sweep `name` (one name per sweep, and per user for a user's). */
  lease(name: string): SweepLease;
  /** Whether the host `owner` names still runs: its host lease is live. */
  live(owner: string): boolean;
  /** Releases every lease of this host and stops renewing. */
  stop(): void;
}

export function createHostLeases(o: { repo: SweepLeaseRepository; owner: string; clock: { now(): Date }; logger: { warn(line: string): void } }): HostLeases {
  const { repo, owner } = o;
  const at = (ms = 0): string => new Date(o.clock.now().getTime() + ms).toISOString();
  /** The leases this host held at its last ask: a hold that was not among them is taken. */
  const held = new Set<string>();
  const hold = (name: string): boolean => repo.hold(name, owner, at(SWEEP_LEASE_MS), at());
  hold(hostLease(owner));
  const timer = setInterval(() => {
    try { repo.renew(owner, at(SWEEP_LEASE_MS)); hold(hostLease(owner)); } catch (e) { o.logger.warn(`hopper: renewing the sweep leases failed: ${(e as Error).message}`); }
  }, SWEEP_LEASE_RENEW_MS);
  timer.unref();
  return {
    owner,
    lease: (name) => ({
      hold() {
        let now: boolean;
        try { now = hold(name); } catch (e) { o.logger.warn(`hopper: the sweep lease ${name}: ${(e as Error).message}`); now = false; }
        const taken = now && !held.has(name);
        if (now) held.add(name); else held.delete(name);
        return { held: now, taken };
      },
    }),
    live: (other) => other === owner || repo.live(hostLease(other), at()),
    stop() {
      clearInterval(timer);
      held.clear();
      try { repo.release(owner); } catch (e) { o.logger.warn(`hopper: releasing the sweep leases failed: ${(e as Error).message}`); }
    },
  };
}
