// Tenant migration 9 (issue #267): yolo is a herdr-claude executor's own option, no longer an argument
// in its `args`. An instance whose args granted every permission is yolo, and those arguments leave
// args; one whose args did not is not yolo, so it keeps asking as it did. One that named no args ran
// with the old default (yolo) and is left to the new one, as is one that already names yolo.
import type { Db } from './db.ts';

const GRANTS_ALL = new Set(['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--permission-mode=bypassPermissions']);

interface Instance { plugin?: unknown; options?: { yolo?: unknown; args?: unknown } }

/** `args` without what grants every permission, and whether anything did. */
function split(args: string[]): { yolo: boolean; rest: string[] } {
  const rest: string[] = [];
  let yolo = false;
  for (let i = 0; i < args.length; i++) {
    if (GRANTS_ALL.has(args[i]!)) yolo = true;
    else if (args[i] === '--permission-mode' && args[i + 1] === 'bypassPermissions') { yolo = true; i++; }
    else rest.push(args[i]!);
  }
  return { yolo, rest };
}

export function yoloOption(db: Db): void {
  const row = db.get("SELECT value FROM config WHERE name = 'plugins'");
  if (!row) return;
  const value = JSON.parse(String(row.value)) as { executors?: unknown };
  if (!Array.isArray(value.executors)) return;
  let changed = false;
  for (const e of value.executors as Instance[]) {
    const o = e?.plugin === 'herdr-claude' ? e.options : undefined;
    if (!o || 'yolo' in o || !Array.isArray(o.args) || !o.args.every((a) => typeof a === 'string')) continue;
    const { yolo, rest } = split(o.args as string[]);
    const { args: _old, ...others } = o;
    e.options = { ...others, yolo, ...(rest.length || !yolo ? { args: rest } : {}) };
    changed = true;
  }
  if (changed) db.run("UPDATE config SET value = ? WHERE name = 'plugins'", JSON.stringify(value));
}
