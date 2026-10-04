import type { UiSessionRepository } from '../domain/ports.ts';
import type { StoreContext } from './context.ts';

export function createUiSessionRepository(c: StoreContext): UiSessionRepository {
  return {
    create(tokenHash, expiresAt) {
      c.db.run('INSERT INTO ui_sessions (token_hash, expires_at) VALUES (?, ?)', tokenHash, expiresAt);
    },
    find(tokenHash, now) {
      c.db.run('DELETE FROM ui_sessions WHERE expires_at <= ?', now);
      const r = c.db.get('SELECT expires_at FROM ui_sessions WHERE token_hash = ?', tokenHash);
      return r ? String(r.expires_at) : undefined;
    },
    drop(tokenHash) {
      c.db.run('DELETE FROM ui_sessions WHERE token_hash = ?', tokenHash);
    },
  };
}
