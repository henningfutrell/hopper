// The credential check (issues #1248, #1459, #1467): a machine whose job user holds infra credentials takes jobs with a
// warning. It is held only when an admin stopped it, or when strict mode is on and no admin used it anyway. An admin's
// acknowledgement is kept in machine_credential_acceptances: an active row (no `revokedAt`) is the acknowledgement, with
// the credentials it named; a row with `revokedAt` set is a stop. The decider (src/decider/assign.ts), the placement
// picks (src/engine/lane-calls.ts) and the Machines view all read `credentialHeld`, so they never disagree. Pure.

/** One machine's acknowledgement: the admin who acted, when, and which credentials it named; or a stop (`revokedAt`). */
export interface CredentialAcceptance {
  machineKey: string;
  credentials: readonly string[];
  acceptedBy: string;
  acceptedAt: string;
  revokedAt?: string;
}

/** The credential check's settings (issue #1467): strict mode holds every machine with credentials no admin acknowledged. */
export interface CredentialCheckSettings {
  strict: boolean;
}

export const DEFAULT_CREDENTIAL_CHECK: CredentialCheckSettings = { strict: false };

/** Issue #1459: persist and retrieve the acknowledgements and stops of machines, and the check's settings (issue #1467). */
export interface CredentialAcceptanceRepository {
  /** Acknowledge a machine's infra credentials (Use anyway, or Acknowledge): create or update the row, and clear a stop. */
  accept(machineKey: string, credentials: readonly string[], acceptedBy: string, acceptedAt: string): void;
  /** Stop a machine from taking jobs for its credentials (issue #1467): create or update the row with `revokedAt` set. */
  revoke(machineKey: string, revokedBy: string, revokedAt: string): void;
  /** A machine's acknowledgement; undefined when it has none or it is stopped. */
  get(machineKey: string): CredentialAcceptance | undefined;
  /** Every row, stopped or not. */
  list(): CredentialAcceptance[];
  /** The check's settings; the default when never set. */
  settings(): CredentialCheckSettings;
  setSettings(settings: CredentialCheckSettings): void;
}

/**
 * Issue #1467: whether the credential check holds a machine. Only a machine whose job user holds credentials; then when an
 * admin stopped it, or when strict mode is on and no admin acknowledged it.
 */
export function credentialHeld(credentials: readonly string[] | undefined, row: CredentialAcceptance | undefined, strict: boolean): boolean {
  if (!credentials?.length) return false;
  if (row?.revokedAt !== undefined) return true;
  return strict && row === undefined;
}

/** The credentials a machine's job user holds now that its acknowledgement did not name (issue #1467): they raise the warning again. */
export function newCredentials(credentials: readonly string[] | undefined, row: CredentialAcceptance | undefined): string[] {
  const named = row && row.revokedAt === undefined ? row.credentials : [];
  return (credentials ?? []).filter((c) => !named.includes(c));
}

/** The machine ids the credential check holds, of `machines` (issue #1467). */
export function credentialHeldIds(machines: readonly { id: string; infraCredentials?: readonly string[] }[], rows: readonly CredentialAcceptance[], strict: boolean): string[] {
  const byKey = new Map(rows.map((r) => [r.machineKey, r]));
  return machines.filter((m) => credentialHeld(m.infraCredentials, byKey.get(m.id), strict)).map((m) => m.id);
}
