// The sagas (issue #1524, instance migration 46, design.md "Sagas: work that survives a stop"): one row per saga, in
// the instance schema, the saga as JSON, with the columns read by. The lease is columns only: the host that holds it
// writes the saga, and no other. An abort is a column of its own, so a holder's write never drops one asked meanwhile.
// A lease is timed on the database's clock (issue #1954): the hosts on one database share it, whatever their own say.
import { sagaEnded, type Saga, type SagaRepository } from '../domain/sagas.ts';
import { parse, type StoreContext } from './context.ts';
import { DB_NOW, DB_NOW_PLUS_MS } from './db-clock.ts';
import type { Row } from './db.ts';

export const SAGA_TABLE = `
  CREATE TABLE IF NOT EXISTS sagas (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    key TEXT NOT NULL,
    state TEXT NOT NULL,
    next_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    lease_owner TEXT,
    lease_until TEXT,
    abort TEXT,
    body TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS sagas_key ON sagas (kind, key);
  CREATE INDEX IF NOT EXISTS sagas_open ON sagas (next_at) WHERE state IN ('running', 'compensating')`;

const OPEN = "state IN ('running', 'compensating')";

const sagaOf = (r: Row): Saga => {
  const s = parse<Saga>(r.body);
  return r.abort ? { ...s, abort: parse<Saga['abort']>(r.abort) } : s;
};

export function createSagaRepository(c: StoreContext): SagaRepository {
  const get = (id: string): Saga | undefined => {
    const r = c.db.get('SELECT body, abort FROM sagas WHERE id = ?', id);
    return r ? sagaOf(r) : undefined;
  };
  return {
    begin(saga) {
      c.db.run('INSERT INTO sagas (id, kind, key, state, next_at, created_at, body) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
        saga.id, saga.kind, saga.key, saga.state, saga.nextAt, saga.createdAt, JSON.stringify(saga));
      return sagaOf(c.db.get('SELECT body, abort FROM sagas WHERE kind = ? AND key = ?', saga.kind, saga.key)!);
    },
    get,
    claim(id, lease) {
      const r = c.db.get(`UPDATE sagas SET lease_owner = ?, lease_until = ${DB_NOW_PLUS_MS} WHERE id = ? AND ${OPEN}
        AND (lease_owner IS NULL OR lease_owner = ? OR lease_until < ${DB_NOW}) RETURNING body, abort`, lease.owner, lease.ms, id, lease.owner);
      return r ? sagaOf(r) : undefined;
    },
    save(saga, owner) {
      const { abort: _a, ...body } = saga;
      const ended = sagaEnded(saga);
      return c.db.run(`UPDATE sagas SET state = ?, next_at = ?, body = ?,
        lease_owner = CASE WHEN ? THEN NULL ELSE lease_owner END, lease_until = CASE WHEN ? THEN NULL ELSE lease_until END
        WHERE id = ? AND lease_owner = ?`, saga.state, saga.nextAt, JSON.stringify(body), ended ? 1 : 0, ended ? 1 : 0, saga.id, owner)
        .changes > 0;
    },
    release(id, owner) {
      c.db.run('UPDATE sagas SET lease_owner = NULL, lease_until = NULL WHERE id = ? AND lease_owner = ?', id, owner);
    },
    requestAbort(id, abort) {
      return c.db.run(`UPDATE sagas SET abort = ? WHERE id = ? AND ${OPEN} AND abort IS NULL`, JSON.stringify(abort), id).changes > 0;
    },
    due: (now, limit) => c.db.all(`SELECT body, abort FROM sagas WHERE ${OPEN} AND (next_at <= ? OR abort IS NOT NULL)
      AND (lease_owner IS NULL OR lease_until < ${DB_NOW}) ORDER BY created_at, id LIMIT ?`, now, limit).map(sagaOf),
    open: () => c.db.all(`SELECT body, abort FROM sagas WHERE ${OPEN} ORDER BY created_at, id`).map(sagaOf),
    heldByOthers: (kind, owner) => c.db.all(`SELECT key FROM sagas WHERE kind = ? AND ${OPEN} AND lease_owner IS NOT NULL AND lease_owner <> ?
      AND lease_until >= ${DB_NOW}`, kind, owner).map((r) => String(r.key)),
  };
}
