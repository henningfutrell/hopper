// Grants and their refresh tokens (issue #881, design.md "Grants and refresh tokens"): a grant's body as JSON, keyed by
// its id; each refresh token only as its SHA-256, a rotated one kept for reuse detection until its grant goes.
import type { ApiGrantRepository, ApiGrantRow, RefreshTokenRow } from '../domain/api-grants.ts';
import type { StoreContext } from './context.ts';

const grantOf = (r: Record<string, unknown>): ApiGrantRow => JSON.parse(String(r.body)) as ApiGrantRow;

export function createApiGrantRepository(c: StoreContext): ApiGrantRepository {
  return {
    create(grant, refreshHash) {
      c.tx(() => {
        c.db.run('INSERT INTO api_grants (id, user_id, body) VALUES (?, ?, ?)', grant.id, grant.userId, JSON.stringify(grant));
        c.db.run('INSERT INTO api_grant_tokens (token_hash, grant_id, issued_at) VALUES (?, ?, ?)', refreshHash, grant.id, grant.createdAt);
      });
    },
    get(id) {
      const r = c.db.get('SELECT body FROM api_grants WHERE id = ?', id);
      return r ? grantOf(r) : undefined;
    },
    all() {
      return c.db.all('SELECT body FROM api_grants ORDER BY id').map(grantOf);
    },
    update(grant) {
      c.db.run('UPDATE api_grants SET body = ? WHERE id = ?', JSON.stringify(grant), grant.id);
    },
    drop(id) {
      c.tx(() => {
        c.db.run('DELETE FROM api_grant_tokens WHERE grant_id = ?', id);
        c.db.run('DELETE FROM api_grants WHERE id = ?', id);
      });
    },
    refreshToken(tokenHash) {
      const r = c.db.get('SELECT * FROM api_grant_tokens WHERE token_hash = ?', tokenHash);
      if (!r) return undefined;
      const row: RefreshTokenRow = { tokenHash: String(r.token_hash), grantId: String(r.grant_id), issuedAt: String(r.issued_at) };
      return r.rotated_at === null || r.rotated_at === undefined ? row : { ...row, rotatedAt: String(r.rotated_at) };
    },
    rotate(oldHash, newHash, at) {
      c.tx(() => {
        const old = c.db.get('SELECT grant_id FROM api_grant_tokens WHERE token_hash = ?', oldHash);
        if (!old) throw new Error('no such refresh token');
        c.db.run('UPDATE api_grant_tokens SET rotated_at = ? WHERE token_hash = ?', at, oldHash);
        c.db.run('INSERT INTO api_grant_tokens (token_hash, grant_id, issued_at) VALUES (?, ?, ?)', newHash, String(old.grant_id), at);
      });
    },
    tokenMinutes() {
      const r = c.db.get("SELECT value FROM settings WHERE key = 'apiTokenMinutes'");
      return r ? Number(r.value) : undefined;
    },
    setTokenMinutes(minutes) {
      c.db.run("INSERT INTO settings (key, value) VALUES ('apiTokenMinutes', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", String(minutes));
    },
  };
}
