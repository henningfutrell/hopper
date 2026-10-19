// The job leases (issue #1662, a tenant migration, design.md "Several hoppers on one database"): one row per job that a
// hopper drives, its owner and until when. Times are ISO strings, so they compare as text, on the database's clock (issue
// #1954): a host whose clock is off neither takes a lease another host holds nor holds one past its end.
import type { JobLeaseRepository, RelayedAct } from '../domain/job-leases.ts';
import type { StoreContext } from './context.ts';
import { DB_NOW, DB_NOW_PLUS_MS } from './db-clock.ts';

export const JOB_LEASE_TABLE = `
  CREATE TABLE job_leases (
    job_id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    until TEXT NOT NULL
  );
  CREATE INDEX job_leases_owner ON job_leases (owner)`;

/** A person's cancel or park relayed to the hopper that holds the lease (`RelayedAct`, JSON), until it takes it. */
export const JOB_LEASE_RELAYED_COLUMN = 'ALTER TABLE job_leases ADD COLUMN relayed TEXT';

export function createJobLeaseRepository(c: StoreContext): JobLeaseRepository {
  return {
    take: (jobId, lease, force = false) => c.db.run(
      `INSERT INTO job_leases (job_id, owner, until) VALUES (?, ?, ${DB_NOW_PLUS_MS})
       ON CONFLICT (job_id) DO UPDATE SET owner = excluded.owner, until = excluded.until,
         relayed = CASE WHEN ? THEN NULL ELSE job_leases.relayed END
       WHERE ? OR job_leases.owner = excluded.owner OR job_leases.until <= ${DB_NOW}`,
      jobId, lease.owner, lease.ms, force ? 1 : 0, force ? 1 : 0).changes > 0,
    renew: (owner, ms) => c.db.all(`UPDATE job_leases SET until = ${DB_NOW_PLUS_MS} WHERE owner = ? RETURNING job_id`, ms, owner).map((r) => String(r.job_id)),
    release(owner, jobIds) {
      if (!jobIds) { c.db.run('DELETE FROM job_leases WHERE owner = ?', owner); return; }
      for (const id of jobIds) c.db.run('DELETE FROM job_leases WHERE owner = ? AND job_id = ?', owner, id);
    },
    unheld: () => c.db.all(
      `SELECT j.id FROM jobs j LEFT JOIN job_leases l ON l.job_id = j.id
       WHERE j.status IN ('claimed', 'running') AND (l.job_id IS NULL OR l.until <= ${DB_NOW}) ORDER BY j.seq`).map((r) => String(r.id)),
    heldByOthers: (owner) => new Set(c.db.all(`SELECT job_id FROM job_leases WHERE owner <> ? AND until > ${DB_NOW}`, owner).map((r) => String(r.job_id))),
    relay: (jobId, act, owner) => c.db.run(`UPDATE job_leases SET relayed = ? WHERE job_id = ? AND owner <> ? AND until > ${DB_NOW}`,
      JSON.stringify(act), jobId, owner).changes > 0,
    relayed: (owner) => c.db.all(
      `UPDATE job_leases l SET relayed = NULL FROM (SELECT job_id, relayed FROM job_leases WHERE owner = ? AND relayed IS NOT NULL FOR UPDATE) a
       WHERE l.job_id = a.job_id RETURNING a.job_id, a.relayed`, owner)
      .map((r) => ({ jobId: String(r.job_id), act: JSON.parse(String(r.relayed)) as RelayedAct })),
    lockClaims: () => { c.db.get("SELECT pg_advisory_xact_lock(hashtext('hopper claims ' || current_schema())) AS held"); },
  };
}
