// Tenant migration 71 (issue #1349): a sandbox does one step and is burned with its home, so no box reads a template's
// time limit (`ttlMinutes`) or whether it keeps its home (`keepHome`). Each stored template loses both from its limits;
// its CPUs and memory stay, and a template with no limits left has none.
import type { Db } from './db.ts';

export function noTemplateTimeLimit(db: Db): void {
  for (const row of db.all('SELECT name, body FROM templates')) {
    const t = JSON.parse(String(row.body)) as { limits?: Record<string, unknown> };
    if (!t.limits || !('ttlMinutes' in t.limits || 'keepHome' in t.limits)) continue;
    const { ttlMinutes: _t, keepHome: _k, ...kept } = t.limits;
    if (Object.keys(kept).length) t.limits = kept;
    else delete t.limits;
    db.run('UPDATE templates SET body = ? WHERE name = ?', JSON.stringify(t), String(row.name));
  }
}
