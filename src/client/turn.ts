// A print-mode agent's turn on this machine (issue #865 part A, design.md "Client targets"): `POST /turn {script,
// timeoutMs}` runs the turn the hopper built for the job — the same script it runs on this machine or over ssh, with the
// job's own container runtime and its sandbox around the agent (src/executors/print-agent.ts `isolatedTurn`) — as
// `sh -c`, stdin closed, in its own process group. It answers `{code, stdout, stderr}` when it ends, and `timedOut` with
// code 124 when it ran out its time. When the hopper closes the call (a cancel), or the link ends, the turn is stopped.
// The signed `/herdr` already types any command into a pane here, so the route gives the hopper no power it lacked.
// Imports nothing of hopper: it is installed as plain files.
import { spawn } from 'node:child_process';

/** A turn runs at most a day; the hopper's own timeout is the job's (an hour unless its payload says). */
export const MAX_TURN_MS = 24 * 60 * 60 * 1000;
/** What a turn's answer keeps of each stream: its tail. */
const OUTPUT_CAP = 16 * 1024 * 1024;

export interface TurnAnswer { code: number; stdout: string; stderr: string; timedOut?: true }

/** The turn's call checked: a non-empty script and a positive timeout, at most MAX_TURN_MS. */
export function turnOf(body: unknown): { script: string; timeoutMs: number } | string {
  const b = body as { script?: unknown; timeoutMs?: unknown } | null;
  if (typeof b?.script !== 'string' || !b.script.trim()) return 'script must be a non-empty string';
  if (typeof b.timeoutMs !== 'number' || !(b.timeoutMs > 0)) return 'timeoutMs must be a positive number';
  return { script: b.script, timeoutMs: Math.min(b.timeoutMs, MAX_TURN_MS) };
}

const keepTail = (s: string): string => (s.length > OUTPUT_CAP ? s.slice(-OUTPUT_CAP) : s);

/** Runs the turn to its end; `stopped` stops it at once (the whole process group). */
export function runTurn(script: string, timeoutMs: number, stopped: AbortSignal): Promise<TurnAnswer> {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', script], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const kill = (): void => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* it ended */ } };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    const stop = (): void => kill();
    stopped.addEventListener('abort', stop, { once: true });
    child.stdout.setEncoding('utf8').on('data', (c: string) => { stdout = keepTail(stdout + c); });
    child.stderr.setEncoding('utf8').on('data', (c: string) => { stderr = keepTail(stderr + c); });
    const done = (code: number, err?: string): void => {
      clearTimeout(timer);
      stopped.removeEventListener('abort', stop);
      if (timedOut) return resolve({ code: 124, stdout, stderr: `${stderr}the turn timed out after ${timeoutMs} ms`, timedOut: true });
      resolve({ code, stdout, stderr: err ? `${stderr}${err}` : stderr });
    };
    child.once('error', (e) => done(127, e.message));
    child.once('close', (code, signal) => done(code ?? (signal ? 128 + 9 : 1)));
    if (stopped.aborted) kill();
  });
}
