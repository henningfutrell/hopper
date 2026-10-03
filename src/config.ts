// Configuration from env, per docs/design.md "Configuration (env)". Invalid values fail loudly.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

export interface Config {
  host: string;
  port: number;
  dbPath: string;
  tickMs: number;
  jevMode: 'shadow' | 'active';
  jevAdvisor: 'router' | 'fake';
  jevSrc: string;
  python: string;
  localLanes: number;
  softLimit: number;
  hardLimit: number;
  jevCheapBoost: number;
  webhookBaseMs: number;
  laneIdleGraceMs: number;
}

const expandHome = (p: string): string => (p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);

const int = (min: number, max = Number.MAX_SAFE_INTEGER) => z.coerce.number().int().min(min).max(max);
const fraction = () => z.coerce.number().min(0).max(1);
const path = (fallback: string) => z.string().min(1).default(fallback).transform(expandHome);

const schema = z.object({
  // Loopback only (AGENTS.md): any other bind address needs authentication — a different application.
  JOB_HOPPER_HOST: z.literal('127.0.0.1', { error: 'must be 127.0.0.1 (loopback only)' }).default('127.0.0.1'),
  JOB_HOPPER_PORT: int(0, 65535).default(4790),
  JOB_HOPPER_DB: path('~/.local/share/job-hopper/job-hopper.db'),
  JOB_HOPPER_TICK_MS: int(1).default(2000),
  JOB_HOPPER_JEV_MODE: z.enum(['shadow', 'active']).default('shadow'),
  JOB_HOPPER_JEV_ADVISOR: z.enum(['router', 'fake']).default('router'),
  JOB_HOPPER_JEV_SRC: path('~/workbench/jev-src/grok-bot-jev'),
  JOB_HOPPER_PYTHON: z.string().min(1).default('python3'),
  JOB_HOPPER_LOCAL_LANES: int(0).default(4),
  JOB_HOPPER_SOFT_LIMIT: fraction().default(0.7),
  JOB_HOPPER_HARD_LIMIT: fraction().default(0.95),
  JOB_HOPPER_JEV_CHEAP_BOOST: z.coerce.number().default(10),
  JOB_HOPPER_WEBHOOK_BASE_MS: int(1).default(1000),
  JOB_HOPPER_LANE_IDLE_GRACE_MS: int(0).default(5000),
}).refine((e) => e.JOB_HOPPER_SOFT_LIMIT < e.JOB_HOPPER_HARD_LIMIT, {
  message: 'must be below JOB_HOPPER_HARD_LIMIT',
  path: ['JOB_HOPPER_SOFT_LIMIT'],
});

/** Reads only JOB_HOPPER_* keys; empty strings count as unset. Throws on any invalid value. */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const relevant = Object.fromEntries(
    Object.entries(env).filter(([k, v]) => k.startsWith('JOB_HOPPER_') && v !== undefined && v !== ''),
  );
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
    jevMode: e.JOB_HOPPER_JEV_MODE,
    jevAdvisor: e.JOB_HOPPER_JEV_ADVISOR,
    jevSrc: e.JOB_HOPPER_JEV_SRC,
    python: e.JOB_HOPPER_PYTHON,
    localLanes: e.JOB_HOPPER_LOCAL_LANES,
    softLimit: e.JOB_HOPPER_SOFT_LIMIT,
    hardLimit: e.JOB_HOPPER_HARD_LIMIT,
    jevCheapBoost: e.JOB_HOPPER_JEV_CHEAP_BOOST,
    webhookBaseMs: e.JOB_HOPPER_WEBHOOK_BASE_MS,
    laneIdleGraceMs: e.JOB_HOPPER_LANE_IDLE_GRACE_MS,
  };
}
