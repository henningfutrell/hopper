// One review section's items (issues #537, #543): a table per kind, each item's versions and review trail in its body.
// The same repository for every kind; an item stored before it had a `kind` reads as its table's.
import type { ReviewItemRepository } from '../domain/ports.ts';
import type { ReviewItem, ReviewKind } from '../domain/types.ts';
import { applyPatch, parse, type StoreContext } from './context.ts';

/** Each kind's table (tenant migrations 24 and 25). */
export const REVIEW_TABLES: Readonly<Record<ReviewKind, string>> = { proposal: 'proposals', research: 'research_reports' };

export function createReviewItemRepository(c: StoreContext, kind: ReviewKind): ReviewItemRepository {
  const table = REVIEW_TABLES[kind];
  const read = (body: unknown): ReviewItem => ({ ...parse<ReviewItem>(body), kind });
  const get = (id: string): ReviewItem | undefined => {
    const r = c.db.get(`SELECT body FROM ${table} WHERE id = ?`, id);
    return r ? read(r.body) : undefined;
  };
  const need = (id: string): ReviewItem => {
    const p = get(id);
    if (!p) throw new Error(`${kind} not found: ${id}`);
    return p;
  };
  const save = (p: ReviewItem): ReviewItem => {
    const next: ReviewItem = { ...p, updatedAt: c.clock.now().toISOString() };
    c.db.run(`UPDATE ${table} SET status = ?, body = ? WHERE id = ?`, next.status, JSON.stringify(next), p.id);
    return next;
  };
  return {
    create(input) {
      const at = c.clock.now().toISOString();
      const p: ReviewItem = {
        id: c.idGen(), kind, jobId: input.jobId, status: 'open', stage: input.stage, versions: [input.version], reviews: [], levelRevisions: 0,
        ...(input.raisedBy ? { raisedBy: input.raisedBy } : {}), ...(input.source ? { source: input.source } : {}),
        ...(input.forkOf ? { forkOf: input.forkOf } : {}), ...(input.switchedFrom ? { switchedFrom: input.switchedFrom } : {}), createdAt: at, updatedAt: at,
      };
      c.db.run(`INSERT INTO ${table} (id, job_id, status, created_at, body) VALUES (?, ?, ?, ?, ?)`, p.id, p.jobId, p.status, at, JSON.stringify(p));
      return p;
    },
    get,
    list(filter) {
      const conds: string[] = [];
      const args: (string | number)[] = [];
      if (filter?.status?.length) {
        conds.push(`status IN (${filter.status.map(() => '?').join(',')})`);
        args.push(...filter.status);
      }
      if (filter?.jobId !== undefined) { conds.push('job_id = ?'); args.push(filter.jobId); }
      const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
      const limit = filter?.limit !== undefined ? 'LIMIT ?' : '';
      if (filter?.limit !== undefined) args.push(filter.limit);
      const dir = filter?.order === 'oldest-first' ? 'ASC' : 'DESC';
      return c.db.all(`SELECT body FROM ${table} ${where} ORDER BY created_at ${dir}, seq ${dir} ${limit}`, ...args).map((r) => read(r.body));
    },
    update: (id, patch) => save(applyPatch<ReviewItem>(need(id), patch)),
    addReview(id, review) {
      const p = need(id);
      return save({ ...p, reviews: [...p.reviews, review] });
    },
    addVersion(id, version) {
      const p = need(id);
      return save({ ...p, versions: [...p.versions, version] });
    },
  };
}
