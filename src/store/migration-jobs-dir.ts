// Tenant migration 11 (issue #314): no job runs with its machine's home as its work tree. A stored work
// tree that is the home itself — `~` as a herdr-claude or cursor-agent executor's `cwd`, a job source's
// `defaultCwd` or a `repoPaths` value — becomes the jobs directory, so the jobs it sent to the home run
// below it instead of failing at start. Every other value stays.
import type { Db } from './db.ts';

const JOBS_DIR = '~/hopper-jobs';
const WORK_TREE_EXECUTORS = new Set(['herdr-claude', 'cursor-agent']);
const isHome = (v: unknown): boolean => v === '~' || v === '~/';

interface Instance { plugin?: unknown; options?: Record<string, unknown> }

export function jobsDirWorkTrees(db: Db): void {
  const row = db.get("SELECT value FROM config WHERE name = 'plugins'");
  if (!row) return;
  const value = JSON.parse(String(row.value)) as { executors?: unknown; jobSources?: unknown };
  let changed = false;
  for (const e of (Array.isArray(value.executors) ? value.executors : []) as Instance[]) {
    if (!WORK_TREE_EXECUTORS.has(String(e?.plugin)) || !e.options || !isHome(e.options.cwd)) continue;
    e.options.cwd = JOBS_DIR;
    changed = true;
  }
  for (const s of (Array.isArray(value.jobSources) ? value.jobSources : []) as Instance[]) {
    const o = s?.options;
    if (!o) continue;
    if (isHome(o.defaultCwd)) { o.defaultCwd = JOBS_DIR; changed = true; }
    const paths = o.repoPaths;
    if (typeof paths !== 'object' || paths === null || Array.isArray(paths)) continue;
    for (const [repo, path] of Object.entries(paths as Record<string, unknown>)) {
      if (isHome(path)) { (paths as Record<string, unknown>)[repo] = JOBS_DIR; changed = true; }
    }
  }
  if (changed) db.run("UPDATE config SET value = ? WHERE name = 'plugins'", JSON.stringify(value));
}
