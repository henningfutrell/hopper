// A user's connected accounts (issue #214): one row per account in their user schema, by its key (issue #1448: the first
// account's is its provider, `github`; a further one's `github-2`, …) — who and when; its tokens are
// system secrets in the user's vault since issue #658 (src/connected-accounts/at-rest.ts). A renewal locks the row in its
// transaction (issue #441), under an advisory lock per account that only one connection — one process — holds at a time.
import type { ConnectedAccountRepository, StoredAccount } from '../domain/ports.ts';
import { isConnectedAccountKey, type ConnectedAccountKey } from '../domain/types.ts';
import { parse, type StoreContext } from './context.ts';

const LOCK_KEY = "hashtext('hopper connected account ' || current_schema() || ' ' || ?)";

type Body = StoredAccount & { accessToken?: string; refreshToken?: string };

export function createConnectedAccountRepository(c: StoreContext): ConnectedAccountRepository {
  const body = (provider: string): Body | undefined => {
    const r = c.db.get('SELECT body FROM connected_accounts WHERE provider = ?', provider);
    return r ? parse<Body>(r.body) : undefined;
  };
  const write = (b: Body, key: ConnectedAccountKey): void => {
    c.db.run(`INSERT INTO connected_accounts (provider, body) VALUES (?, ?)
      ON CONFLICT (provider) DO UPDATE SET body = excluded.body`, key, JSON.stringify(b));
  };
  return {
    get(provider) {
      const b = body(provider);
      if (!b) return undefined;
      const { accessToken: _a, refreshToken: _r, ...row } = b;
      return row;
    },
    put(account, key = account.provider) {
      // Tokens are never kept here: a row from before issue #658 loses its old ones once the new ones are in the vault.
      const { accessToken: _a, refreshToken: _r, ...row } = account as Body;
      write(row, key);
    },
    keys: () => c.db.all('SELECT provider FROM connected_accounts ORDER BY provider').map((r) => String(r.provider)).filter(isConnectedAccountKey),
    lockRow: (provider) => c.db.get('SELECT provider FROM connected_accounts WHERE provider = ? FOR UPDATE', provider) !== undefined,
    legacyTokens(provider) {
      const b = body(provider);
      return b?.accessToken !== undefined ? { accessToken: b.accessToken, ...(b.refreshToken !== undefined ? { refreshToken: b.refreshToken } : {}) } : undefined;
    },
    dropLegacyTokens(provider) {
      const b = body(provider);
      if (!b) return;
      const { accessToken: _a, refreshToken: _r, ...row } = b;
      write(row, provider);
    },
    lock: (provider) => c.db.get(`SELECT pg_try_advisory_lock(${LOCK_KEY}) AS held`, provider)!.held === true,
    unlock(provider) {
      c.db.get(`SELECT pg_advisory_unlock(${LOCK_KEY}) AS released`, provider);
    },
    delete(provider) {
      return c.db.run('DELETE FROM connected_accounts WHERE provider = ?', provider).changes > 0;
    },
  };
}
