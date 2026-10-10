// Jev at its seam (issue #550, design.md "Decider calls"): one TypeSafe Choice over a decision point's options,
// through jev_pick.py and the `typesafe_sdk` the gate router's Jev uses, with TYPESAFE_API_KEY from the runtime
// (read on every call: a key set later is used at once). No key: Jev is off, and nothing is asked. Every failure —
// no SDK, TypeSafe refusing, a timeout, a pick outside the options — is `{ ok: false }`, never a throw. The script
// runs in its own process group, so a timeout kills all of it.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { JevChooser, JevPick, MinorDecisionAsk } from '../domain/types.ts';

const SCRIPT = fileURLToPath(new URL('./jev_pick.py', import.meta.url));
/** Jev's own default model (grok-bot-jev's config). */
export const JEV_MODEL = 'jev-latest';
export const KEY = 'TYPESAFE_API_KEY';

export interface JevOptions {
  /** The Python that runs the script. */
  python: string;
  timeoutMs: number;
  /** A runtime secret by name (TYPESAFE_API_KEY). */
  secret(name: string): string | undefined;
  /** The runtime's name for a secret: the user's secret prefix and the name. Default: the name. */
  secretName?(name: string): string;
  /** The script's environment, besides the key: PATH, HOME, PYTHONPATH. Nothing else of the daemon's. */
  env: Record<string, string | undefined>;
}

function run(o: JevOptions, key: string, request: unknown, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { PYTHONDONTWRITEBYTECODE: '1' };
    for (const [k, v] of Object.entries(o.env)) if (v !== undefined) env[k] = v;
    env[KEY] = key;
    const child = spawn(o.python, [SCRIPT], { env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    let stdout = '';
    let done = false;
    const kill = () => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); } };
    const settle = (fn: () => void) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', aborted); fn(); };
    const aborted = () => { kill(); settle(() => reject(new Error('aborted'))); };
    const timer = setTimeout(() => { kill(); settle(() => reject(new Error(`timed out after ${o.timeoutMs} ms`))); }, o.timeoutMs);
    signal?.addEventListener('abort', aborted, { once: true });
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stdin.on('error', () => {});
    child.on('error', (e) => settle(() => reject(e)));
    child.on('close', (code) => settle(() => (code === 0 ? resolve(stdout) : reject(new Error(`exit code ${code}`)))));
    child.stdin.end(JSON.stringify(request));
  });
}

export function createJev(o: JevOptions): JevChooser {
  const key = () => o.secret(KEY) || undefined;
  const off = `Jev is off until ${o.secretName?.(KEY) ?? KEY} is set`;
  return {
    available: () => (key() ? { available: true } : { available: false, why: off }),
    async pick(ask: MinorDecisionAsk, signal?: AbortSignal): Promise<JevPick> {
      const k = key();
      if (!k) return { ok: false, why: off };
      try {
        const stdout = await run(o, k, {
          model: JEV_MODEL, instructions: ask.instructions, state: ask.state,
          criteria: Object.fromEntries(ask.options.map((x) => [x.id, x.label])),
        }, signal);
        const out = JSON.parse(stdout.trim().split('\n').pop() ?? '') as { ok: boolean; pick?: unknown; confidence?: unknown; error?: string };
        if (!out.ok) return { ok: false, why: out.error ?? 'no answer' };
        if (typeof out.pick !== 'string' || !ask.options.some((x) => x.id === out.pick)) return { ok: false, why: `Jev picked ${String(out.pick)}, not an option` };
        const confidence = typeof out.confidence === 'number' ? Math.min(1, Math.max(0, out.confidence)) : 0;
        return { ok: true, pick: out.pick, confidence };
      } catch (e) {
        return { ok: false, why: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}
