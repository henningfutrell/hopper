// Configuration from env, per docs/design.md "Configuration (env)" and "Configuration added".
// Invalid values fail loudly.
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
  /** Executors to register, by name. */
  executors: ExecutorName[];
  herdrBin: string;
  herdrSession: string;
  herdrPollMs: number;
  /** The `claude` CLI the answer tiers run. */
  claudeBin: string;
  /** Extra args for Claude in a pane, split on whitespace. */
  claudeArgs: string[];
  claudeCwd: string;
  trustWorkdir: boolean;
  idleQuestionMs: number;
  answerer: 'claude' | 'fake';
  answerModelA: string;
  answerModelB: string;
  answerTimeoutMs: number;
  rulesFile: string;
  humanRenotifyMs: number;
  humanTimeoutMs: number;
  resumeBoost: number;
  maxQuestions: number;
  /** Keep panes open after a job ends (for inspection); default false: every terminal outcome cleans up. */
  keepPanes: boolean;
}

export const EXECUTOR_NAMES = ['test', 'herdr-claude'] as const;
export type ExecutorName = (typeof EXECUTOR_NAMES)[number];

const expandHome = (p: string): string => (p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);

const int = (min: number, max = Number.MAX_SAFE_INTEGER) => z.coerce.number().int().min(min).max(max);
const fraction = () => z.coerce.number().min(0).max(1);
const path = (fallback: string) => z.string().min(1).default(fallback).transform(expandHome);
const flag = (fallback: boolean) => z.enum(['true', 'false']).default(fallback ? 'true' : 'false').transform((v) => v === 'true');
const executorList = z.string().default('test,herdr-claude').transform((s, ctx) => {
  const names = [...new Set(s.split(',').map((x) => x.trim()).filter(Boolean))];
  if (names.length === 0) ctx.addIssue({ code: 'custom', message: 'name at least one executor' });
  for (const n of names) {
    if (!(EXECUTOR_NAMES as readonly string[]).includes(n)) ctx.addIssue({ code: 'custom', message: `unknown executor ${n} (known: ${EXECUTOR_NAMES.join(', ')})` });
  }
  return names as ExecutorName[];
});

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
  JOB_HOPPER_EXECUTORS: executorList,
  JOB_HOPPER_HERDR_BIN: z.string().min(1).default('herdr'),
  // Never the user's default herdr session (herdr's own doctrine; design.md "herdr session").
  JOB_HOPPER_HERDR_SESSION: z.string().min(1).refine((s) => s !== 'default', 'must not be the default herdr session').default('job-hopper'),
  JOB_HOPPER_HERDR_POLL_MS: int(1).default(1000),
  JOB_HOPPER_CLAUDE_BIN: z.string().min(1).default('claude'),
  JOB_HOPPER_CLAUDE_ARGS: z.string().default('--dangerously-skip-permissions').transform((s) => s.split(/\s+/).filter(Boolean)),
  JOB_HOPPER_CLAUDE_CWD: path('~/workbench/workflow-personal-app-management'),
  JOB_HOPPER_TRUST_WORKDIR: flag(true),
  JOB_HOPPER_IDLE_QUESTION_MS: int(1).default(20000),
  JOB_HOPPER_ANSWERER: z.enum(['claude', 'fake']).default('claude'),
  JOB_HOPPER_ANSWER_MODEL_A: z.string().min(1).default('opus'),
  JOB_HOPPER_ANSWER_MODEL_B: z.string().min(1).default('fable'),
  JOB_HOPPER_ANSWER_TIMEOUT_MS: int(1).default(180000),
  JOB_HOPPER_RULES_FILE: path('~/.config/job-hopper/rules.md'),
  JOB_HOPPER_HUMAN_RENOTIFY_MS: int(1).default(900000),
  JOB_HOPPER_HUMAN_TIMEOUT_MS: int(1).default(86400000),
  JOB_HOPPER_RESUME_BOOST: z.coerce.number().finite().default(20),
  JOB_HOPPER_MAX_QUESTIONS: int(0).default(5),
  JOB_HOPPER_KEEP_PANES: flag(false),
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
    executors: e.JOB_HOPPER_EXECUTORS,
    herdrBin: e.JOB_HOPPER_HERDR_BIN,
    herdrSession: e.JOB_HOPPER_HERDR_SESSION,
    herdrPollMs: e.JOB_HOPPER_HERDR_POLL_MS,
    claudeBin: e.JOB_HOPPER_CLAUDE_BIN,
    claudeArgs: e.JOB_HOPPER_CLAUDE_ARGS,
    claudeCwd: e.JOB_HOPPER_CLAUDE_CWD,
    trustWorkdir: e.JOB_HOPPER_TRUST_WORKDIR,
    idleQuestionMs: e.JOB_HOPPER_IDLE_QUESTION_MS,
    answerer: e.JOB_HOPPER_ANSWERER,
    answerModelA: e.JOB_HOPPER_ANSWER_MODEL_A,
    answerModelB: e.JOB_HOPPER_ANSWER_MODEL_B,
    answerTimeoutMs: e.JOB_HOPPER_ANSWER_TIMEOUT_MS,
    rulesFile: e.JOB_HOPPER_RULES_FILE,
    humanRenotifyMs: e.JOB_HOPPER_HUMAN_RENOTIFY_MS,
    humanTimeoutMs: e.JOB_HOPPER_HUMAN_TIMEOUT_MS,
    resumeBoost: e.JOB_HOPPER_RESUME_BOOST,
    maxQuestions: e.JOB_HOPPER_MAX_QUESTIONS,
    keepPanes: e.JOB_HOPPER_KEEP_PANES,
  };
}
