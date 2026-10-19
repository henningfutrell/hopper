// The job lease (issue #1662, design.md "Several hoppers on one database"): a claimed or running job is held by the hopper
// that drives it, through a lease in the user's database that this hopper renews while it drives the job. A hopper that
// stops releases its leases; one that crashes renews nothing, and its leases end by themselves. Any hopper on the same
// database then takes the job: it reattaches it, moves it from its last checkpoint, requeues it or fails it, as a restart
// recovery does. Its rows through `JobLeaseRepository` (`src/store/job-leases.ts`); the engine drives it (src/engine/leases.ts).

/**
 * A hopper's hold on a claimed or running job, for `ms` from now on the database's clock (issue #1954): until it ends, no
 * other hopper drives it.
 */
export interface JobLease { owner: string; ms: number }

/**
 * A person's cancel or park of a job that another hopper drives, written on the job's lease: the hopper that holds the
 * lease takes it at its next tick and acts on it as on its own request.
 */
export type RelayedAct = { kind: 'cancel'; reason: string; note?: string } | { kind: 'park' };

/** The job leases, in the user's `job_leases` table: one row per job. */
export interface JobLeaseRepository {
  /**
   * Takes, or renews, the job's lease for `lease.owner`, unless another owner holds a lease that has not ended; with `force`,
   * whoever holds it (the claim of a waiting job: a lease left on it is over, and so is an act relayed on it). Whether
   * `lease.owner` holds it now.
   */
  take(jobId: string, lease: JobLease, force?: boolean): boolean;
  /** Renews every lease `owner` holds, for `ms` from now: the jobs whose lease it holds. */
  renew(owner: string, ms: number): string[];
  /** Releases `owner`'s leases on `jobIds`, or all of them when absent. */
  release(owner: string, jobIds?: readonly string[]): void;
  /** The jobs claimed or running with no lease, or whose lease ended: no hopper drives them. Oldest first. */
  unheld(): string[];
  /** The jobs another owner than `owner` holds a lease on that has not ended. */
  heldByOthers(owner: string): Set<string>;
  /**
   * Writes `act` on the job's lease when another owner than `owner` holds it and it has not ended; a later act replaces an
   * earlier one not yet taken. Whether it was written.
   */
  relay(jobId: string, act: RelayedAct, owner: string): boolean;
  /** Takes the acts written on `owner`'s leases, and removes them: each is taken once. */
  relayed(owner: string): { jobId: string; act: RelayedAct }[];
  /** Takes the claim lock of this user's jobs until the transaction ends: one hopper at a time claims them. */
  lockClaims(): void;
}
