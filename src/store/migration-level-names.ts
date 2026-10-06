// Tenant migration 5 (issue #209): an escalation level is named as a level, never after a model —
// the model it uses is only its `model` option. The built-in levels were `opus` and `fable`, and kept
// those names when their model changed. Each level of the config record `plugins` named after a model
// takes `level-<its place>` (a taken name gets `-2`, `-3`, …); plugin and options stay. A level's name
// is also a question stage: an open question at a renamed level moves to the new name. A question's
// trail is history, and keeps the names it was written with.
import { isModelName } from '../domain/plugins.ts';
import type { Db } from './db.ts';

interface Level { name: string; options?: { model?: unknown } }

export function levelsNamedAsLevels(db: Db): void {
  const row = db.get("SELECT value FROM config WHERE name = 'plugins'");
  if (!row) return;
  const value = JSON.parse(String(row.value)) as { escalationLevels?: unknown };
  const levels = value.escalationLevels;
  if (!Array.isArray(levels)) return;
  const taken = new Set(levels.map((l: Level) => l.name));
  const renamed = new Map<string, string>();
  value.escalationLevels = levels.map((l: Level, i) => {
    if (typeof l.name !== 'string' || !isModelName(l.name, l.options?.model)) return l;
    const base = `level-${i + 1}`;
    let name = base;
    for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
    taken.add(name);
    renamed.set(l.name, name);
    return { ...l, name };
  });
  if (renamed.size === 0) return;
  db.run("UPDATE config SET value = ? WHERE name = 'plugins'", JSON.stringify(value));
  for (const q of db.all("SELECT id, body FROM questions WHERE status = 'open'")) {
    const body = JSON.parse(String(q.body)) as { tier?: string };
    const to = body.tier === undefined ? undefined : renamed.get(body.tier);
    if (to) db.run('UPDATE questions SET body = ? WHERE id = ?', JSON.stringify({ ...body, tier: to }), q.id as string);
  }
}
