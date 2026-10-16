// Tenant migration 70 (issue #1349): a sandbox is no machine. Every client machine the hopper started a sandbox box for
// (its `container` names a `hopper-sandbox-…` box) leaves `machines`, with its lanes: at the next start the daemon closes
// the lanes of a machine it does not know, and the sandbox module's burn pass burns the boxes and their records. Every
// other machine stays.
import type { Db } from './db.ts';

interface Instance { plugin?: unknown; options?: { container?: unknown } }

const SANDBOX_BOX = /^hopper-sandbox-/;

export const isSandboxMachine = (m: Instance | null | undefined): boolean =>
  m?.plugin === 'client' && typeof m.options?.container === 'string' && SANDBOX_BOX.test(m.options.container);

export function noSandboxMachines(db: Db): void {
  const row = db.get("SELECT value FROM config WHERE name = 'plugins'");
  if (!row) return;
  const value = JSON.parse(String(row.value)) as { machines?: unknown };
  if (!Array.isArray(value.machines)) return;
  const kept = (value.machines as Instance[]).filter((m) => !isSandboxMachine(m));
  if (kept.length === value.machines.length) return;
  value.machines = kept;
  db.run("UPDATE config SET value = ? WHERE name = 'plugins'", JSON.stringify(value));
}
