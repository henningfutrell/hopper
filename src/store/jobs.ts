import type { JobFilter, JobRepository } from '../domain/ports.ts';
import type { Job } from '../domain/types.ts';
import { waitEntryProblem } from '../domain/wait-on.ts';
import type { Row } from './db.ts';
import { applyPatch, parse, type StoreContext } from './context.ts';

/** The most ids one statement names when it reads the bodies of the jobs that changed. */
const BODIES_PER_READ = 500;

/**
 * Jobs are read by row version (issue #1154). A list reads each row's id and version only, and the body only of a row
 * this store has not read at that version. The version is Postgres's `xmin`: every write of the row changes it,
 * whoever writes (the build before, a migration, the operator CLI), and a rolled back write takes it back. So a body
 * kept here is never older than its row. Before, every list sent and parsed the body of every job it named, about
 * once a second, and the call blocks the event loop.
 */
export function createJobRepository(c: StoreContext): JobRepository {
  const kept = new Map<string, { v: string; job: Job }>();
  const keep = (r: Row): Job => {
    const job = parse<Job>(r.body);
    kept.set(String(r.id), { v: String(r.v), job });
    return job;
  };
  const one = (r: Row | undefined, id?: string): Job | undefined => {
    if (r) return keep(r);
    if (id !== undefined) kept.delete(id);
    return undefined;
  };
  const get = (id: string): Job | undefined => one(c.db.get('SELECT id, xmin::text AS v, body FROM jobs WHERE id = ?', id), id);
  /** The jobs of `rows` (id and version, in order): the kept ones as kept, the others read now. */
  const bodies = (rows: Row[]): Job[] => {
    const stale = rows.map((r) => String(r.id)).filter((id, i) => kept.get(id)?.v !== String(rows[i]!.v));
    for (const id of stale) kept.delete(id);
    for (let i = 0; i < stale.length; i += BODIES_PER_READ) {
      const ids = stale.slice(i, i + BODIES_PER_READ);
      for (const r of c.db.all(`SELECT id, xmin::text AS v, body FROM jobs WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids)) keep(r);
    }
    // A job deleted between the two reads is left out.
    return rows.flatMap((r) => kept.get(String(r.id))?.job ?? []);
  };
  const write = (id: string, change: (cur: Job) => Job): Job => {
    const cur = get(id);
    if (!cur) throw new Error(`job not found: ${id}`);
    const next: Job = { ...change(cur), updatedAt: c.clock.now().toISOString() };
    // A job enters waiting_on only with what it waits on (issue #1245).
    const problem = waitEntryProblem(cur, next);
    if (problem) throw new Error(problem);
    const r = c.db.get('UPDATE jobs SET status = ?, body = ? WHERE id = ? RETURNING xmin::text AS v', next.status, JSON.stringify(next), id);
    if (r) kept.set(id, { v: String(r.v), job: next });
    return next;
  };
  return {
    create(spec, priority, source) {
      const at = c.clock.now().toISOString();
      const job: Job = { id: c.idGen(), spec, priority, status: 'queued', approved: false, createdAt: at, updatedAt: at, attempts: 0 };
      if (source) job.source = source;
      const r = c.db.get('INSERT INTO jobs (id, status, created_at, source_key, body) VALUES (?, ?, ?, ?, ?) RETURNING xmin::text AS v',
        job.id, job.status, at, source?.key ?? null, JSON.stringify(job));
      if (r) kept.set(job.id, { v: String(r.v), job });
      return job;
    },
    get,
    getBySourceKey(key) {
      return one(c.db.get('SELECT id, xmin::text AS v, body FROM jobs WHERE source_key = ? ORDER BY created_at DESC, seq DESC LIMIT 1', key));
    },
    list(filter?: JobFilter) {
      const conds = [
        ...(filter?.status?.length ? [`status IN (${filter.status.map(() => '?').join(',')})`] : []),
        ...(filter?.unassessed ? ["body::jsonb->'assessment' IS NULL"] : []),
        ...(filter?.undismissed ? ["body::jsonb->'dismissedAt' IS NULL"] : []),
        ...(filter?.followed ? ["body::jsonb->'sourceState'->'source'->>'follow' IN ('open', 'closed', 'tended')"] : []),
        ...(filter?.namesPullRequest ? ["body::jsonb->'sourceState'->'source'->>'pullRequest' IS NOT NULL",
          "COALESCE(body::jsonb->'sourceState'->'source'->>'follow', '') NOT IN ('merged', 'abandoned')"] : []),
      ];
      const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
      const limit = filter?.limit !== undefined ? 'LIMIT ?' : '';
      const args = [...(filter?.status ?? []), ...(filter?.limit !== undefined ? [filter.limit] : [])];
      const rows = c.db.all(`SELECT id, xmin::text AS v FROM jobs ${where} ORDER BY created_at DESC, seq DESC ${limit}`, ...args);
      // A list of every job forgets the jobs deleted since.
      if (!conds.length && filter?.limit === undefined) {
        const ids = new Set(rows.map((r) => String(r.id)));
        for (const id of kept.keys()) if (!ids.has(id)) kept.delete(id);
      }
      return bodies(rows);
    },
    update(id, patch) {
      return write(id, (cur) => applyPatch<Job>(cur, patch));
    },
    respecify(id, spec) {
      return write(id, (cur) => ({ ...cur, spec }));
    },
  };
}
