// Running grok-bot-jev's router once per job through gate_shim.py (design.md "Gate router"). Any
// failure is advice with `source: fallback` — the router's own documented safe fallback — never a throw.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeArgv, scrubbedEnv } from '../../claude-print.ts';
import type { Advice, AdviceAction, Clock, Job, Router } from '../../sdk.ts';
import { userProcessEnv } from '../../../executors/env.ts';

const SHIM = fileURLToPath(new URL('./gate_shim.py', import.meta.url));
const ACTIONS: readonly string[] = [
  'proceed_full', 'reuse_cache', 'stop_retry', 'run_deterministic',
  'chat_only', 'ask_human', 'allow_subagent', 'research_capped',
] satisfies AdviceAction[];
/**
 * The gates Jev answers, through TypeSafe, once its key is set: crisp classifications of the job state,
 * where TypeSafe's calibrated probabilities feed Jev's thresholds (owner decision, 2026-10-03, issue #19).
 * The Claude model answers the rest. Fixed: which gate goes where is the router's, not a setting (issue #217).
 */
export const JEV_GATES: readonly string[] = ['intent', 'reuse_cache', 'stop_retry'];
const META_KEYS = ['cached_artifact', 'cached_note', 'prior_error', 'same_error_count', 'sources_found', 'constraints'];
/**
 * The Claude model's answers to the gates, keyed by gate name and grouped by gate type (Jev's own
 * grouping). Draft-07 literal, as claude-print.ts requires; the shim checks names and labels.
 */
const GATE_ANSWERS_SCHEMA = {
  type: 'object',
  properties: {
    choices: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        properties: { choice: { type: 'string' }, probabilities: { type: 'object', additionalProperties: { type: 'number', minimum: 0, maximum: 1 } } },
        required: ['choice', 'probabilities'],
      },
    },
    nouls: { type: 'object', additionalProperties: { type: 'number', minimum: 0, maximum: 1 } },
    scores: { type: 'object', additionalProperties: { type: 'number', minimum: 0 } },
  },
  required: ['choices', 'nouls', 'scores'],
};

export interface GateRouterShimOptions {
  /** The grok-bot-jev checkout (absolute). */
  jevPath: string;
  python: string;
  /** The Claude model, for the `claude` on PATH. */
  model: string;
  /** The TypeSafe key (TYPESAFE_API_KEY), asked on every call; undefined: Jev off. */
  typesafeKey(): string | undefined;
  dataDir: string;
  clock: Clock;
  timeoutMs: number;
  /** Over the daemon's environment: the user's CLI config dirs, for the claude the shim starts (issue #158). */
  userEnv?: Readonly<Record<string, string>>;
}

interface Route {
  action: string;
  reason: string;
  jev_used: boolean;
  details?: Record<string, unknown>;
}

function routerState(job: Job): Record<string, unknown> {
  const { goal, kind, meta = {} } = job.spec;
  const state: Record<string, unknown> = { goal, kind };
  for (const key of META_KEYS) if (key in meta) state[key] = meta[key];
  return state;
}

/**
 * Spawn the shim, feed it the request, resolve with its stdout. Rejects on any failure. The shim
 * runs in its own process group, so a timeout also kills the claude it started.
 */
function runShim(o: GateRouterShimOptions, key: string | undefined, request: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...scrubbedEnv(userProcessEnv(o.userEnv)), PYTHONDONTWRITEBYTECODE: '1' };
    if (key) env.TYPESAFE_API_KEY = key;
    const child = spawn(o.python, [SHIM], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    let stdout = '';
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
      settle(() => reject(new Error(`timed out after ${o.timeoutMs} ms`)));
    }, o.timeoutMs);
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stdin.on('error', () => {}); // a dead child surfaces via 'error' / 'close'
    child.on('error', (e) => settle(() => reject(e)));
    child.on('close', (code) =>
      settle(() => (code === 0 ? resolve(stdout) : reject(new Error(`exit code ${code}`)))),
    );
    child.stdin.end(JSON.stringify(request));
  });
}

function parseRoute(stdout: string): Route {
  const out = JSON.parse(stdout.trim().split('\n').pop() ?? '') as {
    ok: boolean; error?: string; route?: Route;
  };
  if (!out.ok || !out.route) throw new Error(out.error ?? 'no route');
  if (!ACTIONS.includes(out.route.action)) throw new Error(`unknown action ${out.route.action}`);
  return out.route;
}

/** `name` is the plugin id; the host reports the instance name. */
export function createGateRouter(o: GateRouterShimOptions): Router {
  const at = () => o.clock.now().toISOString();
  return {
    name: 'gate-router',
    async advise(job: Job): Promise<Advice> {
      try {
        const stdout = await runShim(o, o.typesafeKey() || undefined, {
          jevPath: o.jevPath,
          // The hopper always applies the advice (issue #211): Jev is told it is active.
          mode: 'active',
          logPath: join(o.dataDir, 'gate-router-runs.jsonl'),
          state: routerState(job),
          jevGates: JEV_GATES,
          claude: { argv: ['claude', ...claudeArgv({ model: o.model, jsonSchema: GATE_ANSWERS_SCHEMA })], cwd: o.dataDir },
        });
        const route = parseRoute(stdout);
        return {
          action: route.action as AdviceAction,
          reason: route.reason,
          // `gatesAsked` mirrors grok-bot-jev's own `jev_used`: were the gates asked at all (false: kill
          // switch / bypass). It says nothing of who answered them; `gatesBy` does.
          details: { ...(route.details ?? {}), gatesAsked: route.jev_used },
          source: 'gate-router',
          at: at(),
        };
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        return { action: 'proceed_full', reason: `gate router unavailable: ${why}`, details: { gatesAsked: false }, source: 'fallback', at: at() };
      }
    },
  };
}
