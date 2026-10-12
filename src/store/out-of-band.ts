// Out-of-band changes (issue #871, tenant migration 47): one row each, never updated — the signal as JSON, its source and
// key in columns of their own so a report sent again is found. A person's mark is a row of its own table, so marking a
// change changes no change. The controller identities are one row each.
import type { OutOfBandChange, OutOfBandMark, OutOfBandRepository, OutOfBandView } from '../domain/out-of-band.ts';
import { parse, type StoreContext } from './context.ts';

export const OUT_OF_BAND_TABLES = `
  CREATE TABLE infra_out_of_band (seq BIGSERIAL PRIMARY KEY, id TEXT NOT NULL UNIQUE, source TEXT NOT NULL, key TEXT NOT NULL, recorded_at TEXT NOT NULL, body TEXT NOT NULL);
  CREATE INDEX infra_out_of_band_key ON infra_out_of_band (source, key);
  CREATE TABLE infra_out_of_band_marks (change_id TEXT PRIMARY KEY REFERENCES infra_out_of_band (id), body TEXT NOT NULL);
  CREATE TABLE infra_controllers (seq BIGSERIAL PRIMARY KEY, identity TEXT NOT NULL UNIQUE)`;

export function createOutOfBandRepository(c: StoreContext): OutOfBandRepository {
  return {
    add(change) {
      c.db.run('INSERT INTO infra_out_of_band (id, source, key, recorded_at, body) VALUES (?, ?, ?, ?, ?)', change.id, change.source, change.key, change.recordedAt, JSON.stringify(change));
    },
    get(id) {
      const r = c.db.get('SELECT body FROM infra_out_of_band WHERE id = ?', id);
      return r ? parse<OutOfBandChange>(r.body) : undefined;
    },
    find: (source, key) => c.db.all(`SELECT o.id, m.change_id IS NOT NULL AS marked FROM infra_out_of_band o
      LEFT JOIN infra_out_of_band_marks m ON m.change_id = o.id WHERE o.source = ? AND o.key = ?`, source, key).map((r) => ({ id: r.id as string, marked: r.marked === true })),
    list: (limit) => c.db.all(`SELECT o.body, m.body AS marked FROM infra_out_of_band o LEFT JOIN infra_out_of_band_marks m ON m.change_id = o.id
      ORDER BY o.recorded_at DESC, o.seq DESC LIMIT ?`, limit).map((r): OutOfBandView => ({
      ...parse<OutOfBandChange>(r.body), ...(r.marked !== null ? { marked: parse<OutOfBandMark>(r.marked) } : {}),
    })),
    mark(m) {
      c.db.run('INSERT INTO infra_out_of_band_marks (change_id, body) VALUES (?, ?)', m.change, JSON.stringify(m));
    },
    markOf(id) {
      const r = c.db.get('SELECT body FROM infra_out_of_band_marks WHERE change_id = ?', id);
      return r ? parse<OutOfBandMark>(r.body) : undefined;
    },
    controllers: () => c.db.all('SELECT identity FROM infra_controllers ORDER BY seq').map((r) => r.identity as string),
    setControllers(identities) {
      c.tx(() => {
        c.db.run('DELETE FROM infra_controllers');
        for (const identity of identities) c.db.run('INSERT INTO infra_controllers (identity) VALUES (?)', identity);
      });
    },
  };
}
