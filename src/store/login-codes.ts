import type { LoginCodeRepository } from '../domain/ports.ts';
import type { StoreContext } from './context.ts';

export function createLoginCodeRepository(c: StoreContext): LoginCodeRepository {
  return {
    create(codeHash, expiresAt, userId) {
      c.db.run('INSERT INTO login_codes (code_hash, expires_at, user_id) VALUES (?, ?, ?)', codeHash, expiresAt, userId);
    },
    take(codeHash, now) {
      return c.tx(() => {
        c.db.run('DELETE FROM login_codes WHERE expires_at <= ?', now);
        const r = c.db.get('DELETE FROM login_codes WHERE code_hash = ? RETURNING user_id', codeHash);
        return r ? String(r.user_id) : undefined;
      });
    },
    live(codeHash, now) {
      const r = c.db.get('SELECT user_id FROM login_codes WHERE code_hash = ? AND expires_at > ?', codeHash, now);
      return r ? String(r.user_id) : undefined;
    },
  };
}
