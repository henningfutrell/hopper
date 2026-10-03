// webhooks.yaml: the source of truth for webhook subscriptions. Loaded at startup and
// re-read when its mtime changes; reconciled by `name` into the store.
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { parse } from 'yaml';
import { z } from 'zod';
import type { Clock, Store } from '../domain/ports.ts';
import { EVENT_TYPES } from '../domain/types.ts';

export interface WebhookConfig { name: string; url: string; events: string[]; secret: string; active: boolean }
export type LoadResult = { webhooks: WebhookConfig[]; warnings: string[] } | { error: string };

const eventName = z.string().refine((e) => e === '*' || (EVENT_TYPES as readonly string[]).includes(e), {
  message: 'must be an event type or "*"',
});
const entry = z.strictObject({
  name: z.string().min(1),
  url: z.url({ protocol: /^https?$/ }),
  events: z.array(eventName).min(1),
  secret: z.string().min(1).optional(),
  secretFile: z.string().min(1).optional(),
  active: z.boolean().default(true),
}).refine((e) => (e.secret === undefined) !== (e.secretFile === undefined), {
  message: 'give exactly one of secret or secretFile',
});
const FILE = z.strictObject({ version: z.literal(1), webhooks: z.array(entry) }).superRefine((f, ctx) => {
  const seen = new Set<string>();
  for (const w of f.webhooks) {
    if (seen.has(w.name)) ctx.addIssue({ code: 'custom', message: `duplicate name "${w.name}"` });
    seen.add(w.name);
  }
});

const expandHome = (p: string): string => (p === '~' || p.startsWith('~/') ? homedir() + p.slice(1) : p);

export function loadWebhooksFile(path: string): LoadResult {
  let text: string;
  let mode: number;
  try {
    text = readFileSync(path, 'utf8');
    mode = statSync(path).mode;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { webhooks: [], warnings: ['no webhooks file'] };
    return { error: `cannot read ${path}: ${(e as Error).message}` };
  }
  let raw: unknown;
  try { raw = parse(text); } catch (e) { return { error: `${path}: ${(e as Error).message}` }; }
  const parsed = FILE.safeParse(raw);
  if (!parsed.success) {
    return { error: `${path}: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'file'}: ${i.message}`).join('; ')}` };
  }
  const warnings: string[] = [];
  const webhooks: WebhookConfig[] = [];
  for (const w of parsed.data.webhooks) {
    let secret = w.secret;
    if (w.secretFile !== undefined) {
      const sf = expandHome(w.secretFile);
      try { secret = readFileSync(sf, 'utf8').trim(); } catch (e) {
        return { error: `webhook "${w.name}": cannot read secretFile ${sf}: ${(e as Error).message}` };
      }
      if (!secret) return { error: `webhook "${w.name}": secretFile ${sf} is empty` };
    } else if (mode & 0o077) {
      warnings.push(`webhook "${w.name}": inline secret in a file readable by group/other (chmod 600 ${path})`);
    }
    webhooks.push({ name: w.name, url: w.url, events: w.events, secret: secret as string, active: w.active });
  }
  return { webhooks, warnings };
}

export interface WebhookConfigStatus { path: string; loadedAt?: string; error?: string; warnings: string[] }

export interface WebhookConfigWatcher {
  start(): void;
  stop(): void;
  status(): WebhookConfigStatus;
  /** Re-read now, whatever the mtime. */
  reload(): void;
}

export function createWebhookConfigWatcher(o: {
  path: string; store: Pick<Store, 'webhooks'>; clock: Clock; intervalMs: number;
}): WebhookConfigWatcher {
  const { path, store, clock } = o;
  let timer: NodeJS.Timeout | undefined;
  let signature: string | undefined;
  const state: WebhookConfigStatus = { path, warnings: [] };

  const sign = (): string => {
    try { const s = statSync(path); return `${s.mtimeMs}:${s.size}`; } catch { return 'missing'; }
  };

  function reload(): void {
    signature = sign();
    const r = loadWebhooksFile(path);
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
    status: () => ({ ...state, warnings: [...state.warnings] }),
    reload,
  };
}
