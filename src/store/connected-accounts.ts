// A user's connected accounts (issue #214): one row per provider in their user schema.
import type { ConnectedAccount, ConnectedAccountRepository } from '../domain/ports.ts';
import { parse, type StoreContext } from './context.ts';

export function createConnectedAccountRepository(c: StoreContext): ConnectedAccountRepository {
  return {
    get(provider) {
      const r = c.db.get('SELECT body FROM connected_accounts WHERE provider = ?', provider);
      return r ? parse<ConnectedAccount>(r.body) : undefined;
    },
    put(account) {
      c.db.run(`INSERT INTO connected_accounts (provider, body) VALUES (?, ?)
        ON CONFLICT (provider) DO UPDATE SET body = excluded.body`, account.provider, JSON.stringify(account));
    },
    delete(provider) {
      return c.db.run('DELETE FROM connected_accounts WHERE provider = ?', provider).changes > 0;
    },
  };
}
