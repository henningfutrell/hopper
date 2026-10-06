// Tenant migration 6 (issue #217): the gate router's settings are concepts a person setting up the
// hopper knows, not leftovers. A `gate-router` router in the config record `plugins` keeps its values
// under the new names — `grokBotJevSrc` is `jevPath`, `claudeModel` is `model`, `timeoutMs` is
// `timeoutSeconds` — and loses `claudeBin` (the router runs the `claude` on PATH, the one its model
// list comes from) and `jevGates` (which gates Jev answers is the router's, not a setting).
import type { Db } from './db.ts';

const RENAMED: Readonly<Record<string, string>> = { grokBotJevSrc: 'jevPath', claudeModel: 'model' };
const DROPPED = new Set(['claudeBin', 'jevGates']);

export function gateRouterSettingsAsConcepts(db: Db): void {
  const row = db.get("SELECT value FROM config WHERE name = 'plugins'");
  if (!row) return;
  const value = JSON.parse(String(row.value)) as { router?: { plugin?: unknown; options?: unknown } };
  const router = value.router;
  if (router?.plugin !== 'gate-router' || !router.options || typeof router.options !== 'object') return;
  const options: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(router.options as Record<string, unknown>)) {
    if (DROPPED.has(k)) continue;
    if (k === 'timeoutMs' && typeof v === 'number') options.timeoutSeconds = v / 1000;
    else options[RENAMED[k] ?? k] = v;
  }
  router.options = options;
  db.run("UPDATE config SET value = ? WHERE name = 'plugins'", JSON.stringify(value));
}
