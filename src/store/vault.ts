// The vault's table (issue #558): a secret's sealed value in its own column, never read into its metadata (the body).
// Only `sealed` answers a value, and only sealed.
import type { VaultRepository } from '../domain/ports.ts';
import type { VaultSecret } from '../domain/vault.ts';
import { parse, type StoreContext } from './context.ts';

export function createVaultRepository(c: StoreContext): VaultRepository {
  return {
    list: () => c.db.all('SELECT body FROM vault_secrets ORDER BY name').map((r) => parse<VaultSecret>(r.body)),
    get(name) {
      const r = c.db.get('SELECT body FROM vault_secrets WHERE name = ?', name);
      return r ? parse<VaultSecret>(r.body) : undefined;
    },
    add(secret, sealed) {
      return c.db.run('INSERT INTO vault_secrets (id, name, sealed, body) VALUES (?, ?, ?, ?) ON CONFLICT (name) DO NOTHING',
        secret.id, secret.name, sealed, JSON.stringify(secret)).changes > 0;
    },
    replace(secret, sealed) {
      return c.db.run('UPDATE vault_secrets SET sealed = ?, body = ? WHERE id = ?', sealed, JSON.stringify(secret), secret.id).changes > 0;
    },
    sealed(id) {
      const r = c.db.get('SELECT sealed FROM vault_secrets WHERE id = ?', id);
      return (r?.sealed as string | undefined) ?? undefined;
    },
    remove: (name) => c.db.run('DELETE FROM vault_secrets WHERE name = ?', name).changes > 0,
  };
}
