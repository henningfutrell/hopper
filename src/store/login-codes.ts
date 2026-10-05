import type { LoginCodeRepository } from '../domain/ports.ts';
import type { StoreContext } from './context.ts';

export function createLoginCodeRepository(c: StoreContext): LoginCodeRepository {
  return {
    create(codeHash, expiresAt) {
      c.db.run('INSERT INTO login_codes (code_hash, expires_at) VALUES (?, ?)', codeHash, expiresAt);
    },
    take(codeHash, now) {
      return c.tx(() => {
        c.db.run('DELETE FROM login_codes WHERE expires_at <= ?', now);
        return c.db.run('DELETE FROM login_codes WHERE code_hash = ?', codeHash).changes > 0;
      });
    },
    live(codeHash, now) {
      return c.db.get('SELECT 1 FROM login_codes WHERE code_hash = ? AND expires_at > ?', codeHash, now) !== undefined;
    },
  };
}
