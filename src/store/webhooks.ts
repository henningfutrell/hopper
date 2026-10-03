import type { WebhookRepository } from '../domain/ports.ts';
import type { WebhookDelivery, WebhookSubscription } from '../domain/types.ts';
import { applyPatch, parse, type StoreContext } from './context.ts';

const toSub = (r: Record<string, unknown>): WebhookSubscription => ({
  id: r.id as string, name: r.name as string, url: r.url as string, events: parse(r.events), secret: r.secret as string,
  active: r.active === 1, createdAt: r.created_at as string,
});

export function createWebhookRepository(c: StoreContext): WebhookRepository {
  const getDelivery = (id: string): WebhookDelivery | undefined => {
    const r = c.db.prepare('SELECT body FROM deliveries WHERE id = ?').get(id);
    return r ? parse<WebhookDelivery>(r.body) : undefined;
  };
  const saveDelivery = (d: WebhookDelivery, insert: boolean): void => {
    const body = JSON.stringify(d);
    if (insert) {
      c.db.prepare('INSERT INTO deliveries (id, subscription_id, status, next_attempt_at, body) VALUES (?, ?, ?, ?, ?)')
        .run(d.id, d.subscriptionId, d.status, d.nextAttemptAt ?? null, body);
    } else {
      c.db.prepare('UPDATE deliveries SET status = ?, next_attempt_at = ?, body = ? WHERE id = ?')
        .run(d.status, d.nextAttemptAt ?? null, body, d.id);
    }
  };

  return {
    upsertByName(input) {
      c.db.prepare(
        `INSERT INTO webhooks (id, name, url, events, secret, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (name) DO UPDATE SET url = excluded.url, events = excluded.events,
           secret = excluded.secret, active = excluded.active`,
      ).run(c.idGen(), input.name, input.url, JSON.stringify(input.events), input.secret, input.active ? 1 : 0, c.clock.now().toISOString());
      return toSub(c.db.prepare('SELECT * FROM webhooks WHERE name = ?').get(input.name)!);
    },
    get(id) {
      const r = c.db.prepare('SELECT * FROM webhooks WHERE id = ?').get(id);
      return r ? toSub(r) : undefined;
    },
    list() {
      return c.db.prepare('SELECT * FROM webhooks ORDER BY seq').all().map(toSub);
    },
    delete(id) {
      return c.tx(() => {
        const gone = c.db.prepare('DELETE FROM webhooks WHERE id = ?').run(id).changes > 0;
        if (!gone) return false;
        const at = c.clock.now().toISOString();
        const open = c.db.prepare("SELECT body FROM deliveries WHERE subscription_id = ? AND status IN ('pending', 'retrying')").all(id);
        for (const r of open) {
          saveDelivery({ ...parse<WebhookDelivery>(r.body), status: 'failed', nextAttemptAt: undefined, updatedAt: at }, false);
        }
        return true;
      });
    },
    createDelivery(subscriptionId, event) {
      const at = c.clock.now().toISOString();
      const d: WebhookDelivery = {
        id: c.idGen(), subscriptionId, eventSeq: event.seq, eventType: event.type,
        status: 'pending', attempts: 0, nextAttemptAt: at, createdAt: at, updatedAt: at,
      };
      saveDelivery(d, true);
      return d;
    },
    updateDelivery(id, patch) {
      const cur = getDelivery(id);
      if (!cur) throw new Error(`delivery not found: ${id}`);
      const next: WebhookDelivery = { ...applyPatch<WebhookDelivery>(cur, patch), updatedAt: c.clock.now().toISOString() };
      saveDelivery(next, false);
      return next;
    },
    dueDeliveries(now) {
      return c.db.prepare(
        "SELECT body FROM deliveries WHERE status IN ('pending', 'retrying') AND next_attempt_at <= ? ORDER BY next_attempt_at, seq",
      ).all(now.toISOString()).map((r) => parse<WebhookDelivery>(r.body));
    },
    listDeliveries(filter) {
      const where = filter?.subscriptionId !== undefined ? 'WHERE subscription_id = ?' : '';
      const limit = filter?.limit !== undefined ? 'LIMIT ?' : '';
      const args = [...(filter?.subscriptionId !== undefined ? [filter.subscriptionId] : []), ...(filter?.limit !== undefined ? [filter.limit] : [])];
      return c.db.prepare(`SELECT body FROM deliveries ${where} ORDER BY seq DESC ${limit}`).all(...args)
        .map((r) => parse<WebhookDelivery>(r.body));
    },
  };
}
