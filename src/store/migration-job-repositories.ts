// Tenant migration 10 (issue #321): a connected account's job repositories are the user's setting, read
// at each sync, no longer its job source's options (a job source's options apply only at a restart).
// The repos a github-account instance named become the job repositories; `repos` and `owners` leave its
// options, every other option stays. Owners named no repository, so they choose none: their source then
// takes no job until repositories are chosen in Sources.
import type { Db } from './db.ts';
import { jobRepositoriesKey } from './settings.ts';

interface Instance { plugin?: unknown; options?: Record<string, unknown> }

export function jobRepositoriesSetting(db: Db): void {
  const row = db.get("SELECT value FROM config WHERE name = 'plugins'");
  if (!row) return;
  const value = JSON.parse(String(row.value)) as { jobSources?: unknown };
  if (!Array.isArray(value.jobSources)) return;
  const repos = new Set<string>();
  let changed = false;
  for (const s of value.jobSources as Instance[]) {
    const o = s?.plugin === 'github-account' ? s.options : undefined;
    if (!o || !('repos' in o || 'owners' in o)) continue;
    if (Array.isArray(o.repos)) for (const r of o.repos) if (typeof r === 'string') repos.add(r);
    const { repos: _repos, owners: _owners, ...rest } = o;
    s.options = rest;
    changed = true;
  }
  if (!changed) return;
  db.run("UPDATE config SET value = ? WHERE name = 'plugins'", JSON.stringify(value));
  if (repos.size > 0) {
    db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', jobRepositoriesKey('github'), JSON.stringify([...repos]));
  }
}
