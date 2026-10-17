// The outbound dedupe keys (issue #1627, design.md "Outbound sends"): one row per key, in the instance schema, until its
// dedupe window ends. The claim is one statement, so two hosts that ask the same key at once get one new.
import type { OutboundKeyRepository } from '../domain/outbound.ts';
import type { StoreContext } from './context.ts';

export const OUTBOUND_KEY_TABLE = 'CREATE TABLE IF NOT EXISTS outbound_keys (key TEXT PRIMARY KEY, until TEXT NOT NULL); CREATE INDEX IF NOT EXISTS outbound_keys_until ON outbound_keys (until);';

export function createOutboundKeyRepository(c: StoreContext): OutboundKeyRepository {
  return {
    claim: (key, until, now) => c.db.get(`INSERT INTO outbound_keys (key, until) VALUES (?, ?)
      ON CONFLICT (key) DO UPDATE SET until = excluded.until WHERE outbound_keys.until <= ? RETURNING key`, key, until, now) !== undefined,
    prune: (now) => c.db.run('DELETE FROM outbound_keys WHERE until <= ?', now).changes,
  };
}
