import type { UiSessionRepository } from '../domain/ports.ts';
import type { StoreContext } from './context.ts';

export function createUiSessionRepository(c: StoreContext): UiSessionRepository {
  return {
    create(tokenHash, expiresAt) {
      c.db.prepare('INSERT INTO ui_sessions (token_hash, expires_at) VALUES (?, ?)').run(tokenHash, expiresAt);
    },
    find(tokenHash, now) {
      c.db.prepare('DELETE FROM ui_sessions WHERE expires_at <= ?').run(now);
      const r = c.db.prepare('SELECT expires_at FROM ui_sessions WHERE token_hash = ?').get(tokenHash);
      return r ? String(r.expires_at) : undefined;
    },
    drop(tokenHash) {
      c.db.prepare('DELETE FROM ui_sessions WHERE token_hash = ?').run(tokenHash);
    },
  };
}
