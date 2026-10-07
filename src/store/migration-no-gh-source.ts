// Tenant migration 14 (issue #359): the gh CLI job source is gone — the hopper reads GitHub as the user
// only through the account they signed in with or connected. Every github-gh instance leaves
// `jobSources`. The repos the first one named become the job repositories when none are chosen yet, so
// the issues it read are read through the connected account; a config left with no github-account
// instance gets one. Every other instance stays.
import type { Db } from './db.ts';
import { jobRepositoriesKey } from './settings.ts';

interface Instance { name?: unknown; plugin?: unknown; options?: { repos?: unknown } }

export function noGhSource(db: Db): void {
  const row = db.get("SELECT value FROM config WHERE name = 'plugins'");
  if (!row) return;
  const value = JSON.parse(String(row.value)) as { jobSources?: unknown };
  if (!Array.isArray(value.jobSources)) return;
  const sources = value.jobSources as Instance[];
  const gh = sources.filter((s) => s?.plugin === 'github-gh');
  if (gh.length === 0) return;
  const kept = sources.filter((s) => s?.plugin !== 'github-gh');
  if (!kept.some((s) => s?.plugin === 'github-account') && !kept.some((s) => s?.name === 'github-account')) {
    kept.push({ name: 'github-account', plugin: 'github-account' });
  }
  value.jobSources = kept;
  db.run("UPDATE config SET value = ? WHERE name = 'plugins'", JSON.stringify(value));
  const repos = gh[0]!.options?.repos;
  const named = Array.isArray(repos) ? repos.filter((r): r is string => typeof r === 'string') : [];
  if (named.length > 0 && !db.get('SELECT value FROM settings WHERE key = ?', jobRepositoriesKey('github'))) {
    db.run('INSERT INTO settings (key, value) VALUES (?, ?)', jobRepositoriesKey('github'), JSON.stringify(named));
  }
}
