// The job lease (issue #1662, design.md "Several hoppers on one database"): a claimed or running job is held by the hopper
// that drives it, through a lease in the user's database that this hopper renews while it drives the job. A hopper that
// stops releases its leases; one that crashes renews nothing, and its leases end by themselves. Any hopper on the same
// database then takes the job: it reattaches it, moves it from its last checkpoint, requeues it or fails it, as a restart
// recovery does. Its rows through `JobLeaseRepository` (`src/store/job-leases.ts`); the engine drives it (src/engine/leases.ts).

/** A hopper's hold on a claimed or running job: until `until`, no other hopper drives it. */
export interface JobLease { owner: string; until: string }

/** The job leases, in the user's `job_leases` table: one row per job. */
export interface JobLeaseRepository {
  /**
   * Takes, or renews, the job's lease for `lease.owner`, unless another owner holds it until after `now`; with `force`,
   * whoever holds it (the claim of a waiting job: a lease left on it is over). Whether `lease.owner` holds it now.
   */
  take(jobId: string, lease: JobLease, now: string, force?: boolean): boolean;
  /** Renews every lease `owner` holds, until `until`: the jobs whose lease it holds. */
  renew(owner: string, until: string): string[];
  /** Releases `owner`'s leases on `jobIds`, or all of them when absent. */
  release(owner: string, jobIds?: readonly string[]): void;
  /** The jobs claimed or running with no lease, or whose lease ended by `now`: no hopper drives them. Oldest first. */
  unheld(now: string): string[];
  /** The jobs another owner than `owner` holds a lease on until after `now`. */
  heldByOthers(owner: string, now: string): Set<string>;
  /** Takes the claim lock of this user's jobs until the transaction ends: one hopper at a time claims them. */
  lockClaims(): void;
}
