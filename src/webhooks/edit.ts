// A UI edit of the webhook subscriptions (design.md "Webhook subscriptions in the UI", issue #18): add,
// edit or remove one. The store's table is the only place they are kept (issue #78): each edit checks
// the subscription and writes its row. No secret passes through here (issue #56): an added
// subscription names the `WEBHOOK_SECRET_*` variable the runtime gives its secret in.
import { z } from 'zod';
import type { Store } from '../domain/ports.ts';
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

/**
 * The text with only the changed entry's bytes rewritten, or undefined for a layout this does not
 * splice (a flow or empty `webhooks` list). Everything outside the change stays as written.
 */
function splice(text: string, doc: Document, c: Change): string | undefined {
  const seq = doc.get('webhooks', true);
  if (!isSeq(seq) || seq.flow || seq.items.length === 0 || !seq.range) return undefined;
  const first = seq.items[0];
  if (!isMap(first) || first.flow || !first.range) return undefined;
  // "  - " before the first key: the item prefix; its width is the indent of the other keys.
  const prefix = text.slice(lineStart(text, first.range[0]), first.range[0]);
  if (!/^ *- +$/.test(prefix)) return undefined;
  const indent = ' '.repeat(prefix.length);
  if (c.kind === 'append') {
    const lines = Object.entries(c.entry).map(([k, v], i) => `${i === 0 ? prefix : indent}${k}: ${inline(v)}\n`).join('');
    return insertAt(text, seq.range[1], lines);
  }
  const map = entryMap(doc, c.at);
  if (map.flow || !map.range) return undefined;
  if (c.kind === 'delete') return text.slice(0, lineStart(text, map.range[0])) + text.slice(map.range[1]);
  const pair = map.items.find((p) => isScalar(p.key) && p.key.value === c.key);
  if (!pair) return insertAt(text, map.range[1], `${indent}${c.key}: ${inline(c.value)}\n`);
  const key = pair.key as Scalar;
  const value = pair.value as { range?: [number, number, number] } | null;
  if (!key.range || !value?.range) return undefined;
  return text.slice(0, key.range[1]) + `: ${inline(c.value)}` + text.slice(value.range[1]);
}

/** True when `text` parses to exactly `js`. */
function means(text: string, js: unknown): boolean {
  try { return isDeepStrictEqual(parse(text), js); } catch { return false; }
}

/** The `webhooks` sequence's entry named `name`, by index, or -1. */
function indexOf(doc: Document, name: string): number {
  const seq = doc.get('webhooks', true);
  return isSeq(seq) ? seq.items.findIndex((item) => isMap(item) && item.get('name') === name) : -1;
}

const CHANGED = `${WEBHOOKS} changed since it was read; reload and edit again`;
const BY_HAND = 'hopper config edit webhooks.yaml';

export function createWebhooksEditor(o: {
  documents: ConfigDocuments;
  /** Re-read the document into the store; runs after every write, before the answer. */
  reload(): void;
}): WebhooksEditor {
  const path = WEBHOOKS;

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
