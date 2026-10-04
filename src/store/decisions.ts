import type { DecisionRepository } from '../domain/ports.ts';
import type { Decision } from '../domain/types.ts';
import { parse, type StoreContext } from './context.ts';

export function createDecisionRepository(c: StoreContext): DecisionRepository {
  return {
    save(d) {
      c.db.run('INSERT INTO decisions (id, body) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET body = excluded.body', d.id, JSON.stringify(d));
    },
    get(id) {
      const r = c.db.get('SELECT body FROM decisions WHERE id = ?', id);
      return r ? parse<Decision>(r.body) : undefined;
    },
    list(limit) {
      const sql = `SELECT body FROM decisions ORDER BY seq DESC ${limit !== undefined ? 'LIMIT ?' : ''}`;
      const rows = limit !== undefined ? c.db.all(sql, limit) : c.db.all(sql);
      return rows.map((r) => parse<Decision>(r.body));
    },
  };
}
