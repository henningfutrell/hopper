// The sweep leases (issue #1627, design.md "Sweep leases: one host per sweep"): one row per sweep name, in the instance
// schema. The take is one statement, so two hosts that ask at once get one holder. Timed on the database's clock (issue
// #1954): a host whose clock is off takes no lease another host holds.
import type { SweepLeaseRepository } from '../domain/leases.ts';
import type { StoreContext } from './context.ts';
import { DB_NOW, DB_NOW_PLUS_MS } from './db-clock.ts';

export const SWEEP_LEASE_TABLE = 'CREATE TABLE IF NOT EXISTS sweep_leases (name TEXT PRIMARY KEY, owner TEXT NOT NULL, until TEXT NOT NULL);';

export function createSweepLeaseRepository(c: StoreContext): SweepLeaseRepository {
  return {
    hold: (name, owner, ms) => c.db.get(`INSERT INTO sweep_leases (name, owner, until) VALUES (?, ?, ${DB_NOW_PLUS_MS})
      ON CONFLICT (name) DO UPDATE SET owner = excluded.owner, until = excluded.until
      WHERE sweep_leases.owner = excluded.owner OR sweep_leases.until < ${DB_NOW} RETURNING owner`, name, owner, ms) !== undefined,
    renew: (owner, ms) => c.db.run(`UPDATE sweep_leases SET until = ${DB_NOW_PLUS_MS} WHERE owner = ?`, ms, owner).changes,
    release(owner) { c.db.run('DELETE FROM sweep_leases WHERE owner = ?', owner); },
    live: (name) => c.db.get(`SELECT 1 AS x FROM sweep_leases WHERE name = ? AND until >= ${DB_NOW}`, name) !== undefined,
  };
}
