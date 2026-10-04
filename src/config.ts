// Configuration from env: process settings only (docs/design.md "Settled in slice 4"); every part is
// configured in plugins.yaml. Invalid values fail loudly.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

export interface Config {
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
const schema = z.object({
  // Loopback only (AGENTS.md): any other bind address needs authentication — a different application.
  JOB_HOPPER_HOST: z.literal('127.0.0.1', { error: 'must be 127.0.0.1 (loopback only)' }).default('127.0.0.1'),
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
}).refine((e) => e.JOB_HOPPER_SOFT_LIMIT < e.JOB_HOPPER_HARD_LIMIT, {
  message: 'must be below JOB_HOPPER_HARD_LIMIT',
  path: ['JOB_HOPPER_SOFT_LIMIT'],
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
    host: e.JOB_HOPPER_HOST,
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
    leftoverEnv,
  };
}
