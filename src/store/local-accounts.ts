// The local accounts (issue #1380, design.md "Local accounts"): `local_accounts`, one row per email, its scrypt hash; and their passkeys.
import type { LocalAccount, LocalAccountPasskey, LocalAccountPasskeyRepository, LocalAccountRepository } from '../domain/ports.ts';
import type { UiRole } from '../domain/types.ts';
import type { StoreContext } from './context.ts';

const row = (r: Record<string, unknown>): LocalAccount => ({
  email: String(r.email), passwordHash: String(r.password_hash), role: String(r.role) as UiRole, createdAt: String(r.created_at),
});

export function createLocalAccountRepository(c: StoreContext): LocalAccountRepository {
  return {
    list: () => c.db.all('SELECT * FROM local_accounts ORDER BY email').map(row),
    get(email) {
      const r = c.db.get('SELECT * FROM local_accounts WHERE email = ?', email.toLowerCase());
      return r ? row(r) : undefined;
    },
    put(a) {
      c.db.run(`INSERT INTO local_accounts (email, password_hash, role, created_at) VALUES (?, ?, ?, ?)
        ON CONFLICT (email) DO UPDATE SET password_hash = excluded.password_hash, role = excluded.role`, a.email.toLowerCase(), a.passwordHash, a.role, a.createdAt);
    },
    remove: (email) => c.db.get('DELETE FROM local_accounts WHERE email = ? RETURNING email', email.toLowerCase()) !== undefined,
  };
}

// The local accounts' passkeys (issue #1380, design.md "Passkeys for local accounts"): `local_account_passkeys`, one row
// per credential; the foreign key removes an account's passkeys with it.
const passkeyRow = (r: Record<string, unknown>): LocalAccountPasskey => ({
  id: String(r.id), email: String(r.email), rpId: String(r.rp_id), publicKey: String(r.public_key), counter: Number(r.counter),
  transports: JSON.parse(String(r.transports)) as string[], name: String(r.name), createdAt: String(r.created_at),
  ...(r.last_used_at ? { lastUsedAt: String(r.last_used_at) } : {}),
});

export function createLocalAccountPasskeyRepository(c: StoreContext): LocalAccountPasskeyRepository {
  return {
    list: (email) => c.db.all('SELECT * FROM local_account_passkeys WHERE email = ? ORDER BY created_at, id', email.toLowerCase()).map(passkeyRow),
    get(id) {
      const r = c.db.get('SELECT * FROM local_account_passkeys WHERE id = ?', id);
      return r ? passkeyRow(r) : undefined;
    },
    put(p) {
      c.db.run(`INSERT INTO local_account_passkeys (id, email, rp_id, public_key, counter, transports, name, created_at, last_used_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET counter = excluded.counter, last_used_at = excluded.last_used_at, name = excluded.name`,
      p.id, p.email.toLowerCase(), p.rpId, p.publicKey, p.counter, JSON.stringify(p.transports), p.name, p.createdAt, p.lastUsedAt ?? null);
    },
    remove: (email, id) => c.db.get('DELETE FROM local_account_passkeys WHERE email = ? AND id = ? RETURNING id', email.toLowerCase(), id) !== undefined,
    any: () => c.db.get('SELECT 1 AS one FROM local_account_passkeys LIMIT 1') !== undefined,
  };
}
