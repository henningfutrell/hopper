// Running grok-bot-jev's router once per job through jev_shim.py (design.md "Jev"). Any failure is
// advice with `source: fallback` — the router's own documented safe fallback — never a throw.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Advice, AdviceAction, Clock, Job, Router, RouterMode } from '../../sdk.ts';

const SHIM = fileURLToPath(new URL('./jev_shim.py', import.meta.url));
const ACTIONS: readonly string[] = [
  'proceed_full', 'reuse_cache', 'stop_retry', 'run_deterministic',
  'chat_only', 'ask_human', 'allow_subagent', 'research_capped',
] satisfies AdviceAction[];
const META_KEYS = ['cached_artifact', 'cached_note', 'prior_error', 'same_error_count', 'sources_found', 'constraints'];

export interface JevShimOptions {
  /** The Jev checkout (absolute). */
  jevSrc: string;
  python: string;
  dataDir: string;
  mode: () => RouterMode;
  clock: Clock;
  timeoutMs: number;
}

interface Route {
  action: string;
  reason: string;
  jev_used: boolean;
  details?: Record<string, unknown>;
}

function jevState(job: Job): Record<string, unknown> {
  const { goal, kind, meta = {} } = job.spec;
  const state: Record<string, unknown> = { goal, kind };
  for (const key of META_KEYS) if (key in meta) state[key] = meta[key];
  return state;
}

/** Spawn the shim, feed it the request, resolve with its stdout. Rejects on any failure. */
function runShim(o: JevShimOptions, request: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(o.python, [SHIM], {
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
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
      child.kill('SIGKILL');
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
export function createJevShimRouter(o: JevShimOptions): Router {
  const at = () => o.clock.now().toISOString();
  return {
    name: 'jev-router',
    async advise(job: Job): Promise<Advice> {
      try {
        const stdout = await runShim(o, {
          jevSrc: o.jevSrc,
          mode: o.mode(),
          logPath: join(o.dataDir, 'jev-runs.jsonl'),
          state: jevState(job),
        });
        const route = parseRoute(stdout);
        return {
          action: route.action as AdviceAction,
          reason: route.reason,
          // `jevUsed` mirrors the router's own `jev_used` (false: kill switch / bypass).
          details: { ...(route.details ?? {}), jevUsed: route.jev_used },
          source: 'jev-router',
          at: at(),
        };
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        return { action: 'proceed_full', reason: `jev unavailable: ${why}`, details: { jevUsed: false }, source: 'fallback', at: at() };
      }
    },
  };
}
