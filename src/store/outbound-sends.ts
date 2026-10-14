// The send log (issue #1014, tenant migration 54, design.md "Outbound sends"): one row per outbound send, or per held
// send and its repeats within a minute, the body as JSON, with the columns read by — when, and whose. Rows older than
// OUTBOUND_LOG_DAYS are pruned.
import type { OutboundSend, OutboundSendRepository } from '../domain/outbound.ts';
import { parse, type StoreContext } from './context.ts';

export const OUTBOUND_SEND_TABLE = `
  CREATE TABLE outbound_sends (
    seq BIGSERIAL PRIMARY KEY,
    at TEXT NOT NULL,
    name TEXT NOT NULL,
    body TEXT NOT NULL
  );
  CREATE INDEX outbound_sends_at ON outbound_sends (at);
  CREATE INDEX outbound_sends_name ON outbound_sends (name, at)`;

export function createOutboundSendRepository(c: StoreContext): OutboundSendRepository {
  return {
    add(s) { c.db.run('INSERT INTO outbound_sends (at, name, body) VALUES (?, ?, ?)', s.at, s.name, JSON.stringify(s)); },
    list({ limit, name }) {
      const rows = name === undefined
        ? c.db.all('SELECT body FROM outbound_sends ORDER BY at DESC, seq DESC LIMIT ?', limit)
        : c.db.all('SELECT body FROM outbound_sends WHERE name = ? ORDER BY at DESC, seq DESC LIMIT ?', name, limit);
      return rows.map((r) => parse<OutboundSend>(r.body));
    },
    prune: (before) => c.db.run('DELETE FROM outbound_sends WHERE at < ?', before).changes,
  };
}
