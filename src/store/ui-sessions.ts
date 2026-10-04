import type { UiSessionRepository, UiSessionRow } from '../domain/ports.ts';
import type { UiRole } from '../domain/types.ts';
import type { StoreContext } from './context.ts';

const rowOf = (r: Record<string, unknown>): UiSessionRow => ({
  tokenHash: String(r.token_hash), expiresAt: String(r.expires_at), role: String(r.role) as UiRole, identity: JSON.parse(String(r.identity)),
});

export function createUiSessionRepository(c: StoreContext): UiSessionRepository {
  return {
    create(s) {
      c.db.prepare('INSERT INTO ui_sessions (token_hash, expires_at, role, identity) VALUES (?, ?, ?, ?)').run(s.tokenHash, s.expiresAt, s.role, JSON.stringify(s.identity));
    },
    find(tokenHash, now) {
      c.db.prepare('DELETE FROM ui_sessions WHERE expires_at <= ?').run(now);
      const r = c.db.prepare('SELECT * FROM ui_sessions WHERE token_hash = ?').get(tokenHash);
      return r ? rowOf(r) : undefined;
    },
    all() {
      return c.db.prepare('SELECT * FROM ui_sessions').all().map(rowOf);
    },
    setRole(tokenHash, role) {
      c.db.prepare('UPDATE ui_sessions SET role = ? WHERE token_hash = ?').run(role, tokenHash);
    },
    drop(tokenHash) {
      c.db.prepare('DELETE FROM ui_sessions WHERE token_hash = ?').run(tokenHash);
    },
  };
}
