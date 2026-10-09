import type { JoinCodeRepository, LoginCodeRepository } from '../domain/ports.ts';
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

/** Join codes (issue #308): the same shape as login codes, a machine's instead of a browser's. */
export function createJoinCodeRepository(c: StoreContext): JoinCodeRepository {
  return {
    create(codeHash, expiresAt, userId, template) {
      c.db.run('INSERT INTO join_codes (code_hash, expires_at, user_id, template) VALUES (?, ?, ?, ?)', codeHash, expiresAt, userId, template ?? null);
    },
    take(codeHash, now) {
      return c.tx(() => {
        c.db.run('DELETE FROM join_codes WHERE expires_at <= ?', now);
        const r = c.db.get('DELETE FROM join_codes WHERE code_hash = ? RETURNING user_id, template', codeHash);
        return r ? { userId: String(r.user_id), ...(r.template ? { template: String(r.template) } : {}) } : undefined;
      });
    },
  };
}
