// The sweep leases (issue #1627, design.md "Sweep leases: one host per sweep"): one row per sweep name, in the instance
// schema. The take is one statement, so two hosts that ask at once get one holder.
import type { SweepLeaseRepository } from '../domain/leases.ts';
import type { StoreContext } from './context.ts';

export const SWEEP_LEASE_TABLE = 'CREATE TABLE IF NOT EXISTS sweep_leases (name TEXT PRIMARY KEY, owner TEXT NOT NULL, until TEXT NOT NULL);';

export function createSweepLeaseRepository(c: StoreContext): SweepLeaseRepository {
  return {
    hold: (name, owner, until, now) => c.db.get(`INSERT INTO sweep_leases (name, owner, until) VALUES (?, ?, ?)
      ON CONFLICT (name) DO UPDATE SET owner = excluded.owner, until = excluded.until
      WHERE sweep_leases.owner = excluded.owner OR sweep_leases.until < ? RETURNING owner`, name, owner, until, now) !== undefined,
    renew: (owner, until) => c.db.run('UPDATE sweep_leases SET until = ? WHERE owner = ?', until, owner).changes,
    release(owner) { c.db.run('DELETE FROM sweep_leases WHERE owner = ?', owner); },
    live: (name, now) => c.db.get('SELECT 1 AS x FROM sweep_leases WHERE name = ? AND until >= ?', name, now) !== undefined,
  };
}
