// A user's connected accounts (issue #214): one row per provider in their user schema. A renewal swaps the
// pair only while the refresh token it used is still the stored one, the row locked (issue #441), under an
// advisory lock per account that only one connection — one process — holds at a time.
import type { ConnectedAccount, ConnectedAccountRepository } from '../domain/ports.ts';
import { parse, type StoreContext } from './context.ts';

const LOCK_KEY = "hashtext('hopper connected account ' || current_schema() || ' ' || ?)";

export function createConnectedAccountRepository(c: StoreContext): ConnectedAccountRepository {
  const put = (account: ConnectedAccount): void => {
    c.db.run(`INSERT INTO connected_accounts (provider, body) VALUES (?, ?)
      ON CONFLICT (provider) DO UPDATE SET body = excluded.body`, account.provider, JSON.stringify(account));
  };
  return {
    get(provider) {
      const r = c.db.get('SELECT body FROM connected_accounts WHERE provider = ?', provider);
      return r ? parse<ConnectedAccount>(r.body) : undefined;
    },
    put,
    swap(provider, refreshToken, next) {
      return c.tx(() => {
        const r = c.db.get('SELECT body FROM connected_accounts WHERE provider = ? FOR UPDATE', provider);
        if (!r || parse<ConnectedAccount>(r.body).refreshToken !== refreshToken) return false;
        put(next);
        return true;
      });
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
