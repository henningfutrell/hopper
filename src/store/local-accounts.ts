// The local accounts (issue #1380, design.md "Local accounts"): `local_accounts`, one row per email, its scrypt hash.
import type { LocalAccount, LocalAccountRepository } from '../domain/ports.ts';
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
