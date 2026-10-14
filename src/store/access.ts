// The access rows (issue #559, instance schema): the access models, the tuples pushed to OpenFGA, what the hopper keeps
// of OpenFGA, and the mint decisions.
import type { AccessRepository, StoredTuple } from '../domain/ports.ts';
import type { AccessDecisionRecord } from '../domain/types.ts';
import type { Row } from './db.ts';
import type { StoreContext } from './context.ts';

const tupleOf = (r: Row): StoredTuple => ({
  seq: Number(r.seq), subject: String(r.subject), relation: String(r.relation), object: String(r.object),
  writtenBy: String(r.written_by), writtenAt: String(r.written_at),
  ...(r.revoked_at == null ? {} : { revokedBy: String(r.revoked_by), revokedAt: String(r.revoked_at) }),
});

export function createAccessRepository(c: StoreContext): AccessRepository {
  return {
    model() {
      const r = c.db.get('SELECT seq, dsl, written_by, written_at FROM access_models ORDER BY seq DESC LIMIT 1');
      return r ? { seq: Number(r.seq), dsl: String(r.dsl), writtenBy: String(r.written_by), writtenAt: String(r.written_at) } : undefined;
    },
    addModel(dsl, by, at) {
      const r = c.db.get('INSERT INTO access_models (dsl, written_by, written_at) VALUES (?, ?, ?) RETURNING seq', dsl, by, at)!;
      return { seq: Number(r.seq), dsl, writtenBy: by, writtenAt: at };
    },
    liveTuples: () => c.db.all('SELECT * FROM access_tuples WHERE revoked_at IS NULL ORDER BY seq').map(tupleOf),
    addTuple(t, by, at) {
      return c.tx(() => {
        const live = c.db.get('SELECT * FROM access_tuples WHERE subject = ? AND relation = ? AND object = ? AND revoked_at IS NULL', t.subject, t.relation, t.object);
        if (live) return tupleOf(live);
        return tupleOf(c.db.get('INSERT INTO access_tuples (subject, relation, object, written_by, written_at) VALUES (?, ?, ?, ?, ?) RETURNING *',
          t.subject, t.relation, t.object, by, at)!);
      });
    },
    revokeTuple(seq, by, at) {
      const r = c.db.get('UPDATE access_tuples SET revoked_by = ?, revoked_at = ? WHERE seq = ? AND revoked_at IS NULL RETURNING *', by, at, seq);
      return r ? tupleOf(r) : undefined;
    },
    revoked: (relation, limit) =>
      c.db.all('SELECT * FROM access_tuples WHERE relation = ? AND revoked_at IS NOT NULL ORDER BY revoked_at DESC, seq DESC LIMIT ?', relation, limit).map(tupleOf),
    state: (key) => {
      const r = c.db.get('SELECT value FROM access_state WHERE key = ?', key);
      return r ? String(r.value) : undefined;
    },
    setState(key, value) {
      c.db.run('INSERT INTO access_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, value);
    },
    recordDecision(d) {
      c.db.run('INSERT INTO access_decisions (id, at, body) VALUES (?, ?, ?)', d.id, d.at, JSON.stringify(d));
    },
    decisions: (limit) =>
      c.db.all('SELECT body FROM access_decisions ORDER BY seq DESC LIMIT ?', limit).map((r) => JSON.parse(String(r.body)) as AccessDecisionRecord),
  };
}
