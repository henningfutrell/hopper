// Machine credential acceptances (issue #1459): the admin's acceptance of a machine despite its infra credentials.
// One row per machine with its user_id (the key), the credentials accepted, who accepted it and when. A machine with no
// row or a revoked row (`revokedAt` is set) takes no jobs.
import type { CredentialAcceptanceRepository, CredentialAcceptance } from '../domain/machine-credentials.ts';
import type { StoreContext } from './context.ts';

export function createCredentialAcceptanceRepository(c: StoreContext): CredentialAcceptanceRepository {
  const get = (machineKey: string): CredentialAcceptance | undefined => {
    const r = c.db.get('SELECT machine_key, credentials, accepted_by, accepted_at, revoked_at FROM machine_credential_acceptances WHERE machine_key = ? AND revoked_at IS NULL', machineKey);
    if (!r) return undefined;
    return {
      machineKey: r.machine_key as string,
      credentials: JSON.parse(r.credentials as string) as string[],
      acceptedBy: r.accepted_by as string,
      acceptedAt: r.accepted_at as string,
      ...(r.revoked_at ? { revokedAt: r.revoked_at as string } : {}),
    };
  };
  return {
    accept(machineKey, credentials, acceptedBy, acceptedAt) {
      c.db.run(`INSERT INTO machine_credential_acceptances (machine_key, credentials, accepted_by, accepted_at, revoked_at)
        VALUES (?, ?, ?, ?, NULL)
        ON CONFLICT (machine_key) DO UPDATE SET credentials = excluded.credentials, accepted_by = excluded.accepted_by, accepted_at = excluded.accepted_at, revoked_at = NULL`,
      machineKey, JSON.stringify(credentials), acceptedBy, acceptedAt);
    },
    revoke(machineKey, revokedAt) {
      c.db.run('UPDATE machine_credential_acceptances SET revoked_at = ? WHERE machine_key = ? AND revoked_at IS NULL', revokedAt, machineKey);
    },
    get,
    list() {
      const rows = c.db.all('SELECT machine_key, credentials, accepted_by, accepted_at, revoked_at FROM machine_credential_acceptances');
      return rows.map((r) => ({
        machineKey: r.machine_key as string,
        credentials: JSON.parse(r.credentials as string) as string[],
        acceptedBy: r.accepted_by as string,
        acceptedAt: r.accepted_at as string,
        ...(r.revoked_at ? { revokedAt: r.revoked_at as string } : {}),
      }));
    },
  };
}
