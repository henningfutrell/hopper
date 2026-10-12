// Job checkpoints (issue #921, tenant migration 48): each job's latest, its patch and agent session gzip-compressed and
// scrubbed, as base64 text. One row per job: a new checkpoint replaces the one before.
import type { CheckpointRepository } from '../domain/checkpoints.ts';
import type { StoreContext } from './context.ts';

export const CHECKPOINT_TABLE = `
  CREATE TABLE job_checkpoints (
    job_id TEXT PRIMARY KEY,
    at TEXT NOT NULL,
    patch TEXT NOT NULL,
    session TEXT
  )`;

export function createCheckpointRepository(c: StoreContext): CheckpointRepository {
  return {
    put(k) {
      c.db.run(`INSERT INTO job_checkpoints (job_id, at, patch, session) VALUES (?, ?, ?, ?)
        ON CONFLICT (job_id) DO UPDATE SET at = excluded.at, patch = excluded.patch, session = excluded.session`,
      k.jobId, k.at, k.patch.toString('base64'), k.session ? k.session.toString('base64') : null);
    },
    get(jobId) {
      const r = c.db.get('SELECT * FROM job_checkpoints WHERE job_id = ?', jobId);
      if (!r) return undefined;
      return { jobId, at: r.at as string, patch: Buffer.from(r.patch as string, 'base64'), ...(r.session !== null ? { session: Buffer.from(r.session as string, 'base64') } : {}) };
    },
    remove(jobId) { c.db.run('DELETE FROM job_checkpoints WHERE job_id = ?', jobId); },
    jobIds: () => c.db.all('SELECT job_id FROM job_checkpoints ORDER BY job_id').map((r) => r.job_id as string),
  };
}
