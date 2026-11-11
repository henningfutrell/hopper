// The scope grants (issue #2923, design.md "Scope grants"): one row per scope key, the grant as JSON. A
// grant again replaces the one before; Revoke removes it. The events keep each grant and revocation.
import type { VaultScopeGrant, VaultScopeGrantRepository } from '../domain/vault-scope-grants.ts';
import { parse, type StoreContext } from './context.ts';

/** Tenant migration 109: a table only, so the build before runs on it, and never reads it. */
export const VAULT_SCOPE_GRANT_TABLE = 'CREATE TABLE vault_scope_grants (seq BIGSERIAL PRIMARY KEY, key TEXT NOT NULL UNIQUE, body TEXT NOT NULL)';

export function createVaultScopeGrantRepository(c: StoreContext): VaultScopeGrantRepository {
  return {
    get(key) {
      const r = c.db.get('SELECT body FROM vault_scope_grants WHERE key = ?', key);
      return r ? parse<VaultScopeGrant>(r.body) : undefined;
    },
    list: () => c.db.all('SELECT body FROM vault_scope_grants ORDER BY seq').map((r) => parse<VaultScopeGrant>(r.body)),
    put(grant) {
      c.db.run('INSERT INTO vault_scope_grants (key, body) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET body = EXCLUDED.body', grant.key, JSON.stringify(grant));
      return grant;
    },
    remove: (key) => c.db.run('DELETE FROM vault_scope_grants WHERE key = ?', key).changes > 0,
  };
}
