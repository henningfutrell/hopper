// Tenant migration (issue #1377): the hopper reads and writes GitHub only through the user's own sign-in, the hopper's
// GitHub App's user token, so a plugins config whose job sources hold no connected account's source (`github-account`)
// gets one: without it nothing lists while the user is signed in. The `github-app` job source (an admin's own GitHub
// App, its private key in the vault) is gone: each of its instances leaves the plugins config, and the account's source
// takes its place — switched on when the removed instance was on and it was off. Nothing of the work is lost: the removed
// instance's jobs and its source events (claims, request cards, intake) name the account's instance from now on, and the
// work-item ledger is rebuilt from them, so its request cards wait on a source that runs. The App's private key leaves the
// vault (`system/github-app-private-key`): no code reads it any more. A config with no job sources section is left as it
// is: the built-in instances, the account's source among them, apply. The build before runs on the result: a config with
// no `github-app` instance, and jobs of a source it knows.
import type { Db } from './db.ts';
import { rebuildWorkItems } from './work-items.ts';

const APP = 'github-app';
const ACCOUNT = 'github-account';
const KEY_ROW = 'system/github-app-private-key';

interface Instance { name?: unknown; plugin?: unknown; options?: Record<string, unknown> }

const isOn = (i: Instance): boolean => i.options?.enabled !== false;

/** A name no instance of `taken` has: `base`, else `base-2`, `base-3`, …. */
function freeName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

export function accountSourceOnly(db: Db): void {
  db.run('DELETE FROM vault_secrets WHERE name = ?', KEY_ROW);
  const row = db.get("SELECT value FROM config WHERE name = 'plugins'");
  if (!row) return;
  const value = JSON.parse(String(row.value)) as { jobSources?: unknown };
  if (!Array.isArray(value.jobSources)) return;
  const sources = value.jobSources as Instance[];
  const apps = sources.filter((s) => s?.plugin === APP);
  const kept = sources.filter((s) => s?.plugin !== APP);
  let account = kept.find((s) => s?.plugin === ACCOUNT);
  if (apps.length === 0 && account) return;
  if (!account) {
    account = { name: freeName(ACCOUNT, new Set(kept.map((s) => String(s?.name)))), plugin: ACCOUNT };
    kept.push(account);
  } else if (!isOn(account) && apps.some(isOn)) {
    const { enabled: _off, ...options } = account.options ?? {};
    account.options = options;
  }
  db.run("UPDATE config SET value = ? WHERE name = 'plugins'", JSON.stringify({ ...value, jobSources: kept }));
  if (apps.length === 0) return;
  const to = String(account.name);
  for (const app of apps) {
    const from = String(app.name);
    db.run(`UPDATE jobs SET body = jsonb_set(jsonb_set(body::jsonb, '{source,source}', to_jsonb(?::text)), '{source,kind}', to_jsonb(?::text))::text
      WHERE body::jsonb->'source'->>'source' = ?`, to, ACCOUNT, from);
    db.run(`UPDATE events SET data = jsonb_set(data::jsonb, '{source}', to_jsonb(?::text))::text
      WHERE type LIKE 'source.%' AND data::jsonb->>'source' = ?`, to, from);
  }
  rebuildWorkItems(db);
}
