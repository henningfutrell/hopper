import type { LoginRepository } from '../domain/ports.ts';
import type { Login } from '../domain/types.ts';
import { applyPatch, parse, type StoreContext } from './context.ts';

export function createLoginRepository(c: StoreContext): LoginRepository {
  const get = (id: string): Login | undefined => {
    const r = c.db.get('SELECT body FROM logins WHERE id = ?', id);
    return r ? parse<Login>(r.body) : undefined;
  };
  return {
    create(input) {
      const at = c.clock.now().toISOString();
      const l: Login = { id: c.idGen(), ...input, status: 'pending', createdAt: at, updatedAt: at };
      c.db.run('INSERT INTO logins (id, job_id, question_id, status, created_at, body) VALUES (?, ?, ?, ?, ?, ?)',
        l.id, l.jobId ?? null, l.questionId ?? null, l.status, at, JSON.stringify(l));
      return l;
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
      if (filter?.questionId !== undefined) { conds.push('question_id = ?'); args.push(filter.questionId); }
      const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
      const limit = filter?.limit !== undefined ? 'LIMIT ?' : '';
      if (filter?.limit !== undefined) args.push(filter.limit);
      return c.db.all(`SELECT body FROM logins ${where} ORDER BY created_at DESC, seq DESC ${limit}`, ...args).map((r) => parse<Login>(r.body));
    },
    update(id, patch) {
      const l = get(id);
      if (!l) throw new Error(`login not found: ${id}`);
      const next: Login = { ...applyPatch<Login>(l, patch), updatedAt: c.clock.now().toISOString() };
      c.db.run('UPDATE logins SET status = ?, body = ? WHERE id = ?', next.status, JSON.stringify(next), id);
      return next;
    },
  };
}
