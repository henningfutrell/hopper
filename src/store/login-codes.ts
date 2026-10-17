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
    create(codeHash, expiresAt, userId, place = {}) {
      c.db.run('INSERT INTO join_codes (code_hash, expires_at, user_id, template, pod) VALUES (?, ?, ?, ?, ?)', codeHash, expiresAt, userId, place.template ?? null, place.pod ?? null);
    },
    take(codeHash, now, machineKey) {
      return c.tx(() => {
        c.db.run('DELETE FROM join_codes WHERE expires_at <= ?', now);
        c.db.run('DELETE FROM join_codes_spent WHERE expires_at <= ?', now);
        // A spent code moves to its own table (issue #1628): a build before it, which reads join_codes only, never takes it again.
        const r = c.db.get('DELETE FROM join_codes WHERE code_hash = ? RETURNING expires_at, user_id, template, pod', codeHash)
          ?? c.db.get('SELECT expires_at, user_id, template, pod FROM join_codes_spent WHERE code_hash = ? AND machine_key = ?', codeHash, machineKey);
        if (!r) return undefined;
        c.db.run('INSERT INTO join_codes_spent (code_hash, machine_key, expires_at, user_id, template, pod) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (code_hash) DO NOTHING', codeHash, machineKey, r.expires_at, r.user_id, r.template ?? null, r.pod ?? null);
        return { userId: String(r.user_id), ...(r.template ? { template: String(r.template) } : {}), ...(r.pod ? { pod: String(r.pod) } : {}) };
      });
    },
  };
}
