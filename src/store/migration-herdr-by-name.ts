// Tenant migration 12 (issue #311): herdr is called by name on an ssh machine, from its PATH then
// ~/.local/bin, so no option names its binary: every `ssh` machine instance's `herdrBin` goes.
import type { Db } from './db.ts';

interface Instance { plugin?: unknown; options?: Record<string, unknown> }

export function herdrByName(db: Db): void {
  const row = db.get("SELECT value FROM config WHERE name = 'plugins'");
  if (!row) return;
  const value = JSON.parse(String(row.value)) as { machines?: unknown };
  if (!Array.isArray(value.machines)) return;
  let changed = false;
  for (const m of value.machines as Instance[]) {
    if (m?.plugin !== 'ssh' || !m.options || !('herdrBin' in m.options)) continue;
    const { herdrBin: _gone, ...rest } = m.options;
    m.options = rest;
    changed = true;
  }
  if (changed) db.run("UPDATE config SET value = ? WHERE name = 'plugins'", JSON.stringify(value));
}
