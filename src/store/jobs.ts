import type { JobFilter, JobRepository } from '../domain/ports.ts';
import type { Job } from '../domain/types.ts';
import { applyPatch, parse, type StoreContext } from './context.ts';

export function createJobRepository(c: StoreContext): JobRepository {
  const get = (id: string): Job | undefined => {
    const r = c.db.prepare('SELECT body FROM jobs WHERE id = ?').get(id);
    return r ? parse<Job>(r.body) : undefined;
  };
  return {
    create(spec, priority, source) {
      const at = c.clock.now().toISOString();
      const job: Job = { id: c.idGen(), spec, priority, status: 'queued', approved: false, createdAt: at, updatedAt: at, attempts: 0 };
      if (source) job.source = source;
      c.db.prepare('INSERT INTO jobs (id, status, created_at, source_key, body) VALUES (?, ?, ?, ?, ?)')
        .run(job.id, job.status, at, source?.key ?? null, JSON.stringify(job));
      return job;
    },
    get,
    getBySourceKey(key) {
      const r = c.db.prepare('SELECT body FROM jobs WHERE source_key = ? ORDER BY created_at DESC, seq DESC LIMIT 1').get(key);
      return r ? parse<Job>(r.body) : undefined;
    },
    list(filter?: JobFilter) {
      const where = filter?.status?.length ? `WHERE status IN (${filter.status.map(() => '?').join(',')})` : '';
      const limit = filter?.limit !== undefined ? 'LIMIT ?' : '';
      const args = [...(filter?.status ?? []), ...(filter?.limit !== undefined ? [filter.limit] : [])];
      return c.db.prepare(`SELECT body FROM jobs ${where} ORDER BY created_at DESC, seq DESC ${limit}`)
        .all(...args).map((r) => parse<Job>(r.body));
    },
    update(id, patch) {
      const cur = get(id);
      if (!cur) throw new Error(`job not found: ${id}`);
      const next: Job = { ...applyPatch<Job>(cur, patch), updatedAt: c.clock.now().toISOString() };
      c.db.prepare('UPDATE jobs SET status = ?, body = ? WHERE id = ?').run(next.status, JSON.stringify(next), id);
      return next;
    },
  };
}
