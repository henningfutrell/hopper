// Tenant migration 88 (issue #2146, part 5): an observe changes no asset, so a template a job asked for with read and
// observe needs only takes the read-only check, as one of read needs only does. A template saved before had no mark: each
// stored template whose profiles are all reads or observes, with an observe among them, is marked `readOnly`. Its next
// check pass runs its check, and its bastion waits for it.
import type { Db } from './db.ts';

export function observeTemplatesChecked(db: Db): void {
  for (const row of db.all('SELECT name, body FROM templates')) {
    const t = JSON.parse(String(row.body)) as { readOnly?: boolean; profiles?: { operation?: string }[] };
    const ops = (t.profiles ?? []).map((p) => p.operation);
    if (t.readOnly || !ops.includes('observe') || !ops.every((op) => op === 'read' || op === 'observe')) continue;
    t.readOnly = true;
    db.run('UPDATE templates SET body = ? WHERE name = ?', JSON.stringify(t), String(row.name));
  }
}
