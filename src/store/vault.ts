// The vault's table (issue #558): a secret's sealed value in its own column, never read into its metadata (the body).
// Only `sealed` answers a value, and only sealed. The data key the KMS wrapped (issue #586) is a row of the config table,
// which no config record names: only the vault reads it.
import type { VaultRepository } from '../domain/ports.ts';
import type { Template, VaultSecret } from '../domain/vault.ts';
import { parse, type StoreContext } from './context.ts';

const DATA_KEY = 'vault-data-key';

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
    templates: () => c.db.all('SELECT body FROM templates ORDER BY name').map((r) => parse<Template>(r.body)),
    template(name) {
      const r = c.db.get('SELECT body FROM templates WHERE name = ?', name);
      return r ? parse<Template>(r.body) : undefined;
    },
    saveTemplate(t) {
      c.db.run('INSERT INTO templates (name, body) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET body = EXCLUDED.body', t.name, JSON.stringify(t));
    },
    removeTemplate: (name) => c.db.run('DELETE FROM templates WHERE name = ?', name).changes > 0,
    dataKey() {
      const r = c.db.get('SELECT value FROM config WHERE name = ?', DATA_KEY);
      return r ? String(JSON.parse(String(r.value))) : undefined;
    },
    keepDataKey: (wrapped) => c.db.run('INSERT INTO config (name, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (name) DO NOTHING',
      DATA_KEY, JSON.stringify(wrapped), c.clock.now().toISOString()).changes > 0,
  };
}
