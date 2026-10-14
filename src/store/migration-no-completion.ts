// Tenant migration 30 (issue #579): done is always a pull request ready for review, so the GitHub sources'
// `completion` option goes from every github-account and github-app instance. Yolo mode is not set from it: a job
// may merge its own pull request only once a person turns yolo mode on. Every other option stays as it is.
import type { Db } from './db.ts';

const GITHUB_SOURCES = new Set(['github-account', 'github-app']);

interface Instance { plugin?: unknown; options?: Record<string, unknown> }

export function noCompletion(db: Db): void {
  const row = db.get("SELECT value FROM config WHERE name = 'plugins'");
  if (!row) return;
  const value = JSON.parse(String(row.value)) as { jobSources?: unknown };
  if (!Array.isArray(value.jobSources)) return;
  let changed = false;
  for (const s of value.jobSources as Instance[]) {
    if (!GITHUB_SOURCES.has(String(s?.plugin)) || s.options === null || typeof s.options !== 'object' || !('completion' in s.options)) continue;
    delete s.options.completion;
    changed = true;
  }
  if (changed) db.run("UPDATE config SET value = ? WHERE name = 'plugins'", JSON.stringify(value));
}
