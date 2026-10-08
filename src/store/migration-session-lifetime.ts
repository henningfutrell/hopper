// Migration 26 (issue #439): a UI session no longer carries a fixed expiry. It carries when it started, when a
// request last renewed it, when a gateway realm's token last checked out for it, and — for the operator CLI's
// alone — an end of its own; the sign-in config's session lengths decide when it ends. A session live at the
// migration stays signed in, counted from now: when it started was never stored. One already expired goes.
import type { Db } from './db.ts';

export function sessionsRenew(db: Db): void {
  const now = new Date().toISOString();
  db.run('DELETE FROM ui_sessions WHERE expires_at <= ?', now);
  db.exec(`
    ALTER TABLE ui_sessions ADD COLUMN started_at TEXT;
    ALTER TABLE ui_sessions ADD COLUMN last_seen_at TEXT;
    ALTER TABLE ui_sessions ADD COLUMN checked_at TEXT;
    ALTER TABLE ui_sessions ADD COLUMN ends_at TEXT;
  `);
  db.run('UPDATE ui_sessions SET started_at = ?, last_seen_at = ?, checked_at = ?', now, now, now);
  db.exec(`
    ALTER TABLE ui_sessions ALTER COLUMN started_at SET NOT NULL;
    ALTER TABLE ui_sessions ALTER COLUMN last_seen_at SET NOT NULL;
    ALTER TABLE ui_sessions ALTER COLUMN checked_at SET NOT NULL;
    ALTER TABLE ui_sessions DROP COLUMN expires_at;
  `);
}
