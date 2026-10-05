// A UI edit of the webhook subscriptions (design.md "Webhook subscriptions in the UI", issue #18): add,
// edit or remove one. The store's table is the only place they are kept (issue #78): each edit checks
// the subscription and writes its row. No secret passes through here (issue #56): an added
// subscription names the `WEBHOOK_SECRET_*` variable the runtime gives its secret in.
import { z } from 'zod';
import type { UserStore } from '../domain/ports.ts';
import { EVENT_TYPES, type WebhooksEdit } from '../domain/types.ts';
import { UI_SECRET_ENV } from '../domain/webhooks.ts';

export type WebhooksEditRefusal = { ok: false; code: 'invalid' | 'not_found' | 'conflict'; error: string };
export type WebhooksEditResult = { ok: true } | WebhooksEditRefusal;

export interface WebhooksEditor {
  edit(e: WebhooksEdit): WebhooksEditResult;
}

const refuse = (code: WebhooksEditRefusal['code'], error: string): WebhooksEditRefusal => ({ ok: false, code, error });

const eventName = z.string().refine((e) => e === '*' || (EVENT_TYPES as readonly string[]).includes(e), {
  message: 'must be an event type or "*"',
});
/** What an edit may change. */
const editable = { url: z.url({ protocol: /^https?$/ }), events: z.array(eventName).min(1), active: z.boolean() };
/** A new subscription: also its name and its secret's variable, both fixed once added. */
const added = z.strictObject({
  name: z.string().min(1),
  secretEnv: z.string().regex(UI_SECRET_ENV, 'a WEBHOOK_SECRET_* variable (A-Z, 0-9, _)'),
  ...editable,
});
const edited = z.strictObject(editable);

/** Why `value` is refused by `schema`, or undefined. */
function problem(schema: z.ZodType, value: unknown): string | undefined {
  const parsed = schema.safeParse(value);
  return parsed.success ? undefined : parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
}

export function createWebhooksEditor(o: { store: Pick<UserStore, 'webhooks'> }): WebhooksEditor {
  const { webhooks } = o.store;

  function edit(e: WebhooksEdit): WebhooksEditResult {
    const current = webhooks.list().find((s) => s.name === e.name);
    if (e.action === 'add') {
      const sub = { name: e.name, url: e.url, events: e.events, secretEnv: e.secretEnv, active: e.active ?? true };
      const why = problem(added, sub);
      if (why) return refuse('invalid', why);
      return webhooks.add(sub) ? { ok: true } : refuse('conflict', `webhook "${e.name}" already exists`);
    }
    if (!current) return refuse('not_found', `no webhook "${e.name}"`);
    if (e.action === 'remove') {
      webhooks.delete(current.id);
      return { ok: true };
    }
    const patch = { url: e.url, events: e.events, active: e.active };
    const why = problem(edited, { url: patch.url ?? current.url, events: patch.events ?? current.events, active: patch.active ?? current.active });
    if (why) return refuse('invalid', why);
    return webhooks.update(current.id, patch) ? { ok: true } : refuse('not_found', `no webhook "${e.name}"`);
  }

  return { edit };
}
