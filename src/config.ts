// Configuration from env: process settings only (docs/design.md "Settled in slice 4"); every part is
// configured in plugins.yaml, a config document in the store; secrets are env too (design.md
// "Secrets"), read by the parts that use them. No default names a path on this machine. Invalid
// values fail loudly.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { parseDatabaseUrl } from './store/db.ts';

export interface Config {
  /** The bind address: `127.0.0.1`, or `::` (every interface) when LAN names are set. */
  host: string;
  port: number;
  /** JOB_HOPPER_DATABASE_URL: `sqlite:<path>` or `postgres://…` (design.md "Database"). Required. */
  databaseUrl: string;
  /** Scratch only — claude's working directory, ssh control sockets, probes; nothing kept. */
  workDir: string;
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
  humanRenotifyMs: number;
  humanTimeoutMs: number;
  resumeBoost: number;
  maxQuestions: number;
  /** Keep panes open after a job ends (for inspection); default false: every terminal outcome cleans up. */
  keepPanes: boolean;
  /** Lifetime of a UI session, in hours. */
  uiSessionHours: number;
  /** Custom plugins, one directory each; unset: none. */
  pluginDir?: string;
  /** Host names the UI answers to on the LAN (lowercase, no port); empty: loopback only. */
  lanNames: string[];
  /** CIDR ranges a LAN request may come from. */
  lanPeers: string[];
  /**
   * Every set JOB_HOPPER_* variable this config does not read, raw: the part-choosing ones removed
   * in phase 5 slices 4 and 5 (read once more by the plugins.yaml migration) and any unknown one. The
   * daemon warns about them at boot.
   */
  leftoverEnv: Record<string, string>;
}

const int = (min: number, max = Number.MAX_SAFE_INTEGER) => z.coerce.number().int().min(min).max(max);
const fraction = () => z.coerce.number().min(0).max(1);
const flag = (fallback: boolean) => z.enum(['true', 'false']).default(fallback ? 'true' : 'false').transform((v) => v === 'true');
const list = (item: z.ZodType<string, string>) => z.string().default('')
  .transform((v) => v.split(',').map((x) => x.trim().toLowerCase()).filter((x) => x !== ''))
  .pipe(z.array(item));
// A host name or IP literal, no port; never a loopback name (those are always served).
const lanName = z.string().regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/, 'must be host names or IPv4 addresses, comma-separated, no port')
  .refine((n) => n !== 'localhost' && !n.startsWith('127.'), 'loopback is always served; list LAN names only');
const lanPeer = z.union([z.cidrv4(), z.cidrv6()], { error: 'must be CIDR ranges, comma-separated (192.0.2.0/24)' });
const schema = z.object({
  // Loopback, plus the LAN names when set (AGENTS.md, design.md "Reaching the UI across the LAN").
  JOB_HOPPER_LAN_NAMES: list(lanName),
  JOB_HOPPER_LAN_PEERS: list(lanPeer),
  JOB_HOPPER_PORT: int(0, 65535).default(4790),
  JOB_HOPPER_DATABASE_URL: z.string({ error: 'required: sqlite:<path> or postgres://user:password@host:port/database' })
    .superRefine((v, ctx) => { try { parseDatabaseUrl(v); } catch (e) { ctx.addIssue({ code: 'custom', message: (e as Error).message }); } }),
  JOB_HOPPER_WORK_DIR: z.string().min(1).default(join(tmpdir(), 'job-hopper')),
  JOB_HOPPER_TICK_MS: int(1).default(2000),
  JOB_HOPPER_ROUTER_MODE: z.enum(['shadow', 'active']).default('shadow'),
  JOB_HOPPER_SOFT_LIMIT: fraction().default(0.7),
  JOB_HOPPER_HARD_LIMIT: fraction().default(0.95),
  JOB_HOPPER_ROUTER_CHEAP_BOOST: z.coerce.number().default(10),
  JOB_HOPPER_WEBHOOK_BASE_MS: int(1).default(1000),
  JOB_HOPPER_LANE_IDLE_GRACE_MS: int(0).default(5000),
  JOB_HOPPER_ANSWER_TIMEOUT_MS: int(1).default(180000),
  JOB_HOPPER_HUMAN_RENOTIFY_MS: int(1).default(900000),
  JOB_HOPPER_HUMAN_TIMEOUT_MS: int(1).default(86400000),
  JOB_HOPPER_RESUME_BOOST: z.coerce.number().finite().default(20),
  JOB_HOPPER_MAX_QUESTIONS: int(0).default(5),
  JOB_HOPPER_KEEP_PANES: flag(false),
  JOB_HOPPER_UI_SESSION_HOURS: z.coerce.number().finite().positive().default(12),
  JOB_HOPPER_PLUGIN_DIR: z.string().min(1).optional(),
}).refine((e) => e.JOB_HOPPER_SOFT_LIMIT < e.JOB_HOPPER_HARD_LIMIT, {
  message: 'must be below JOB_HOPPER_HARD_LIMIT',
  path: ['JOB_HOPPER_SOFT_LIMIT'],
}).refine((e) => e.JOB_HOPPER_LAN_NAMES.length === 0 || e.JOB_HOPPER_LAN_PEERS.length > 0, {
  message: 'must be set with JOB_HOPPER_LAN_NAMES: the ranges LAN requests may come from',
  path: ['JOB_HOPPER_LAN_PEERS'],
}).refine((e) => e.JOB_HOPPER_LAN_PEERS.length === 0 || e.JOB_HOPPER_LAN_NAMES.length > 0, {
  message: 'must be set with JOB_HOPPER_LAN_PEERS: the names the UI answers to on the LAN',
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
    host: e.JOB_HOPPER_LAN_NAMES.length > 0 ? '::' : '127.0.0.1',
    port: e.JOB_HOPPER_PORT,
    databaseUrl: e.JOB_HOPPER_DATABASE_URL,
    workDir: e.JOB_HOPPER_WORK_DIR,
    tickMs: e.JOB_HOPPER_TICK_MS,
    routerMode: e.JOB_HOPPER_ROUTER_MODE,
    softLimit: e.JOB_HOPPER_SOFT_LIMIT,
    hardLimit: e.JOB_HOPPER_HARD_LIMIT,
    routerCheapBoost: e.JOB_HOPPER_ROUTER_CHEAP_BOOST,
    webhookBaseMs: e.JOB_HOPPER_WEBHOOK_BASE_MS,
    laneIdleGraceMs: e.JOB_HOPPER_LANE_IDLE_GRACE_MS,
    answerTimeoutMs: e.JOB_HOPPER_ANSWER_TIMEOUT_MS,
    humanRenotifyMs: e.JOB_HOPPER_HUMAN_RENOTIFY_MS,
    humanTimeoutMs: e.JOB_HOPPER_HUMAN_TIMEOUT_MS,
    resumeBoost: e.JOB_HOPPER_RESUME_BOOST,
    maxQuestions: e.JOB_HOPPER_MAX_QUESTIONS,
    keepPanes: e.JOB_HOPPER_KEEP_PANES,
    uiSessionHours: e.JOB_HOPPER_UI_SESSION_HOURS,
    ...(e.JOB_HOPPER_PLUGIN_DIR ? { pluginDir: e.JOB_HOPPER_PLUGIN_DIR } : {}),
    lanNames: e.JOB_HOPPER_LAN_NAMES,
    lanPeers: e.JOB_HOPPER_LAN_PEERS,
    leftoverEnv,
  };
}
