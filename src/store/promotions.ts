// Promotions to GitHub (issue #946, tenant migration 51): one row each, the record as JSON — where a direct job was
// posted, which artifact revisions it linked, who promoted it and, once revoked, who revoked it. Never the posted text:
// GitHub has it. A new issue or comment on its way is a send (issue #1591, tenant migration 77), a row of its own until it
// becomes the promotion, so the build before never reads one as a live promotion.
import type { Promotion, PromotionRepository, PromotionSend } from '../domain/promotions.ts';
import { parse, type StoreContext } from './context.ts';

export const PROMOTION_TABLE = `
  CREATE TABLE direct_job_promotions (
    seq BIGSERIAL PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    direct_job_id TEXT NOT NULL,
    revoked_at TEXT,
    body TEXT NOT NULL
  );
  CREATE INDEX direct_job_promotions_job ON direct_job_promotions (direct_job_id)`;

export const PROMOTION_SEND_TABLE = `
  CREATE TABLE direct_job_promotion_sends (
    seq BIGSERIAL PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    direct_job_id TEXT NOT NULL,
    body TEXT NOT NULL
  );
  CREATE INDEX direct_job_promotion_sends_job ON direct_job_promotion_sends (direct_job_id)`;

export function createPromotionRepository(c: StoreContext): PromotionRepository {
  const add = (input: Omit<Promotion, 'id'>): Promotion => {
    const p: Promotion = { id: c.idGen(), ...input };
    c.db.run('INSERT INTO direct_job_promotions (id, direct_job_id, revoked_at, body) VALUES (?, ?, ?, ?)', p.id, p.directJobId, p.revokedAt ?? null, JSON.stringify(p));
    return p;
  };
  return {
    add,
    update(p) {
      c.db.run('UPDATE direct_job_promotions SET revoked_at = ?, body = ? WHERE id = ?', p.revokedAt ?? null, JSON.stringify(p), p.id);
    },
    live(directJobId) {
      const r = c.db.get('SELECT body FROM direct_job_promotions WHERE direct_job_id = ? AND revoked_at IS NULL ORDER BY seq DESC LIMIT 1', directJobId);
      return r ? parse<Promotion>(r.body) : undefined;
    },
    sending(input) {
      const s: PromotionSend = { id: c.idGen(), ...input };
      c.db.run('INSERT INTO direct_job_promotion_sends (id, direct_job_id, body) VALUES (?, ?, ?)', s.id, s.directJobId, JSON.stringify(s));
      return s;
    },
    sendOf(directJobId) {
      const r = c.db.get('SELECT body FROM direct_job_promotion_sends WHERE direct_job_id = ? ORDER BY seq DESC LIMIT 1', directJobId);
      return r ? parse<PromotionSend>(r.body) : undefined;
    },
    sends: () => c.db.all('SELECT body FROM direct_job_promotion_sends ORDER BY seq').map((r) => parse<PromotionSend>(r.body)),
    sent: (id, p) => c.tx(() => {
      c.db.run('DELETE FROM direct_job_promotion_sends WHERE id = ?', id);
      return p ? add(p) : undefined;
    }),
  };
}
