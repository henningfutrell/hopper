// The failure records and problems (issue #509): one row each, the body as JSON, with the columns the assessor
// queries by — a record's job, signature, time and pending run; a problem's signature and status.
import type { FailureRepository, ProblemRepository } from '../domain/ports.ts';
import type { FailureRecord, Problem } from '../domain/types.ts';
import { applyPatch, parse, type StoreContext } from './context.ts';

export function createFailureRepository(c: StoreContext): FailureRepository {
  const get = (id: string): FailureRecord | undefined => {
    const r = c.db.get('SELECT body FROM failures WHERE id = ?', id);
    return r ? parse<FailureRecord>(r.body) : undefined;
  };
  const many = (sql: string, ...args: (string | number)[]): FailureRecord[] => c.db.all(sql, ...args).map((r) => parse<FailureRecord>(r.body));
  return {
    create(input) {
      const r: FailureRecord = { id: c.idGen(), ...input };
      c.db.run('INSERT INTO failures (id, job_id, signature, at, pending_at, body) VALUES (?, ?, ?, ?, ?, ?)',
        r.id, r.jobId, r.signature, r.at, r.pendingAt ?? null, JSON.stringify(r));
      return r;
    },
    get,
    forJob(jobId) {
      return many('SELECT body FROM failures WHERE job_id = ? ORDER BY seq DESC LIMIT 1', jobId)[0];
    },
    list(filter) {
      const conds: string[] = [];
      const args: (string | number)[] = [];
      if (filter?.since !== undefined) { conds.push('at >= ?'); args.push(filter.since); }
      if (filter?.signature !== undefined) { conds.push('signature = ?'); args.push(filter.signature); }
      if (filter?.problemId !== undefined) { conds.push("body::jsonb->>'problemId' = ?"); args.push(filter.problemId); }
      if (filter?.outcome?.length) { conds.push(`body::jsonb->>'outcome' IN (${filter.outcome.map(() => '?').join(',')})`); args.push(...filter.outcome); }
      const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
      args.push(filter?.limit ?? 1000);
      return many(`SELECT body FROM failures ${where} ORDER BY at DESC, seq DESC LIMIT ?`, ...args);
    },
    due(at) {
      return many('SELECT body FROM failures WHERE pending_at IS NOT NULL AND pending_at <= ? ORDER BY pending_at, seq', at);
    },
    update(id, patch) {
      const r = get(id);
      if (!r) throw new Error(`failure record not found: ${id}`);
      const next = applyPatch<FailureRecord>(r, patch);
      c.db.run('UPDATE failures SET pending_at = ?, body = ? WHERE id = ?', next.pendingAt ?? null, JSON.stringify(next), id);
      return next;
    },
    prune(before) {
      return c.db.run('DELETE FROM failures WHERE at < ? AND pending_at IS NULL', before).changes;
    },
  };
}

export function createProblemRepository(c: StoreContext): ProblemRepository {
  const get = (id: string): Problem | undefined => {
    const r = c.db.get('SELECT body FROM problems WHERE id = ?', id);
    return r ? parse<Problem>(r.body) : undefined;
  };
  return {
    create(input) {
      const p: Problem = { id: c.idGen(), ...input };
      c.db.run('INSERT INTO problems (id, signature, status, opened_at, body) VALUES (?, ?, ?, ?, ?)', p.id, p.signature, p.status, p.openedAt, JSON.stringify(p));
      return p;
    },
    get,
    open(signature) {
      const r = c.db.get("SELECT body FROM problems WHERE signature = ? AND status = 'open' ORDER BY seq DESC LIMIT 1", signature);
      return r ? parse<Problem>(r.body) : undefined;
    },
    list(filter) {
      const conds: string[] = [];
      const args: (string | number)[] = [];
      if (filter?.status !== undefined) { conds.push('status = ?'); args.push(filter.status); }
      if (filter?.since !== undefined) { conds.push('opened_at >= ?'); args.push(filter.since); }
      const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
      args.push(filter?.limit ?? 200);
      return c.db.all(`SELECT body FROM problems ${where} ORDER BY seq DESC LIMIT ?`, ...args).map((r) => parse<Problem>(r.body));
    },
    update(id, patch) {
      const p = get(id);
      if (!p) throw new Error(`problem not found: ${id}`);
      const next = applyPatch<Problem>(p, patch);
      c.db.run('UPDATE problems SET status = ?, body = ? WHERE id = ?', next.status, JSON.stringify(next), id);
      return next;
    },
    prune(before) {
      return c.db.run("DELETE FROM problems WHERE status = 'resolved' AND body::jsonb->>'resolvedAt' < ?", before).changes;
    },
  };
}
