import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Clock, JevAdvisor } from '../domain/ports.ts';
import type { Job, JevAction, JevAdvice, JevMode } from '../domain/types.ts';

const SHIM = fileURLToPath(new URL('./jev_shim.py', import.meta.url));
const ACTIONS: readonly string[] = [
  'proceed_full', 'reuse_cache', 'stop_retry', 'run_deterministic',
  'chat_only', 'ask_human', 'allow_subagent', 'research_capped',
] satisfies JevAction[];
const META_KEYS = ['cached_artifact', 'cached_note', 'prior_error', 'same_error_count', 'sources_found', 'constraints'];

export interface RouterAdvisorOptions {
  jevSrc: string;
  python: string;
  dataDir: string;
  mode: () => JevMode;
  clock: Clock;
  timeoutMs?: number;
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
function runShim(o: RouterAdvisorOptions, request: unknown): Promise<string> {
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
    const timeoutMs = o.timeoutMs ?? 10_000;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      settle(() => reject(new Error(`timed out after ${timeoutMs} ms`)));
    }, timeoutMs);
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

export function createRouterAdvisor(o: RouterAdvisorOptions): JevAdvisor {
  const at = () => o.clock.now().toISOString();
  return {
    name: 'jev-router',
    async advise(job: Job): Promise<JevAdvice> {
      try {
        const stdout = await runShim(o, {
          jevSrc: o.jevSrc,
          mode: o.mode(),
          logPath: join(o.dataDir, 'jev-runs.jsonl'),
          state: jevState(job),
        });
        const route = parseRoute(stdout);
        return {
          action: route.action as JevAction,
          reason: route.reason,
          jevUsed: route.jev_used,
          details: route.details ?? {},
          source: 'jev-router',
          at: at(),
        };
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        return {
          action: 'proceed_full',
          reason: `jev unavailable: ${why}`,
          jevUsed: false,
          details: {},
          source: 'fallback',
          at: at(),
        };
      }
    },
  };
}
