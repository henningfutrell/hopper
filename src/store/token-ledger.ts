// The token ledger (issue #2302, tenant migration 89): each model's token use in each agent session of each job, as last
// read from the session's log. Counts and metadata only. A session read again replaces its rows.
import type { TokenLedgerEntry, TokenLedgerRepository } from '../domain/token-usage.ts';
import type { StoreContext } from './context.ts';
import type { Row } from './db.ts';

export const TOKEN_LEDGER_TABLE = `
  CREATE TABLE IF NOT EXISTS job_token_use (
    job_id TEXT NOT NULL, session TEXT NOT NULL, model TEXT NOT NULL, read_at TEXT NOT NULL, machine_id TEXT, lane_id TEXT, account TEXT,
    first_at TEXT, last_at TEXT, turns BIGINT NOT NULL, input BIGINT NOT NULL, output BIGINT NOT NULL,
    cache_read BIGINT NOT NULL, cache_write BIGINT NOT NULL, cache_write_1h BIGINT NOT NULL,
    PRIMARY KEY (job_id, session, model)
  )`;

const entry = (r: Row): TokenLedgerEntry => ({
  jobId: String(r.job_id), session: String(r.session), model: String(r.model), readAt: String(r.read_at),
  ...(r.machine_id !== null ? { machineId: String(r.machine_id) } : {}), ...(r.lane_id !== null ? { laneId: String(r.lane_id) } : {}), ...(r.account !== null ? { account: String(r.account) } : {}),
  ...(r.first_at !== null ? { first: String(r.first_at) } : {}), ...(r.last_at !== null ? { last: String(r.last_at) } : {}),
  turns: Number(r.turns), input: Number(r.input), output: Number(r.output), cacheRead: Number(r.cache_read), cacheWrite: Number(r.cache_write),
  ...(Number(r.cache_write_1h) ? { cacheWrite1h: Number(r.cache_write_1h) } : {}),
});

export function createTokenLedgerRepository(c: StoreContext): TokenLedgerRepository {
  return {
    put(jobId, session, use, at) {
      c.tx(() => {
        c.db.run('DELETE FROM job_token_use WHERE job_id = ? AND session = ?', jobId, session);
        for (const m of use.models) {
          c.db.run(`INSERT INTO job_token_use (job_id, session, model, read_at, machine_id, lane_id, account, first_at, last_at, turns, input, output, cache_read, cache_write, cache_write_1h)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, jobId, session, m.model, at.readAt, at.machineId ?? null, at.laneId ?? null, at.account ?? null, use.first ?? null, use.last ?? null,
          m.turns, m.input, m.output, m.cacheRead, m.cacheWrite, m.cacheWrite1h ?? 0);
        }
      });
    },
    list(q = {}) {
      const rows = q.jobId !== undefined
        ? c.db.all('SELECT * FROM job_token_use WHERE job_id = ? ORDER BY first_at, session, model', q.jobId)
        : q.since !== undefined
          ? c.db.all('SELECT * FROM job_token_use WHERE COALESCE(last_at, read_at) >= ? ORDER BY first_at, job_id, session, model', q.since)
          : c.db.all('SELECT * FROM job_token_use ORDER BY first_at, job_id, session, model');
      return rows.map(entry);
    },
  };
}
