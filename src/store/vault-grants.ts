// The vault grants (issue #652, design.md "Vault grants"): one row per item key, the grant as JSON. A grant again
// replaces the one before; Revoke removes it. The events keep each grant and revocation.
import type { VaultGrantRepository } from '../domain/ports.ts';
import type { VaultGrant } from '../domain/vault-grants.ts';
import { parse, type StoreContext } from './context.ts';

/** Tenant migration 40: a table only, so the build before runs on it (and gives the vault to every box job, as before). */
export const VAULT_GRANT_TABLE = 'CREATE TABLE vault_grants (seq BIGSERIAL PRIMARY KEY, key TEXT NOT NULL UNIQUE, body TEXT NOT NULL)';

export function createVaultGrantRepository(c: StoreContext): VaultGrantRepository {
  return {
    get(key) {
      const r = c.db.get('SELECT body FROM vault_grants WHERE key = ?', key);
      return r ? parse<VaultGrant>(r.body) : undefined;
    },
    list: () => c.db.all('SELECT body FROM vault_grants ORDER BY seq').map((r) => parse<VaultGrant>(r.body)),
    put(grant) {
      c.db.run('INSERT INTO vault_grants (key, body) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET body = EXCLUDED.body', grant.key, JSON.stringify(grant));
      return grant;
    },
    remove: (key) => c.db.run('DELETE FROM vault_grants WHERE key = ?', key).changes > 0,
  };
}
