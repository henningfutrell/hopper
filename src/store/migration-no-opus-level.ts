// Tenant migration 33 (issue #632): the default ladder goes straight to the frontier level. The old built-in pair —
// claude-cli on `opus`, then claude-cli on `fable` — gave similar answers twice, so the opus level adds cost and time and
// no value. A stored plugins config that still holds exactly that pair loses its opus level; an open question at that
// level's stage moves to the fable level. Any other set of levels is someone's own choice and stays. A question's trail
// is history, and keeps the names it was written with.
import type { Db } from './db.ts';

interface Level { name?: unknown; plugin?: unknown; options?: { model?: unknown } }

const isPair = (levels: unknown[]): levels is [Level, Level] => {
  if (levels.length !== 2) return false;
  const [low, top] = levels as Level[];
  return low?.plugin === 'claude-cli' && low.options?.model === 'opus' && top?.plugin === 'claude-cli' && top.options?.model === 'fable';
};

export function noOpusLevel(db: Db): void {
  const row = db.get("SELECT value FROM config WHERE name = 'plugins'");
  if (!row) return;
  const value = JSON.parse(String(row.value)) as { escalationLevels?: unknown };
  const levels = value.escalationLevels;
  if (!Array.isArray(levels) || !isPair(levels)) return;
  const [opus, fable] = levels;
  value.escalationLevels = [fable];
  db.run("UPDATE config SET value = ? WHERE name = 'plugins'", JSON.stringify(value));
  for (const q of db.all("SELECT id, body FROM questions WHERE status = 'open'")) {
    const body = JSON.parse(String(q.body)) as { tier?: string };
    if (body.tier === opus.name) db.run('UPDATE questions SET body = ? WHERE id = ?', JSON.stringify({ ...body, tier: fable.name }), q.id as string);
  }
}
