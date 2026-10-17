// Notifier deliveries (issue #1587, a tenant migration, design.md "Grok Bot routine webhook"): one row per notification, the
// body as JSON, with the columns read by — whose, its key, its status and when it is due.
import type { NotifierDelivery, NotifierDeliveryRepository } from '../domain/notifier-deliveries.ts';
import { applyPatch, parse, type StoreContext } from './context.ts';

export const NOTIFIER_DELIVERY_TABLE = `
  CREATE TABLE notifier_deliveries (
    seq BIGSERIAL PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    notifier TEXT NOT NULL,
    delivery_key TEXT NOT NULL,
    status TEXT NOT NULL,
    next_attempt_at TEXT,
    updated_at TEXT NOT NULL,
    body TEXT NOT NULL,
    UNIQUE (notifier, delivery_key)
  );
  CREATE INDEX notifier_deliveries_due ON notifier_deliveries (notifier, status, next_attempt_at)`;

export function createNotifierDeliveryRepository(c: StoreContext): NotifierDeliveryRepository {
  const get = (id: string): NotifierDelivery | undefined => {
    const r = c.db.get('SELECT body FROM notifier_deliveries WHERE id = ?', id);
    return r ? parse<NotifierDelivery>(r.body) : undefined;
  };
  return {
    add(input) {
      const at = c.clock.now().toISOString();
      const d: NotifierDelivery = { ...input, id: c.idGen(), status: 'pending', attempts: 0, nextAttemptAt: at, createdAt: at, updatedAt: at };
      const added = c.db.run(
        `INSERT INTO notifier_deliveries (id, notifier, delivery_key, status, next_attempt_at, updated_at, body) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (notifier, delivery_key) DO NOTHING`,
        d.id, d.notifier, d.key, d.status, at, at, JSON.stringify(d)).changes > 0;
      return added ? d : undefined;
    },
    update(id, patch) {
      const cur = get(id);
      if (!cur) return undefined;
      const next: NotifierDelivery = { ...applyPatch<NotifierDelivery>(cur, patch), updatedAt: c.clock.now().toISOString() };
      c.db.run('UPDATE notifier_deliveries SET status = ?, next_attempt_at = ?, updated_at = ?, body = ? WHERE id = ?',
        next.status, next.nextAttemptAt ?? null, next.updatedAt, JSON.stringify(next), id);
      return next;
    },
    due: (notifier, now) => c.db.all(
      "SELECT body FROM notifier_deliveries WHERE notifier = ? AND status IN ('pending', 'retrying') AND next_attempt_at <= ? ORDER BY next_attempt_at, seq",
      notifier, now.toISOString()).map((r) => parse<NotifierDelivery>(r.body)),
    prune: (before) => c.db.run("DELETE FROM notifier_deliveries WHERE status IN ('delivered', 'failed') AND updated_at < ?", before).changes,
  };
}
