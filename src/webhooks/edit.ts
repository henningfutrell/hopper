// A UI edit of the webhook subscriptions (design.md "Webhook subscriptions in the UI", issue #18): add,
// edit or remove one, and replace or rotate its signing secret. The store's table is the only place they
// are kept (issue #78): each edit checks the subscription and writes its row. The signing secret is the
// hopper's own (issue #451): typed in or made here, kept in the vault's system scope (issue #658, src/webhooks/secrets.ts), and never
// answered back — except one the hopper made, in the result of the edit that made it, to copy to the
// receiver once. Each change of a secret is logged by name and how, never with the value.
import { z } from 'zod';
import type { UserStore } from '../domain/ports.ts';
import { EVENT_TYPES, type WebhooksEdit } from '../domain/types.ts';
import { makeSecret, type WebhookSecrets } from './secrets.ts';

export type WebhooksEditRefusal = { ok: false; code: 'invalid' | 'not_found' | 'conflict' | 'unavailable'; error: string };
/** `generatedSecret`: the secret the hopper made for this edit (add with none typed in, rotate). Shown once. */
export type WebhooksEditResult = { ok: true; generatedSecret?: string } | WebhooksEditRefusal;

export interface WebhooksEditor {
  /** `by`: who edits, named in the vault's events. */
  edit(e: WebhooksEdit, by?: string): WebhooksEditResult;
}

const refuse = (code: WebhooksEditRefusal['code'], error: string): WebhooksEditRefusal => ({ ok: false, code, error });

const eventName = z.string().refine((e) => e === '*' || (EVENT_TYPES as readonly string[]).includes(e), {
  message: 'must be an event type or "*"',
});
/** What an edit may change. */
const editable = { url: z.url({ protocol: /^https?$/ }), events: z.array(eventName).min(1), active: z.boolean() };
/** A new subscription: also its name, fixed once added. */
const added = z.strictObject({ name: z.string().min(1), ...editable });
const edited = z.strictObject(editable);
/** A signing secret typed in: long enough to be a key, printable, no spaces. The value is never in a message. */
const typedSecret = z.strictObject({
  secret: z.string().min(32, 'at least 32 characters (or leave it out: the hopper makes one)').max(4096, 'at most 4096 characters')
    .regex(/^[\x21-\x7e]+$/, 'printable ASCII, no spaces'),
});

/** Why `value` is refused by `schema`, or undefined. */
function problem(schema: z.ZodType, value: unknown): string | undefined {
  const parsed = schema.safeParse(value);
  return parsed.success ? undefined : parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
}

export function createWebhooksEditor(o: {
  store: Pick<UserStore, 'webhooks'>;
  secrets: WebhookSecrets;
  logger: { info(line: string): void };
}): WebhooksEditor {
  const { webhooks } = o.store;

  /** The secret to store: the one typed in (checked), or a new one the hopper makes. */
  function secretOf(typed: string | undefined): { value: string; made: boolean } | WebhooksEditRefusal {
    if (typed === undefined) return { value: makeSecret(), made: true };
    const why = problem(typedSecret, { secret: typed });
    return why ? refuse('invalid', why) : { value: typed, made: false };
  }

  /** Stores `value` as `id`'s secret: the result, the made one shown. */
  function keep(id: string, name: string, s: { value: string; made: boolean }, how: string, by: string): WebhooksEditResult {
    if (!o.secrets.store(id, s.value, by, how === 'rotated')) return refuse('unavailable', o.secrets.unavailable() ?? `no webhook "${name}"`);
    o.logger.info(`hopper: webhook "${name}": signing secret ${how}`);
    return s.made ? { ok: true, generatedSecret: s.value } : { ok: true };
  }

  function edit(e: WebhooksEdit, by = 'a person'): WebhooksEditResult {
    const current = webhooks.list().find((s) => s.name === e.name);
    if (e.action === 'add') {
      const sub = { name: e.name, url: e.url, events: e.events, active: e.active ?? true };
      const why = problem(added, sub);
      if (why) return refuse('invalid', why);
      const secret = secretOf(e.secret);
      if ('ok' in secret) return secret;
      const unavailable = o.secrets.unavailable();
      if (unavailable) return refuse('unavailable', unavailable);
      const row = webhooks.add(sub);
      if (!row) return refuse('conflict', `webhook "${e.name}" already exists`);
      const kept = keep(row.id, row.name, secret, secret.made ? 'made by the hopper' : 'typed in', by);
      if (!kept.ok) webhooks.delete(row.id);
      return kept;
    }
    if (!current) return refuse('not_found', `no webhook "${e.name}"`);
    if (e.action === 'remove') {
      // Its signing secret in the vault goes with it.
      webhooks.delete(current.id);
      o.secrets.forget(current.id, by);
      return { ok: true };
    }
    if (e.action === 'replace' || e.action === 'rotate') {
      const secret = secretOf(e.action === 'replace' ? e.secret : undefined);
      if ('ok' in secret) return secret;
      return keep(current.id, current.name, secret, e.action === 'replace' ? 'replaced' : 'rotated', by);
    }
    const patch = { url: e.url, events: e.events, active: e.active };
    const why = problem(edited, { url: patch.url ?? current.url, events: patch.events ?? current.events, active: patch.active ?? current.active });
    if (why) return refuse('invalid', why);
    return webhooks.update(current.id, patch) ? { ok: true } : refuse('not_found', `no webhook "${e.name}"`);
  }

  return { edit };
}
