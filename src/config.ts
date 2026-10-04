// Configuration from env: process settings only (docs/design.md "Settled in slice 4"); every part is
// configured in plugins.yaml. Invalid values fail loudly.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

export interface Config {
  /** The bind address: `127.0.0.1`, or `::` (every interface) when LAN names are set. */
  host: string;
  port: number;
  dbPath: string;
  tickMs: number;
  /** Router mode used only until the store has one. */
  routerMode: 'shadow' | 'active';
  softLimit: number;
  hardLimit: number;
  routerCheapBoost: number;
  webhookBaseMs: number;
  laneIdleGraceMs: number;
  /** The question service's ceiling per stage (answer, assess), whatever a plugin's own timeout says. */
  answerTimeoutMs: number;
  rulesFile: string;
  humanRenotifyMs: number;
  humanTimeoutMs: number;
  resumeBoost: number;
  maxQuestions: number;
  /** Keep panes open after a job ends (for inspection); default false: every terminal outcome cleans up. */
  keepPanes: boolean;
  /** webhooks.yaml: the webhook subscriptions. */
  webhooksFile: string;
  /** Lifetime of a UI session, in hours. */
  uiSessionHours: number;
  /** Custom plugins, one directory each. */
  pluginDir: string;
  /** plugins.yaml: which plugin instance fills which role — every part's configuration. */
  pluginsFile: string;
  /** auth.yaml: how people sign in (design.md "Sign-in: local, OIDC and SAML"). */
  authFile: string;
  /** The URL people reach the UI at through a reverse proxy (origin only), or undefined. The sign-in origin when set. */
  publicUrl: string | undefined;
  /** Host names the UI answers to on the LAN (lowercase, no port); empty: loopback only. */
  lanNames: string[];
  /** CIDR ranges a LAN request may come from. */
  lanPeers: string[];
  /** How often the self-update checks the update repository; 0: only when asked (design.md "Self-update"). */
  updateCheckMs: number;
  /** Forces how the daemon starts again after an update: `exit` (a supervisor restarts it) or `respawn`; absent: detected. */
  restart?: 'exit' | 'respawn';
  /**
   * Every set JOB_HOPPER_* variable this config does not read, raw: the part-choosing ones removed
   * in phase 5 slices 4 and 5 (read once more by the plugins.yaml migration) and any unknown one. The
   * daemon warns about them at boot.
   */
  leftoverEnv: Record<string, string>;
}

const expandHome = (p: string): string => (p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);

const int = (min: number, max = Number.MAX_SAFE_INTEGER) => z.coerce.number().int().min(min).max(max);
const fraction = () => z.coerce.number().min(0).max(1);
const path = (fallback: string) => z.string().min(1).default(fallback).transform(expandHome);
const flag = (fallback: boolean) => z.enum(['true', 'false']).default(fallback ? 'true' : 'false').transform((v) => v === 'true');
const list = (item: z.ZodType<string, string>) => z.string().default('')
  .transform((v) => v.split(',').map((x) => x.trim().toLowerCase()).filter((x) => x !== ''))
  .pipe(z.array(item));
// A host name or IP literal, no port; never a loopback name (those are always served).
const lanName = z.string().regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/, 'must be host names or IPv4 addresses, comma-separated, no port')
  .refine((n) => n !== 'localhost' && !n.startsWith('127.'), 'loopback is always served; list LAN names only');
const lanPeer = z.union([z.cidrv4(), z.cidrv6()], { error: 'must be CIDR ranges, comma-separated (192.0.2.0/24)' });
// An origin only: http(s), no path, no query; never loopback (those are always served).
const publicUrl = z.url({ protocol: /^https?$/, error: 'must be an http(s) URL' })
  .refine((u) => { const x = new URL(u); return (x.pathname === '/' || x.pathname === '') && x.search === '' && x.hash === ''; }, 'must be an origin only: scheme, host and port, no path')
  .refine((u) => !['localhost', '127.0.0.1', '[::1]'].includes(new URL(u).hostname), 'loopback is always served; name the public host')
  .transform((u) => new URL(u).origin);
