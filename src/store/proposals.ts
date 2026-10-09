import type { ProposalRepository } from '../domain/ports.ts';
import type { Proposal } from '../domain/types.ts';
import { applyPatch, parse, type StoreContext } from './context.ts';

export function createProposalRepository(c: StoreContext): ProposalRepository {
  const get = (id: string): Proposal | undefined => {
    const r = c.db.get('SELECT body FROM proposals WHERE id = ?', id);
    return r ? parse<Proposal>(r.body) : undefined;
  };
  const need = (id: string): Proposal => {
    const p = get(id);
    if (!p) throw new Error(`proposal not found: ${id}`);
    return p;
  };
  const save = (p: Proposal): Proposal => {
    const next: Proposal = { ...p, updatedAt: c.clock.now().toISOString() };
    c.db.run('UPDATE proposals SET status = ?, body = ? WHERE id = ?', next.status, JSON.stringify(next), p.id);
    return next;
  };
  return {
    create(input) {
      const at = c.clock.now().toISOString();
      const p: Proposal = {
        id: c.idGen(), jobId: input.jobId, status: 'open', stage: input.stage, versions: [input.version], reviews: [], levelRevisions: 0,
        ...(input.raisedBy ? { raisedBy: input.raisedBy } : {}), ...(input.source ? { source: input.source } : {}), createdAt: at, updatedAt: at,
      };
      c.db.run('INSERT INTO proposals (id, job_id, status, created_at, body) VALUES (?, ?, ?, ?, ?)', p.id, p.jobId, p.status, at, JSON.stringify(p));
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
      return c.db.all(`SELECT body FROM proposals ${where} ORDER BY created_at ${dir}, seq ${dir} ${limit}`, ...args).map((r) => parse<Proposal>(r.body));
    },
    update: (id, patch) => save(applyPatch<Proposal>(need(id), patch)),
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
