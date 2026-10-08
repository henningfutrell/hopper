import type { UiSessionRepository, UiSessionRow } from '../domain/ports.ts';
import type { UiRole } from '../domain/types.ts';
import type { StoreContext } from './context.ts';

const rowOf = (r: Record<string, unknown>): UiSessionRow => ({
  tokenHash: String(r.token_hash), startedAt: String(r.started_at), lastSeenAt: String(r.last_seen_at), checkedAt: String(r.checked_at),
  ...(r.ends_at === null || r.ends_at === undefined ? {} : { endsAt: String(r.ends_at) }),
  role: String(r.role) as UiRole, identity: JSON.parse(String(r.identity)), userId: String(r.user_id),
});

export function createUiSessionRepository(c: StoreContext): UiSessionRepository {
  return {
    create(s) {
      c.db.run('INSERT INTO ui_sessions (token_hash, started_at, last_seen_at, checked_at, ends_at, role, identity, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        s.tokenHash, s.startedAt, s.lastSeenAt, s.checkedAt, s.endsAt ?? null, s.role, JSON.stringify(s.identity), s.userId);
    },
    get(tokenHash) {
      const r = c.db.get('SELECT * FROM ui_sessions WHERE token_hash = ?', tokenHash);
      return r ? rowOf(r) : undefined;
    },
    all() {
      return c.db.all('SELECT * FROM ui_sessions ORDER BY started_at, token_hash').map(rowOf);
    },
    setRole(tokenHash, role) {
      c.db.run('UPDATE ui_sessions SET role = ? WHERE token_hash = ?', role, tokenHash);
    },
    touch(tokenHash, lastSeenAt, checkedAt) {
      if (checkedAt === undefined) c.db.run('UPDATE ui_sessions SET last_seen_at = ? WHERE token_hash = ?', lastSeenAt, tokenHash);
      else c.db.run('UPDATE ui_sessions SET last_seen_at = ?, checked_at = ? WHERE token_hash = ?', lastSeenAt, checkedAt, tokenHash);
    },
    drop(tokenHash) {
      c.db.run('DELETE FROM ui_sessions WHERE token_hash = ?', tokenHash);
    },
  };
}
