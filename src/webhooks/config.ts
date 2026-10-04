// webhooks.yaml: the source of truth for webhook subscriptions, a config document in the store
// (design.md "Config documents"). Loaded at startup and re-read when its version changes;
// reconciled by `name` into the store's subscriptions. Every secret comes from the runtime (design.md
// "Secrets", issue #56): an entry names the variable its secret is in (`secretEnv`), and the
// dispatcher reads it at each delivery. Neither the document nor the store holds a secret.
import { parse } from 'yaml';
import { z } from 'zod';
import type { Clock, ConfigDocuments, Store } from '../domain/ports.ts';
import { EVENT_TYPES } from '../domain/types.ts';

export interface WebhookConfig { name: string; url: string; events: string[]; secretEnv: string; active: boolean }
export type LoadResult = { webhooks: WebhookConfig[]; warnings: string[] } | { error: string };

const eventName = z.string().refine((e) => e === '*' || (EVENT_TYPES as readonly string[]).includes(e), {
  message: 'must be an event type or "*"',
});
const NO_INLINE = 'the hopper keeps no secret (issue #56): put it in the runtime (a variable, or a mounted file named by <variable>_FILE) and name the variable with secretEnv';
const entry = z.strictObject({
  name: z.string().min(1),
  url: z.url({ protocol: /^https?$/ }),
  events: z.array(eventName).min(1),
  secret: z.never({ error: NO_INLINE }).optional(),
  secretEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'an environment variable name'),
  active: z.boolean().default(true),
});
const FILE = z.strictObject({ version: z.literal(1), webhooks: z.array(entry) }).superRefine((f, ctx) => {
  const seen = new Set<string>();
  for (const w of f.webhooks) {
    if (seen.has(w.name)) ctx.addIssue({ code: 'custom', message: `duplicate name "${w.name}"` });
    seen.add(w.name);
  }
});

/** Why a parsed webhooks.yaml is refused, or undefined when it is valid. */
export function webhooksFileProblem(raw: unknown): string | undefined {
  const parsed = FILE.safeParse(raw);
  return parsed.success ? undefined : parsed.error.issues.map((i) => `${i.path.join('.') || 'file'}: ${i.message}`).join('; ');
}

export const WEBHOOKS = 'webhooks.yaml';

/** A subscription's secret from the runtime; throws, naming the variable, when the runtime gives none. */
export function subscriptionSecret(secret: (name: string) => string | undefined, secretEnv: string): string {
  const value = secret(secretEnv);
  if (!value) throw new Error(`${secretEnv || 'its secret variable'} is not set`);
  return value;
}

/** The webhooks document's text (undefined: none yet) as subscriptions, each naming its secret's variable. */
export function loadWebhooksFile(text: string | undefined): LoadResult {
  if (text === undefined) return { webhooks: [], warnings: [`no ${WEBHOOKS} yet`] };
  let raw: unknown;
  try { raw = parse(text); } catch (e) { return { error: `${WEBHOOKS}: ${(e as Error).message}` }; }
  const parsed = FILE.safeParse(raw);
  if (!parsed.success) return { error: `${WEBHOOKS}: ${webhooksFileProblem(raw)}` };
  const webhooks = parsed.data.webhooks.map((w) => ({ name: w.name, url: w.url, events: w.events, secretEnv: w.secretEnv, active: w.active }));
  return { webhooks, warnings: [] };
}

export interface WebhookConfigStatus {
  /** The config document: `webhooks.yaml`. */
  document: string; loadedAt?: string; error?: string; warnings: string[];
  /** The document's version now, for a UI edit. */
  version: string;
}

export interface WebhookConfigWatcher {
  start(): void;
  stop(): void;
  status(): WebhookConfigStatus;
  /** Why the runtime gives no secret in `secretEnv`, or undefined when it does. Never the secret. */
  secretProblem(secretEnv: string): string | undefined;
  /** Re-read now, whatever the version. */
  reload(): void;
}

export function createWebhookConfigWatcher(o: {
  documents: ConfigDocuments; store: Pick<Store, 'webhooks'>; clock: Clock; intervalMs: number;
  /** The runtime's secrets (src/secrets/runtime.ts). */
  secret: (name: string) => string | undefined;
}): WebhookConfigWatcher {
  const { documents, store, clock } = o;
  let timer: NodeJS.Timeout | undefined;
  let signature: string | undefined;
  const state: Omit<WebhookConfigStatus, 'version'> = { document: WEBHOOKS, warnings: [] };

  const sign = (): string => documents.version(WEBHOOKS);

  function reload(): void {
    signature = sign();
    const r = loadWebhooksFile(documents.read(WEBHOOKS));
    if ('error' in r) { state.error = r.error; return; }
    const names = new Set(r.webhooks.map((w) => w.name));
    for (const w of r.webhooks) store.webhooks.upsertByName(w);
    for (const s of store.webhooks.list()) if (!names.has(s.name)) store.webhooks.delete(s.id);
    delete state.error;
    state.warnings = r.warnings;
    state.loadedAt = clock.now().toISOString();
  }

  return {
    start() {
      if (timer) return;
      reload();
      timer = setInterval(() => { if (sign() !== signature) reload(); }, o.intervalMs);
      timer.unref();
    },
    stop() { if (timer) clearInterval(timer); timer = undefined; },
    status: () => ({ ...state, warnings: [...state.warnings], version: sign() }),
    secretProblem(secretEnv) {
      try { subscriptionSecret(o.secret, secretEnv); return undefined; } catch (e) { return (e as Error).message; }
    },
    reload,
  };
}
