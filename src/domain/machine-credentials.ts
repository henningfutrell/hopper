// Machine credential acceptances (issue #1459): when an admin accepts the blast-radius risk of running jobs on a machine
// whose job user holds infra credentials. Persisted in machine_credential_acceptances; the decider (src/decider/assign.ts)
// and lane listing (src/engine/lane-calls.ts) treat an accepted machine as ready. A machine with no row, or a revoked
// row (`revokedAt` is set), takes no jobs.

/** One machine's acceptance: the admin who accepted it, when, and which credentials were accepted. */
export interface CredentialAcceptance {
  machineKey: string;
  credentials: readonly string[];
  acceptedBy: string;
  acceptedAt: string;
  revokedAt?: string;
}

/** Issue #1459: persist and retrieve credential acceptances for machines. */
export interface CredentialAcceptanceRepository {
  /**
   * Accept a machine's infra credentials: create or update the acceptance. When `revokedAt` is set, clears it.
   * The machine takes jobs again.
   */
  accept(machineKey: string, credentials: readonly string[], acceptedBy: string, acceptedAt: string): void;
  /**
   * Revoke an acceptance: set `revokedAt`. The machine takes no jobs. No-op when the machine has no acceptance.
   */
  revoke(machineKey: string, revokedAt: string): void;
  /**
   * Get the acceptance for a machine; undefined when the machine has no acceptance or it is revoked.
   */
  get(machineKey: string): CredentialAcceptance | undefined;
  /**
   * List all acceptances, revoked or not.
   */
  list(): CredentialAcceptance[];
}
