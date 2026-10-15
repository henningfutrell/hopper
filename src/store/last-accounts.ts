// The last accounts (issue #1269, tenant migration 65): who each machine's agent tool was last read signed in as, one row per
// machine and service, the label only (identity, organization, when), as JSON in the body. Never a token.
import type { LastAccount, LastAccountRepository } from '../domain/types.ts';
import { parse, type StoreContext } from './context.ts';

export const LAST_ACCOUNT_TABLE = 'CREATE TABLE last_accounts (machine_id TEXT NOT NULL, service TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (machine_id, service))';

export function createLastAccountRepository(c: StoreContext): LastAccountRepository {
  return {
    get(machineId, service) {
      const r = c.db.get('SELECT body FROM last_accounts WHERE machine_id = ? AND service = ?', machineId, service);
      return r ? parse<LastAccount>(r.body) : undefined;
    },
    put(a) {
      const body: LastAccount = { machineId: a.machineId, service: a.service, identity: a.identity, ...(a.organization ? { organization: a.organization } : {}), capturedAt: a.capturedAt };
      c.db.run('INSERT INTO last_accounts (machine_id, service, body) VALUES (?, ?, ?) ON CONFLICT (machine_id, service) DO UPDATE SET body = excluded.body', a.machineId, a.service, JSON.stringify(body));
    },
  };
}
