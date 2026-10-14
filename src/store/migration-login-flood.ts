// Tenant migration 27 (issue #567): the logins a device-flow polling loop flooded collapse into one per real prompt.
// Before the fix, Claude going on completed a login and the same report on screen made a new one, every few seconds.
// Logins of one job (or question), tool and kind, oldest first: one reported while the one kept still lived (before
// its `expiresAt`) is that login again — it goes, and the one kept takes its last status, end, reason and expiry. One
// reported after the kept one expired is a prompt of its own and is kept. The URL and code were never stored, so
// this is all there is to go on. Events are never rewritten. A second run changes nothing.
import type { Db } from './db.ts';

type Obj = Record<string, unknown>;

const LAST = ['status', 'expiresAt', 'updatedAt', 'endedAt', 'reason'] as const;

export function collapseFloodedLogins(db: Db): void {
  const runs = new Map<string, Obj>();
  for (const row of db.all('SELECT id, body FROM logins ORDER BY created_at, seq')) {
    const l = JSON.parse(String(row.body)) as Obj;
    const key = JSON.stringify([l.jobId ?? null, l.questionId ?? null, l.tool, l.kind]);
    const kept = runs.get(key);
    if (!kept || String(l.createdAt) >= String(kept.expiresAt)) { runs.set(key, l); continue; }
    const next: Obj = { ...kept };
    for (const k of LAST) {
      if (l[k] === undefined) delete next[k];
      else next[k] = l[k];
    }
    db.run('DELETE FROM logins WHERE id = ?', String(row.id));
    db.run('UPDATE logins SET status = ?, body = ? WHERE id = ?', String(next.status), JSON.stringify(next), String(kept.id));
    runs.set(key, next);
  }
}
