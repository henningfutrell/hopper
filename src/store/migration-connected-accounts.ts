// Tenant migration 8 (issue #214): a user's connected account, and its job source in the config record
// `plugins` — `github-account` after the job sources there, so a hopper set up before reads the account
// its user signs in with or connects without an edit. A record that names no job sources is left as it
// is (the built-in ones apply, and include it); a name already there is never added twice.
import type { Db } from './db.ts';

const ACCOUNT_SOURCES = [{ name: 'github-account', plugin: 'github-account' }];

export function connectedAccounts(db: Db): void {
  db.exec('CREATE TABLE connected_accounts (provider TEXT PRIMARY KEY, body TEXT NOT NULL)');
  const row = db.get("SELECT value FROM config WHERE name = 'plugins'");
  if (!row) return;
  const value = JSON.parse(String(row.value)) as { jobSources?: unknown };
  if (!Array.isArray(value.jobSources)) return;
  const taken = new Set(value.jobSources.map((s: { name?: unknown }) => s.name));
  const added = ACCOUNT_SOURCES.filter((s) => !taken.has(s.name));
  if (added.length === 0) return;
  value.jobSources = [...value.jobSources, ...added];
  db.run("UPDATE config SET value = ? WHERE name = 'plugins'", JSON.stringify(value));
}
