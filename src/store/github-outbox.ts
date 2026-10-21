// The GitHub outbox (issue #1238, tenant migration 62, design.md "GitHub outbox"): one row per GitHub change a person's
// action asked for, the row as JSON, with the columns read by — its source, state and when it is due. Sent rows are pruned.
// A send claims its rows in one statement (issue #1959): `sending` with its claim's end as `next_at`, so a second hopper on
// the database takes none of them until the claim ends.
import type { GitHubOutboxRepository, OutboxInput, OutboxRow } from '../domain/github-outbox.ts';
import { parse, type StoreContext } from './context.ts';

export const GITHUB_OUTBOX_TABLE = `
  CREATE TABLE github_outbox (
    id BIGSERIAL PRIMARY KEY,
    source TEXT NOT NULL,
    state TEXT NOT NULL,
    next_at TEXT NOT NULL,
    sent_at TEXT,
    body TEXT NOT NULL
  );
  CREATE INDEX github_outbox_open ON github_outbox (source, state, next_at)`;

const rowOf = (r: Record<string, unknown>): OutboxRow => ({ ...parse<Omit<OutboxRow, 'id'>>(r.body), id: Number(r.id) });

export function createGitHubOutboxRepository(c: StoreContext): GitHubOutboxRepository {
  const write = (row: OutboxRow) => {
    const { id, ...body } = row;
    c.db.run('UPDATE github_outbox SET state = ?, next_at = ?, sent_at = ?, body = ? WHERE id = ?', row.state, row.nextAt, row.sentAt ?? null, JSON.stringify(body), id);
  };
  const get = (id: number) => { const r = c.db.get('SELECT id, body FROM github_outbox WHERE id = ?', id); return r ? rowOf(r) : undefined; };
  return {
    tx: c.tx,
    add(rows: OutboxInput[], at: string) {
      c.tx(() => {
        for (const r of rows) {
          const body: Omit<OutboxRow, 'id'> = { ...r, state: 'pending', attempts: 0, nextAt: at, createdAt: at };
          c.db.run('INSERT INTO github_outbox (source, state, next_at, body) VALUES (?, ?, ?, ?)', r.source, 'pending', at, JSON.stringify(body));
        }
      });
    },
    open: (source) => c.db.all("SELECT id, body FROM github_outbox WHERE source = ? AND state <> 'sent' ORDER BY id", source).map(rowOf),
    of: (source, key) => c.db.all('SELECT id, body FROM github_outbox WHERE source = ? ORDER BY id', source).map(rowOf).filter((r) => r.key === key),
    // One UPDATE: Postgres checks the state and `next_at` of a row another send claimed meanwhile again, so it is skipped.
    claim: (source, at, until, only) => c.db.all(
      `UPDATE github_outbox SET state = 'sending', next_at = ?, body = jsonb_set(jsonb_set(body::jsonb, '{state}', '"sending"'), '{nextAt}', to_jsonb(?::text))::text
       WHERE source = ? AND state IN ('pending', 'sending') AND next_at <= ?${only ? " AND body::jsonb->>'key' = ? AND body::jsonb->>'act' = ?" : ''} RETURNING id, body`,
      until, until, source, at, ...(only ? [only.key, only.act] : []),
    ).map(rowOf).sort((a, b) => a.id - b.id),
    update(ids, patch) {
      c.tx(() => {
        for (const id of ids) {
          const row = get(id);
          if (!row) continue;
          const next: OutboxRow = { ...row, ...patch };
          if ('lastError' in patch && patch.lastError === undefined) delete next.lastError;
          write(next);
        }
      });
    },
    prune: (before) => c.db.run("DELETE FROM github_outbox WHERE state = 'sent' AND sent_at < ?", before).changes,
  };
}

