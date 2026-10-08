// The hand-offs (issue #516): one row each, the body as JSON, with the columns read by — its job, its status, when
// it opened and closed. The prune deletes closed ones only: an open hand-off waits on a person, whatever its age.
import type { HandoffRepository } from '../domain/ports.ts';
import type { Handoff } from '../domain/types.ts';
import { applyPatch, parse, type StoreContext } from './context.ts';

export function createHandoffRepository(c: StoreContext): HandoffRepository {
  const get = (id: string): Handoff | undefined => {
    const r = c.db.get('SELECT body FROM handoffs WHERE id = ?', id);
    return r ? parse<Handoff>(r.body) : undefined;
  };
  const many = (sql: string, ...args: (string | number)[]): Handoff[] => c.db.all(sql, ...args).map((r) => parse<Handoff>(r.body));
  return {
    create(input) {
      const h: Handoff = { id: c.idGen(), ...input };
      c.db.run('INSERT INTO handoffs (id, job_id, status, opened_at, closed_at, body) VALUES (?, ?, ?, ?, ?, ?)',
        h.id, h.jobId, h.status, h.openedAt, h.closedAt ?? null, JSON.stringify(h));
      return h;
    },
    get,
    forJob(jobId) {
      return many('SELECT body FROM handoffs WHERE job_id = ? ORDER BY seq DESC LIMIT 1', jobId)[0];
    },
    list(filter) {
      const limit = filter.limit ?? 500;
      if (filter.status === 'open') return many("SELECT body FROM handoffs WHERE status = 'open' ORDER BY opened_at, seq LIMIT ?", limit);
      return many("SELECT body FROM handoffs WHERE status = 'closed' AND closed_at >= ? ORDER BY closed_at DESC, seq DESC LIMIT ?", filter.closedSince ?? '', limit);
    },
    update(id, patch) {
      const h = get(id);
      if (!h) throw new Error(`hand-off not found: ${id}`);
      const next = applyPatch<Handoff>(h, patch);
      c.db.run('UPDATE handoffs SET status = ?, closed_at = ?, body = ? WHERE id = ?', next.status, next.closedAt ?? null, JSON.stringify(next), id);
      return next;
    },
    prune(before) {
      return c.db.run("DELETE FROM handoffs WHERE status = 'closed' AND closed_at < ?", before).changes;
    },
  };
}
