import type { JoinCodeRepository, LanePoolKeyRepository, LoginCodeRepository } from '../domain/ports.ts';
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
    take(codeHash, now) {
      return c.tx(() => {
        c.db.run('DELETE FROM join_codes WHERE expires_at <= ?', now);
        const r = c.db.get('DELETE FROM join_codes WHERE code_hash = ? RETURNING user_id, template, pod', codeHash);
        return r ? { userId: String(r.user_id), ...(r.template ? { template: String(r.template) } : {}), ...(r.pod ? { pod: String(r.pod) } : {}) } : undefined;
      });
    },
  };
}

/** The lane pool keys the hopper issued (issue #1454): one per user at most, only its hash. */
export function createLanePoolKeyRepository(c: StoreContext): LanePoolKeyRepository {
  return {
    replace(keyHash, userId, issuedAt) {
      c.tx(() => {
        c.db.run('DELETE FROM lane_pool_keys WHERE user_id = ?', userId);
        c.db.run('INSERT INTO lane_pool_keys (key_hash, user_id, created_at) VALUES (?, ?, ?)', keyHash, userId, issuedAt);
      });
    },
    userOf(keyHash) {
      const r = c.db.get('SELECT user_id FROM lane_pool_keys WHERE key_hash = ?', keyHash);
      return r ? String(r.user_id) : undefined;
    },
    issuedAt(userId) {
      const r = c.db.get('SELECT created_at FROM lane_pool_keys WHERE user_id = ? ORDER BY created_at DESC LIMIT 1', userId);
      return r ? String(r.created_at) : undefined;
    },
    remove(userId) {
      return c.db.get('DELETE FROM lane_pool_keys WHERE user_id = ? RETURNING key_hash', userId) !== undefined;
    },
  };
}
