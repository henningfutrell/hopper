// Tenant migration 15 (issue #387): a GitHub source takes an issue by its label and its assignee, never
// by who filed it, so the `authors` option goes from every github-account and github-app instance. Every
// other option, and every other plugin's instance, stays as it is.
import type { Db } from './db.ts';

const GITHUB_SOURCES = new Set(['github-account', 'github-app']);

interface Instance { plugin?: unknown; options?: Record<string, unknown> }

export function noAuthors(db: Db): void {
  const row = db.get("SELECT value FROM config WHERE name = 'plugins'");
  if (!row) return;
  const value = JSON.parse(String(row.value)) as { jobSources?: unknown };
  if (!Array.isArray(value.jobSources)) return;
  let changed = false;
  for (const s of value.jobSources as Instance[]) {
    if (!GITHUB_SOURCES.has(String(s?.plugin)) || s.options === null || typeof s.options !== 'object' || !('authors' in s.options)) continue;
    delete s.options.authors;
    changed = true;
  }
  if (changed) db.run("UPDATE config SET value = ? WHERE name = 'plugins'", JSON.stringify(value));
}
