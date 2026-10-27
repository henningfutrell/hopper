// The memory entries of each repository (issue #2847, tenant migration 104, design.md "Repository memory"): one row each,
// its fields as JSON, with the columns read by — its repository and when it changed last.
import type { MemoryEntry, MemoryEntryRepository } from '../domain/repo-memory.ts';
import { parse, type StoreContext } from './context.ts';

export const MEMORY_ENTRY_TABLE = `CREATE TABLE IF NOT EXISTS memory_entries (id TEXT PRIMARY KEY, repo TEXT NOT NULL, updated_at TEXT NOT NULL, body TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS memory_entries_repo ON memory_entries (repo, updated_at)`;

export function createMemoryEntryRepository(c: StoreContext): MemoryEntryRepository {
  const many = (sql: string, ...args: string[]): MemoryEntry[] => c.db.all(sql, ...args).map((r) => parse<MemoryEntry>(r.body));
  return {
    list: (repo) => (repo === undefined
      ? many('SELECT body FROM memory_entries ORDER BY updated_at DESC, id')
      : many('SELECT body FROM memory_entries WHERE repo = ? ORDER BY updated_at DESC, id', repo)),
    get(id) {
      const r = c.db.get('SELECT body FROM memory_entries WHERE id = ?', id);
      return r ? parse<MemoryEntry>(r.body) : undefined;
    },
    put(e) {
      c.db.run(`INSERT INTO memory_entries (id, repo, updated_at, body) VALUES (?, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET repo = excluded.repo, updated_at = excluded.updated_at, body = excluded.body`, e.id, e.repo, e.updatedAt, JSON.stringify(e));
    },
    remove: (id) => c.db.run('DELETE FROM memory_entries WHERE id = ?', id).changes > 0,
  };
}
