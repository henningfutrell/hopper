// The resource ledger (issue #2504, tenant migration 92): each thing the hopper made for a job on a machine, and where it
// stands — live, reaped, kept or failed with why. One row per job, kind and locator; a closed row stays as the record.
// Tenant migration 95 adds `retained_until` (part 5): until when the reap at the job's end kept it for a retention.
// Tenant migration 98 adds `attempts` and `next_attempt_at` (part 14): the maids' attempts on it, and when they try it again.
import type { LedgerEntry, LedgerKind, LedgerState, ResourceLedgerRepository } from '../domain/resource-ledger.ts';
import type { StoreContext } from './context.ts';
import type { Row } from './db.ts';

export const RESOURCE_LEDGER_TABLE = `
  CREATE TABLE IF NOT EXISTS job_resource_ledger (
    job_id TEXT NOT NULL, kind TEXT NOT NULL, locator TEXT NOT NULL, machine_id TEXT NOT NULL, created_at TEXT NOT NULL,
    state TEXT NOT NULL, reason TEXT, ended_at TEXT,
    PRIMARY KEY (job_id, kind, locator)
  )`;

const entry = (r: Row): LedgerEntry => ({
  jobId: String(r.job_id), machineId: String(r.machine_id), kind: String(r.kind) as LedgerKind, locator: String(r.locator),
  createdAt: String(r.created_at), state: String(r.state) as LedgerState,
  ...(r.reason !== null ? { reason: String(r.reason) } : {}), ...(r.ended_at !== null ? { endedAt: String(r.ended_at) } : {}),
  ...(r.retained_until != null ? { retainedUntil: String(r.retained_until) } : {}),
  ...(Number(r.attempts ?? 0) > 0 ? { attempts: Number(r.attempts) } : {}), ...(r.next_attempt_at != null ? { nextAttemptAt: String(r.next_attempt_at) } : {}),
});

export function createResourceLedgerRepository(c: StoreContext): ResourceLedgerRepository {
  return {
    record(e) {
      c.db.run(`INSERT INTO job_resource_ledger (job_id, kind, locator, machine_id, created_at, state, retained_until) VALUES (?, ?, ?, ?, ?, 'live', ?)
        ON CONFLICT (job_id, kind, locator) DO NOTHING`, e.jobId, e.kind, e.locator, e.machineId, e.createdAt, e.retainedUntil ?? null);
    },
    close(jobId, kind, locator, state, at, reason) {
      c.db.run(`UPDATE job_resource_ledger SET state = ?, reason = ?, ended_at = ? WHERE job_id = ? AND kind = ? AND locator = ? AND state <> 'reaped'`,
        state, reason ?? null, at, jobId, kind, locator);
    },
    tried(jobId, kind, locator, at, reason, next) {
      c.db.run(`UPDATE job_resource_ledger SET state = 'failed', reason = ?, ended_at = COALESCE(ended_at, ?), attempts = attempts + 1, next_attempt_at = ?
        WHERE job_id = ? AND kind = ? AND locator = ? AND state IN ('live', 'failed')`, reason, at, next, jobId, kind, locator);
    },
    retain(jobId, kind, locator, until) {
      c.db.run(`UPDATE job_resource_ledger SET retained_until = ? WHERE job_id = ? AND kind = ? AND locator = ? AND state IN ('live', 'failed')`,
        until, jobId, kind, locator);
    },
    forJob(jobId) {
      return c.db.all('SELECT * FROM job_resource_ledger WHERE job_id = ? ORDER BY created_at, kind, locator', jobId).map(entry);
    },
    onMachine(machineId) {
      return c.db.all('SELECT * FROM job_resource_ledger WHERE machine_id = ? ORDER BY job_id, created_at, kind, locator', machineId).map(entry);
    },
    open() {
      return c.db.all(`SELECT * FROM job_resource_ledger WHERE state IN ('live', 'failed') ORDER BY job_id, created_at, kind, locator`).map(entry);
    },
  };
}
