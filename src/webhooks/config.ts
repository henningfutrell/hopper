// webhooks.yaml: the source of truth for webhook subscriptions, a config document in the store
// (design.md "Config documents"). Loaded at startup and re-read when its version changes;
// reconciled by `name` into the store's subscriptions.
import { parse } from 'yaml';
import { z } from 'zod';
import type { Clock, ConfigDocuments, Store } from '../domain/ports.ts';
import { EVENT_TYPES } from '../domain/types.ts';

export interface WebhookConfig { name: string; url: string; events: string[]; secret: string; active: boolean }
/** Where a subscription's secret lives: inline in webhooks.yaml, or in the variable its `secretEnv` names. Never the value. */
export type SecretSource = 'inline' | 'env';
export type LoadResult = { webhooks: WebhookConfig[]; warnings: string[]; secretSources: Record<string, SecretSource> } | { error: string };

const eventName = z.string().refine((e) => e === '*' || (EVENT_TYPES as readonly string[]).includes(e), {
  message: 'must be an event type or "*"',
});
const entry = z.strictObject({
  name: z.string().min(1),
  url: z.url({ protocol: /^https?$/ }),
  events: z.array(eventName).min(1),
  secret: z.string().min(1).optional(),
  secretEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'an environment variable name').optional(),
  active: z.boolean().default(true),
}).refine((e) => (e.secret === undefined) !== (e.secretEnv === undefined), {
  message: 'give exactly one of secret or secretEnv',
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

/** The webhooks document's text (undefined: none yet) as subscriptions; a `secretEnv` secret read from `env`. */
export function loadWebhooksFile(text: string | undefined, env: (name: string) => string | undefined): LoadResult {
  if (text === undefined) return { webhooks: [], warnings: [`no ${WEBHOOKS} yet`], secretSources: {} };
  let raw: unknown;
  try { raw = parse(text); } catch (e) { return { error: `${WEBHOOKS}: ${(e as Error).message}` }; }
  const parsed = FILE.safeParse(raw);
  if (!parsed.success) return { error: `${WEBHOOKS}: ${webhooksFileProblem(raw)}` };
  const webhooks: WebhookConfig[] = [];
  const secretSources: Record<string, SecretSource> = {};
  for (const w of parsed.data.webhooks) {
    secretSources[w.name] = w.secretEnv === undefined ? 'inline' : 'env';
    let secret = w.secret;
    if (w.secretEnv !== undefined) {
      secret = env(w.secretEnv)?.trim();
      if (!secret) return { error: `webhook "${w.name}": ${w.secretEnv} is not set` };
    }
    webhooks.push({ name: w.name, url: w.url, events: w.events, secret: secret as string, active: w.active });
  }
  return { webhooks, warnings: [], secretSources };
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
  /** Each subscription's secret source, as last loaded. */
  secretSources(): Record<string, SecretSource>;
  /** Re-read now, whatever the version. */
  reload(): void;
}

export function createWebhookConfigWatcher(o: {
  documents: ConfigDocuments; store: Pick<Store, 'webhooks'>; clock: Clock; intervalMs: number;
  /** Where a `secretEnv` secret is read; default the daemon's environment. */
  env?: (name: string) => string | undefined;
}): WebhookConfigWatcher {
  const { documents, store, clock } = o;
  const env = o.env ?? ((name: string) => process.env[name]);
  let timer: NodeJS.Timeout | undefined;
  let signature: string | undefined;
  const state: Omit<WebhookConfigStatus, 'version'> = { document: WEBHOOKS, warnings: [] };
  let sources: Record<string, SecretSource> = {};

  const sign = (): string => documents.version(WEBHOOKS);

  function reload(): void {
    signature = sign();
    const r = loadWebhooksFile(documents.read(WEBHOOKS), env);
    if ('error' in r) { state.error = r.error; return; }
    const names = new Set(r.webhooks.map((w) => w.name));
    for (const w of r.webhooks) store.webhooks.upsertByName(w);
    for (const s of store.webhooks.list()) if (!names.has(s.name)) store.webhooks.delete(s.id);
    delete state.error;
    state.warnings = r.warnings;
    sources = r.secretSources;
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
    secretSources: () => ({ ...sources }),
    status: () => ({ ...state, warnings: [...state.warnings], version: sign() }),
    reload,
  };
}
