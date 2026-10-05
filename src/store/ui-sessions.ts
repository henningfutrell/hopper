import type { UiSessionRepository, UiSessionRow } from '../domain/ports.ts';
import type { UiRole } from '../domain/types.ts';
import type { StoreContext } from './context.ts';

const rowOf = (r: Record<string, unknown>): UiSessionRow => ({
  tokenHash: String(r.token_hash), expiresAt: String(r.expires_at), role: String(r.role) as UiRole, identity: JSON.parse(String(r.identity)), userId: String(r.user_id),
});

export function createUiSessionRepository(c: StoreContext): UiSessionRepository {
  return {
    create(s) {
      c.db.run('INSERT INTO ui_sessions (token_hash, expires_at, role, identity, user_id) VALUES (?, ?, ?, ?, ?)', s.tokenHash, s.expiresAt, s.role, JSON.stringify(s.identity), s.userId);
    },
    find(tokenHash, now) {
      c.db.run('DELETE FROM ui_sessions WHERE expires_at <= ?', now);
      const r = c.db.get('SELECT * FROM ui_sessions WHERE token_hash = ?', tokenHash);
      return r ? rowOf(r) : undefined;
    },
    all() {
      return c.db.all('SELECT * FROM ui_sessions').map(rowOf);
    },
    setRole(tokenHash, role) {
      c.db.run('UPDATE ui_sessions SET role = ? WHERE token_hash = ?', role, tokenHash);
    },
    drop(tokenHash) {
      c.db.run('DELETE FROM ui_sessions WHERE token_hash = ?', tokenHash);
    },
  };
}
