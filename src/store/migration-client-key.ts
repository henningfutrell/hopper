// Tenant migration 13 (issue #308): a client target dials in to the hopper's own URL and proves itself
// with its machine key; the client token its runtime held (`tokenEnv`) is gone. A client target stored
// with one cannot be reached any more — its client still dials over ssh — so it leaves `machines`; it is
// added again with Add machine. Every other machine stays.
import type { Db } from './db.ts';

interface Instance { plugin?: unknown; options?: { tokenEnv?: unknown } }

export function clientTargetsDialIn(db: Db): void {
  const row = db.get("SELECT value FROM config WHERE name = 'plugins'");
  if (!row) return;
  const value = JSON.parse(String(row.value)) as { machines?: unknown };
  if (!Array.isArray(value.machines)) return;
  const kept = (value.machines as Instance[]).filter((m) => !(m?.plugin === 'client' && m.options?.tokenEnv !== undefined));
  if (kept.length === value.machines.length) return;
  value.machines = kept;
  db.run("UPDATE config SET value = ? WHERE name = 'plugins'", JSON.stringify(value));
}