const schema = z.object({
  JOB_HOPPER_AUTH_FILE: path('~/.config/job-hopper/auth.yaml'),
  JOB_HOPPER_PUBLIC_URL: publicUrl.optional(),
  // Loopback, plus the LAN names when set (AGENTS.md, design.md "Reaching the UI across the LAN").
  JOB_HOPPER_LAN_NAMES: list(lanName),
  JOB_HOPPER_LAN_PEERS: list(lanPeer),
  JOB_HOPPER_PORT: int(0, 65535).default(4790),
  JOB_HOPPER_DB: path('~/.local/share/job-hopper/job-hopper.db'),
  JOB_HOPPER_TICK_MS: int(1).default(2000),
  JOB_HOPPER_ROUTER_MODE: z.enum(['shadow', 'active']).default('shadow'),
  JOB_HOPPER_SOFT_LIMIT: fraction().default(0.7),
  JOB_HOPPER_HARD_LIMIT: fraction().default(0.95),
  JOB_HOPPER_ROUTER_CHEAP_BOOST: z.coerce.number().default(10),
  JOB_HOPPER_WEBHOOK_BASE_MS: int(1).default(1000),
  JOB_HOPPER_LANE_IDLE_GRACE_MS: int(0).default(5000),
  JOB_HOPPER_ANSWER_TIMEOUT_MS: int(1).default(180000),
  JOB_HOPPER_RULES_FILE: path('~/.config/job-hopper/rules.md'),
  JOB_HOPPER_HUMAN_RENOTIFY_MS: int(1).default(900000),
  JOB_HOPPER_HUMAN_TIMEOUT_MS: int(1).default(86400000),
  JOB_HOPPER_RESUME_BOOST: z.coerce.number().finite().default(20),
  JOB_HOPPER_MAX_QUESTIONS: int(0).default(5),
  JOB_HOPPER_KEEP_PANES: flag(false),
  JOB_HOPPER_WEBHOOKS_FILE: path('~/.config/job-hopper/webhooks.yaml'),
  JOB_HOPPER_UI_SESSION_HOURS: z.coerce.number().finite().positive().default(12),
  JOB_HOPPER_PLUGIN_DIR: path('~/.config/job-hopper/plugins'),
  JOB_HOPPER_PLUGINS_FILE: path('~/.config/job-hopper/plugins.yaml'),
  JOB_HOPPER_UPDATE_CHECK_MS: int(0).default(900000),
  JOB_HOPPER_RESTART: z.enum(['exit', 'respawn']).optional(),
}).refine((e) => e.JOB_HOPPER_SOFT_LIMIT < e.JOB_HOPPER_HARD_LIMIT, {
  message: 'must be below JOB_HOPPER_HARD_LIMIT',
  path: ['JOB_HOPPER_SOFT_LIMIT'],
}).refine((e) => e.JOB_HOPPER_LAN_NAMES.length === 0 || e.JOB_HOPPER_LAN_PEERS.length > 0, {
  message: 'must be set with JOB_HOPPER_LAN_NAMES: the ranges LAN requests may come from',
  path: ['JOB_HOPPER_LAN_PEERS'],
}).refine((e) => e.JOB_HOPPER_LAN_PEERS.length === 0 || e.JOB_HOPPER_LAN_NAMES.length > 0 || e.JOB_HOPPER_PUBLIC_URL !== undefined, {
  message: 'must be set with JOB_HOPPER_LAN_PEERS (or set JOB_HOPPER_PUBLIC_URL): the names the UI answers to beyond loopback',
  path: ['JOB_HOPPER_LAN_NAMES'],
});

const READ = new Set(Object.keys(schema.shape));

/**
 * Reads only JOB_HOPPER_* keys; empty strings count as unset. Throws on any invalid value of a key
 * it reads; the rest go to `leftoverEnv` unvalidated.
 */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const set = Object.entries(env).filter((e): e is [string, string] => e[0].startsWith('JOB_HOPPER_') && e[1] !== undefined && e[1] !== '');
  const relevant = Object.fromEntries(set.filter(([k]) => READ.has(k)));
  const leftoverEnv = Object.fromEntries(set.filter(([k]) => !READ.has(k)));
  const parsed = schema.safeParse(relevant);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`invalid configuration: ${problems}`);
  }
  const e = parsed.data;
  return {
    // Every interface only when requests may come from beyond loopback (LAN peers); a reverse proxy on this host needs none.
    host: e.JOB_HOPPER_LAN_PEERS.length > 0 ? '::' : '127.0.0.1',
    port: e.JOB_HOPPER_PORT,
    dbPath: e.JOB_HOPPER_DB,
    tickMs: e.JOB_HOPPER_TICK_MS,
    routerMode: e.JOB_HOPPER_ROUTER_MODE,
    softLimit: e.JOB_HOPPER_SOFT_LIMIT,
    hardLimit: e.JOB_HOPPER_HARD_LIMIT,
    routerCheapBoost: e.JOB_HOPPER_ROUTER_CHEAP_BOOST,
    webhookBaseMs: e.JOB_HOPPER_WEBHOOK_BASE_MS,
    laneIdleGraceMs: e.JOB_HOPPER_LANE_IDLE_GRACE_MS,
    answerTimeoutMs: e.JOB_HOPPER_ANSWER_TIMEOUT_MS,
    rulesFile: e.JOB_HOPPER_RULES_FILE,
    humanRenotifyMs: e.JOB_HOPPER_HUMAN_RENOTIFY_MS,
    humanTimeoutMs: e.JOB_HOPPER_HUMAN_TIMEOUT_MS,
    resumeBoost: e.JOB_HOPPER_RESUME_BOOST,
    maxQuestions: e.JOB_HOPPER_MAX_QUESTIONS,
    keepPanes: e.JOB_HOPPER_KEEP_PANES,
    webhooksFile: e.JOB_HOPPER_WEBHOOKS_FILE,
    uiSessionHours: e.JOB_HOPPER_UI_SESSION_HOURS,
    pluginDir: e.JOB_HOPPER_PLUGIN_DIR,
    pluginsFile: e.JOB_HOPPER_PLUGINS_FILE,
    authFile: e.JOB_HOPPER_AUTH_FILE,
    publicUrl: e.JOB_HOPPER_PUBLIC_URL,
    lanNames: e.JOB_HOPPER_LAN_NAMES,
    lanPeers: e.JOB_HOPPER_LAN_PEERS,
    updateCheckMs: e.JOB_HOPPER_UPDATE_CHECK_MS,
    ...(e.JOB_HOPPER_RESTART ? { restart: e.JOB_HOPPER_RESTART } : {}),
    leftoverEnv,
  };
}
