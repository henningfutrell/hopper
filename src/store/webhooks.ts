import type { WebhookRepository } from '../domain/ports.ts';
import type { WebhookDelivery, WebhookSubscription } from '../domain/types.ts';
import { applyPatch, parse, type StoreContext } from './context.ts';

// The signing secret is a system secret in the user's vault (issue #658); a row's copy from before is read only to move it.
const toSub = (r: Record<string, unknown>): WebhookSubscription => ({
  id: r.id as string, name: r.name as string, url: r.url as string, events: parse(r.events),
  ...(r.secret_env ? { secretEnv: r.secret_env as string } : {}),
  ...(r.secret_changed_at ? { secretChangedAt: r.secret_changed_at as string } : {}),
  active: r.active === 1, createdAt: r.created_at as string,
});
const COLUMNS = 'id, name, url, events, secret_env, secret_changed_at, active, created_at';

export function createWebhookRepository(c: StoreContext): WebhookRepository {
  const getDelivery = (id: string): WebhookDelivery | undefined => {
    const r = c.db.get('SELECT body FROM deliveries WHERE id = ?', id);
    return r ? parse<WebhookDelivery>(r.body) : undefined;
  };
  const saveDelivery = (d: WebhookDelivery, insert: boolean): void => {
    const body = JSON.stringify(d);
    if (insert) {
      c.db.run('INSERT INTO deliveries (id, subscription_id, status, next_attempt_at, body) VALUES (?, ?, ?, ?, ?)', d.id, d.subscriptionId, d.status, d.nextAttemptAt ?? null, body);
    } else {
      c.db.run('UPDATE deliveries SET status = ?, next_attempt_at = ?, body = ? WHERE id = ?', d.status, d.nextAttemptAt ?? null, body, d.id);
    }
  };

  return {
    add(input) {
      const id = c.idGen();
      const added = c.db.run(
        `INSERT INTO webhooks (id, name, url, events, active, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (name) DO NOTHING`,
        id, input.name, input.url, JSON.stringify(input.events), input.active ? 1 : 0, c.clock.now().toISOString()).changes > 0;
      return added ? toSub(c.db.get(`SELECT ${COLUMNS} FROM webhooks WHERE id = ?`, id)!) : undefined;
    },
    update(id, patch) {
      const cur = c.db.get(`SELECT ${COLUMNS} FROM webhooks WHERE id = ?`, id);
      if (!cur) return undefined;
      const next = { ...toSub(cur), ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) };
      c.db.run('UPDATE webhooks SET url = ?, events = ?, active = ? WHERE id = ?', next.url, JSON.stringify(next.events), next.active ? 1 : 0, id);
      return toSub(c.db.get(`SELECT ${COLUMNS} FROM webhooks WHERE id = ?`, id)!);
    },
    secretKept(id, changedAt) {
      // Kept in the vault from now on (issue #658): the runtime variable of a subscription from before is no longer read.
      const set = c.db.run("UPDATE webhooks SET secret_sealed = NULL, secret_changed_at = ?, secret_env = '' WHERE id = ?",
        changedAt ?? c.clock.now().toISOString(), id).changes > 0;
      return set ? toSub(c.db.get(`SELECT ${COLUMNS} FROM webhooks WHERE id = ?`, id)!) : undefined;
    },
    legacySecret(id) {
      const r = c.db.get('SELECT secret_sealed FROM webhooks WHERE id = ?', id);
      return (r?.secret_sealed as string | null | undefined) ?? undefined;
    },
    get(id) {
      const r = c.db.get(`SELECT ${COLUMNS} FROM webhooks WHERE id = ?`, id);
      return r ? toSub(r) : undefined;
    },
    list() {
      return c.db.all(`SELECT ${COLUMNS} FROM webhooks ORDER BY seq`).map(toSub);
    },
    delete(id) {
      return c.tx(() => {
        const gone = c.db.run('DELETE FROM webhooks WHERE id = ?', id).changes > 0;
        if (!gone) return false;
        const at = c.clock.now().toISOString();
        const open = c.db.all("SELECT body FROM deliveries WHERE subscription_id = ? AND status IN ('pending', 'retrying')", id);
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
      return c.db.all(
        "SELECT body FROM deliveries WHERE status IN ('pending', 'retrying') AND next_attempt_at <= ? ORDER BY next_attempt_at, seq",
        now.toISOString()).map((r) => parse<WebhookDelivery>(r.body));
    },
    listDeliveries(filter) {
      const where = filter?.subscriptionId !== undefined ? 'WHERE subscription_id = ?' : '';
      const limit = filter?.limit !== undefined ? 'LIMIT ?' : '';
      const args = [...(filter?.subscriptionId !== undefined ? [filter.subscriptionId] : []), ...(filter?.limit !== undefined ? [filter.limit] : [])];
      return c.db.all(`SELECT body FROM deliveries ${where} ORDER BY seq DESC ${limit}`, ...args)
        .map((r) => parse<WebhookDelivery>(r.body));
    },
  };
}
