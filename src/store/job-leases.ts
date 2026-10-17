// The job leases (issue #1662, a tenant migration, design.md "Several hoppers on one database"): one row per job that a
// hopper drives, its owner and until when. Times are ISO strings, so they compare as text.
import type { JobLeaseRepository } from '../domain/job-leases.ts';
import type { StoreContext } from './context.ts';

export const JOB_LEASE_TABLE = `
  CREATE TABLE job_leases (
    job_id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    until TEXT NOT NULL
  );
  CREATE INDEX job_leases_owner ON job_leases (owner)`;

export function createJobLeaseRepository(c: StoreContext): JobLeaseRepository {
  return {
    take: (jobId, lease, now, force = false) => c.db.run(
      `INSERT INTO job_leases (job_id, owner, until) VALUES (?, ?, ?)
       ON CONFLICT (job_id) DO UPDATE SET owner = excluded.owner, until = excluded.until
       WHERE ? OR job_leases.owner = excluded.owner OR job_leases.until <= ?`,
      jobId, lease.owner, lease.until, force ? 1 : 0, now).changes > 0,
    renew: (owner, until) => c.db.all('UPDATE job_leases SET until = ? WHERE owner = ? RETURNING job_id', until, owner).map((r) => String(r.job_id)),
    release(owner, jobIds) {
      if (!jobIds) { c.db.run('DELETE FROM job_leases WHERE owner = ?', owner); return; }
      for (const id of jobIds) c.db.run('DELETE FROM job_leases WHERE owner = ? AND job_id = ?', owner, id);
    },
    unheld: (now) => c.db.all(
      `SELECT j.id FROM jobs j LEFT JOIN job_leases l ON l.job_id = j.id
       WHERE j.status IN ('claimed', 'running') AND (l.job_id IS NULL OR l.until <= ?) ORDER BY j.seq`, now).map((r) => String(r.id)),
    heldByOthers: (owner, now) => new Set(c.db.all('SELECT job_id FROM job_leases WHERE owner <> ? AND until > ?', owner, now).map((r) => String(r.job_id))),
    lockClaims: () => { c.db.get("SELECT pg_advisory_xact_lock(hashtext('hopper claims ' || current_schema())) AS held"); },
  };
}
