// Pending index updates (issue #945, tenant migration 50): what search writes to Solr again — a key per document
// (`job:<id>`, `artifact:<id>`, `infra-plan:<id>`), the version it was marked at, and when. Postgres is the truth: the
// index is rebuilt from it, so a mark is all that waits, never the document itself.
import type { SearchPendingRepository, SearchType } from '../domain/search.ts';
import type { StoreContext } from './context.ts';

export const SEARCH_PENDING_TABLE = `
  CREATE TABLE search_pending (
    key TEXT PRIMARY KEY,
    version BIGINT NOT NULL DEFAULT 1,
    marked_at TEXT NOT NULL
  )`;

/** Each search type and the table its documents are built from: what the backfill marks. */
const TABLES: readonly [SearchType, string][] = [['job', 'jobs'], ['artifact', 'artifacts'], ['infra-plan', 'infra_plans']];

export function createSearchPendingRepository(c: StoreContext): SearchPendingRepository {
  const mark = (key: string, at: string): void => {
    c.db.run(`INSERT INTO search_pending (key, marked_at) VALUES (?, ?)
      ON CONFLICT (key) DO UPDATE SET version = search_pending.version + 1, marked_at = excluded.marked_at`, key, at);
  };
  return {
    mark(keys) {
      if (keys.length === 0) return;
      const at = c.clock.now().toISOString();
      c.tx(() => { for (const k of new Set(keys)) mark(k, at); });
    },
    markAll() {
      const at = c.clock.now().toISOString();
      return c.tx(() => TABLES.reduce((n, [type, table]) => {
        c.db.run(`INSERT INTO search_pending (key, marked_at) SELECT '${type}:' || id, ? FROM ${table}
          ON CONFLICT (key) DO UPDATE SET version = search_pending.version + 1, marked_at = excluded.marked_at`, at);
        return n + Number(c.db.get(`SELECT COUNT(*) AS n FROM ${table}`)?.n ?? 0);
      }, 0));
    },
    take: (limit) => c.db.all('SELECT key, version FROM search_pending ORDER BY marked_at, key LIMIT ?', limit)
      .map((r) => ({ key: r.key as string, version: Number(r.version) })),
    clear(taken) {
      if (taken.length === 0) return;
      c.tx(() => { for (const t of taken) c.db.run('DELETE FROM search_pending WHERE key = ? AND version = ?', t.key, t.version); });
    },
    count: () => Number(c.db.get('SELECT COUNT(*) AS n FROM search_pending')?.n ?? 0),
  };
}
