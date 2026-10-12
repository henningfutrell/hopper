// Direct jobs (issue #901, tenant migration 49): one row each, the body as JSON — the submission, its brief included,
// kept in the user's schema and nowhere else.
import type { DirectJob, DirectJobRepository } from '../domain/direct-jobs.ts';
import { parse, type StoreContext } from './context.ts';

export const DIRECT_JOB_TABLE = `
  CREATE TABLE direct_jobs (
    seq BIGSERIAL PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    submitted_at TEXT NOT NULL,
    body TEXT NOT NULL
  )`;

export function createDirectJobRepository(c: StoreContext): DirectJobRepository {
  return {
    add(input) {
      const d: DirectJob = { id: c.idGen(), ...input };
      c.db.run('INSERT INTO direct_jobs (id, submitted_at, body) VALUES (?, ?, ?)', d.id, d.submittedAt, JSON.stringify(d));
      return d;
    },
    get(id) {
      const r = c.db.get('SELECT body FROM direct_jobs WHERE id = ?', id);
      return r ? parse<DirectJob>(r.body) : undefined;
    },
    list: () => c.db.all('SELECT body FROM direct_jobs ORDER BY submitted_at DESC, seq DESC').map((r) => parse<DirectJob>(r.body)),
  };
}
