import type { QuestionRepository } from '../domain/ports.ts';
import type { Question } from '../domain/types.ts';
import { applyPatch, parse, type StoreContext } from './context.ts';

export function createQuestionRepository(c: StoreContext): QuestionRepository {
  const get = (id: string): Question | undefined => {
    const r = c.db.get('SELECT body FROM questions WHERE id = ?', id);
    return r ? parse<Question>(r.body) : undefined;
  };
  const need = (id: string): Question => {
    const q = get(id);
    if (!q) throw new Error(`question not found: ${id}`);
    return q;
  };
  const save = (q: Question): Question => {
    const next: Question = { ...q, updatedAt: c.clock.now().toISOString() };
    c.db.run('UPDATE questions SET status = ?, body = ? WHERE id = ?', next.status, JSON.stringify(next), q.id);
    return next;
  };
  return {
    create(input) {
      const at = c.clock.now().toISOString();
      const q: Question = { id: c.idGen(), ...input, status: 'open', attempts: [], notifyCount: 0, createdAt: at, updatedAt: at };
      c.db.run('INSERT INTO questions (id, job_id, status, created_at, body) VALUES (?, ?, ?, ?, ?)', q.id, q.jobId, q.status, at, JSON.stringify(q));
      return q;
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
      return c.db.all(`SELECT body FROM questions ${where} ORDER BY created_at DESC, seq DESC ${limit}`, ...args).map((r) => parse<Question>(r.body));
    },
    update: (id, patch) => save(applyPatch<Question>(need(id), patch)),
    addAttempt(id, attempt) {
      const q = need(id);
      return save({ ...q, attempts: [...q.attempts, attempt] });
    },
  };
}
