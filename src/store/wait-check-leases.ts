// The wait checks' leases (issue #1694, tenant migration 76, design.md "Wait checks"): the hopper that tests a job's wait
// check holds its row until `until`; another takes it only once that passed, or for a newer wait. The check itself is kept
// with the wait, in the job. A claim is one statement, so two hoppers never both hold one. Its times are on the database's
// clock (issue #1954): a hopper whose clock is off neither takes a lease another holds nor holds one past its end.
import type { WaitCheckLeases } from '../domain/wait-checks.ts';
import type { StoreContext } from './context.ts';
import { DB_NOW, DB_NOW_PLUS_MS } from './db-clock.ts';

export const WAIT_CHECK_LEASE_TABLE = 'CREATE TABLE IF NOT EXISTS wait_check_leases (job_id TEXT PRIMARY KEY, since TEXT NOT NULL, owner TEXT NOT NULL, until TEXT NOT NULL)';

export function createWaitCheckLeases(c: StoreContext): WaitCheckLeases {
  return {
    claim: (jobId, since, owner, ms) => c.db.get(`INSERT INTO wait_check_leases (job_id, since, owner, until) VALUES (?, ?, ?, ${DB_NOW_PLUS_MS})
      ON CONFLICT (job_id) DO UPDATE SET since = excluded.since, owner = excluded.owner, until = excluded.until
      WHERE wait_check_leases.until < ${DB_NOW} OR wait_check_leases.owner = excluded.owner OR wait_check_leases.since <> excluded.since
      RETURNING job_id`, jobId, since, owner, ms) !== undefined,
    holds: (jobId, owner) => c.db.get(`SELECT 1 AS held FROM wait_check_leases WHERE job_id = ? AND owner = ? AND until >= ${DB_NOW}`, jobId, owner) !== undefined,
    release: (jobId, owner) => { c.db.run('DELETE FROM wait_check_leases WHERE job_id = ? AND owner = ?', jobId, owner); },
  };
}
