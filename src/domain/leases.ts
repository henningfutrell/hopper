// Sweep leases (issue #1627, design.md "Sweep leases: one host per sweep"): a host's hold on one sweep or recovery, so
// that on two hopper hosts on one database each sweep runs on one of them. The model is the saga lease
// (src/domain/sagas.ts): an owner and an until, on the database's clock; the holder renews it while it lives, and a
// host that stops renews nothing, so the lease ends and another host takes it. Pure: the store keeps the rows, src/sagas/leases.ts holds them.

/** How long a lease lasts past its last renewal: a host that stops leaves its sweeps to another host after this. */
export const SWEEP_LEASE_MS = 30_000;
/** How often a host renews the leases it holds, well inside their life. */
export const SWEEP_LEASE_RENEW_MS = 10_000;

/** The sweep leases, in the instance's `sweep_leases` table: one row per sweep name. Timed on the database's clock (issue #1954). */
export interface SweepLeaseRepository {
  /**
   * Takes or renews lease `name` for `owner`, for `ms` on, when no other owner holds one that has not ended. Whether
   * `owner` holds it now.
   */
  hold(name: string, owner: string, ms: number): boolean;
  /** Renews every lease `owner` holds, for `ms` on: how many. */
  renew(owner: string, ms: number): number;
  /** Releases every lease `owner` holds (a host that stops). */
  release(owner: string): void;
  /** Whether lease `name` is held by anyone now. */
  live(name: string): boolean;
}

/** The lease a host holds from its start to its stop: while it is live, so is the host. */
export const hostLease = (owner: string): string => `host/${owner}`;

/** One sweep's lease, as a pass asks it. */
export interface SweepLease {
  /** Takes or renews it: whether this host holds it now, and whether it took it just now (it ran elsewhere, or not yet). */
  hold(): { held: boolean; taken: boolean };
}

/** One host alone (a test, a part built with no database of its own): the lease is always held, and taken at its first ask. */
export const soleLease = (): SweepLease => {
  let first = true;
  return { hold() { const taken = first; first = false; return { held: true, taken }; } };
};
