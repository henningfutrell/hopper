// Pointed jobs (issue #425, tenant migration 42): one row each, the body as JSON, with the columns read by — its status and
// when it was made.
import type { PointedJob, PointedJobRepository } from '../domain/pointed-jobs.ts';
import { parse, type StoreContext } from './context.ts';

export const POINTED_JOB_TABLE = `
  CREATE TABLE pointed_jobs (
    seq BIGSERIAL PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    body TEXT NOT NULL
  );
  CREATE INDEX pointed_jobs_status ON pointed_jobs (status, created_at)`;

export function createPointedJobRepository(c: StoreContext): PointedJobRepository {
  return {
    add(input) {
      const p: PointedJob = { id: c.idGen(), ...input };
      c.db.run('INSERT INTO pointed_jobs (id, status, created_at, body) VALUES (?, ?, ?, ?)', p.id, p.status, p.createdAt, JSON.stringify(p));
      return p;
    },
    get(id) {
      const r = c.db.get('SELECT body FROM pointed_jobs WHERE id = ?', id);
      return r ? parse<PointedJob>(r.body) : undefined;
    },
    list: () => c.db.all('SELECT body FROM pointed_jobs ORDER BY created_at DESC, seq DESC').map((r) => parse<PointedJob>(r.body)),
    put(p) {
      c.db.run('UPDATE pointed_jobs SET status = ?, body = ? WHERE id = ?', p.status, JSON.stringify(p), p.id);
      return p;
    },
  };
}
