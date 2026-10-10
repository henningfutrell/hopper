import type { JobFilter, JobRepository } from '../domain/ports.ts';
import type { Job } from '../domain/types.ts';
import { applyPatch, parse, type StoreContext } from './context.ts';

export function createJobRepository(c: StoreContext): JobRepository {
  const get = (id: string): Job | undefined => {
    const r = c.db.get('SELECT body FROM jobs WHERE id = ?', id);
    return r ? parse<Job>(r.body) : undefined;
  };
  const write = (id: string, change: (cur: Job) => Job): Job => {
    const cur = get(id);
    if (!cur) throw new Error(`job not found: ${id}`);
    const next: Job = { ...change(cur), updatedAt: c.clock.now().toISOString() };
    c.db.run('UPDATE jobs SET status = ?, body = ? WHERE id = ?', next.status, JSON.stringify(next), id);
    return next;
  };
  return {
    create(spec, priority, source) {
      const at = c.clock.now().toISOString();
      const job: Job = { id: c.idGen(), spec, priority, status: 'queued', approved: false, createdAt: at, updatedAt: at, attempts: 0 };
      if (source) job.source = source;
      c.db.run('INSERT INTO jobs (id, status, created_at, source_key, body) VALUES (?, ?, ?, ?, ?)', job.id, job.status, at, source?.key ?? null, JSON.stringify(job));
      return job;
    },
    get,
    getBySourceKey(key) {
      const r = c.db.get('SELECT body FROM jobs WHERE source_key = ? ORDER BY created_at DESC, seq DESC LIMIT 1', key);
      return r ? parse<Job>(r.body) : undefined;
    },
    list(filter?: JobFilter) {
      const conds = [
        ...(filter?.status?.length ? [`status IN (${filter.status.map(() => '?').join(',')})`] : []),
        ...(filter?.unassessed ? ["body::jsonb->'assessment' IS NULL"] : []),
        ...(filter?.followed ? ["body::jsonb->'sourceState'->'source'->>'follow' IN ('open', 'closed')"] : []),
      ];
      const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
      const limit = filter?.limit !== undefined ? 'LIMIT ?' : '';
      const args = [...(filter?.status ?? []), ...(filter?.limit !== undefined ? [filter.limit] : [])];
      return c.db.all(`SELECT body FROM jobs ${where} ORDER BY created_at DESC, seq DESC ${limit}`, ...args).map((r) => parse<Job>(r.body));
    },
    update(id, patch) {
      return write(id, (cur) => applyPatch<Job>(cur, patch));
    },
    respecify(id, spec) {
      return write(id, (cur) => ({ ...cur, spec }));
    },
  };
}
