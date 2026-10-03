import type { DecisionRepository } from '../domain/ports.ts';
import type { Decision } from '../domain/types.ts';
import { parse, type StoreContext } from './context.ts';

export function createDecisionRepository(c: StoreContext): DecisionRepository {
  return {
    save(d) {
      c.db.prepare('INSERT OR REPLACE INTO decisions (id, body) VALUES (?, ?)').run(d.id, JSON.stringify(d));
    },
    get(id) {
      const r = c.db.prepare('SELECT body FROM decisions WHERE id = ?').get(id);
      return r ? parse<Decision>(r.body) : undefined;
    },
    list(limit) {
      const sql = `SELECT body FROM decisions ORDER BY seq DESC ${limit !== undefined ? 'LIMIT ?' : ''}`;
      const rows = limit !== undefined ? c.db.prepare(sql).all(limit) : c.db.prepare(sql).all();
      return rows.map((r) => parse<Decision>(r.body));
    },
  };
}
