// The credential check's rows (issues #1459, #1467): one per machine, keyed by its id, with the credentials an admin
// acknowledged, who acted and when; `revoked_at` set is a stop. The check's settings are the `credentialCheck` settings row.
import { DEFAULT_CREDENTIAL_CHECK, type CredentialAcceptance, type CredentialAcceptanceRepository, type CredentialCheckSettings } from '../domain/machine-credentials.ts';
import type { StoreContext } from './context.ts';

const COLUMNS = 'machine_key, credentials, accepted_by, accepted_at, revoked_at';

const rowOf = (r: Record<string, unknown>): CredentialAcceptance => ({
  machineKey: r.machine_key as string,
  credentials: JSON.parse(r.credentials as string) as string[],
  acceptedBy: r.accepted_by as string,
  acceptedAt: r.accepted_at as string,
  ...(r.revoked_at ? { revokedAt: r.revoked_at as string } : {}),
});

export function createCredentialAcceptanceRepository(c: StoreContext): CredentialAcceptanceRepository {
  return {
    accept(machineKey, credentials, acceptedBy, acceptedAt) {
      c.db.run(`INSERT INTO machine_credential_acceptances (${COLUMNS}) VALUES (?, ?, ?, ?, NULL)
        ON CONFLICT (machine_key) DO UPDATE SET credentials = excluded.credentials, accepted_by = excluded.accepted_by, accepted_at = excluded.accepted_at, revoked_at = NULL`,
      machineKey, JSON.stringify(credentials), acceptedBy, acceptedAt);
    },
    revoke(machineKey, revokedBy, revokedAt) {
      // A stop of a machine with no row makes one: it names no credentials, and who stopped it.
      c.db.run(`INSERT INTO machine_credential_acceptances (${COLUMNS}) VALUES (?, '[]', ?, ?, ?)
        ON CONFLICT (machine_key) DO UPDATE SET revoked_at = excluded.revoked_at`,
      machineKey, revokedBy, revokedAt, revokedAt);
    },
    get(machineKey) {
      const r = c.db.get(`SELECT ${COLUMNS} FROM machine_credential_acceptances WHERE machine_key = ? AND revoked_at IS NULL`, machineKey);
      return r ? rowOf(r) : undefined;
    },
    list() {
      return c.db.all(`SELECT ${COLUMNS} FROM machine_credential_acceptances`).map(rowOf);
    },
    settings() {
      const r = c.db.get('SELECT value FROM settings WHERE key = ?', 'credentialCheck');
      return r ? { strict: (JSON.parse(r.value as string) as CredentialCheckSettings).strict === true } : DEFAULT_CREDENTIAL_CHECK;
    },
    setSettings(s) {
      c.db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', 'credentialCheck', JSON.stringify({ strict: s.strict }));
    },
  };
}
