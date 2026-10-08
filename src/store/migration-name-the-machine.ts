// Tenant migration 17 (issue #442): a claude-cli escalation level or claude-plan usage source that names no
// machine — a plugins config written fresh, with no machine (issue #259), or in the container (issue #141) —
// names the one machine that can run claude for it, where exactly one can (`fillMachines`). Anywhere else it
// is left unnamed: Settings flags it, and a question picks a machine for it as it is asked.
import { fillMachines } from '../domain/machine-pick.ts';
import type { Db } from './db.ts';

export function nameTheOnlyMachine(db: Db): void {
  const row = db.get("SELECT value FROM config WHERE name = 'plugins'");
  if (!row) return;
  const value = JSON.parse(String(row.value)) as unknown;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return;
  if (fillMachines(value as Record<string, unknown>).length) db.run("UPDATE config SET value = ? WHERE name = 'plugins'", JSON.stringify(value));
}
