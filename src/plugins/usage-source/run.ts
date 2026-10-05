// One run of a usage source's command (claude-plan's claude CLI, command-usage's command): argv only
// (no shell), the env without the Claude Code markers, killed at the timeout or on abort. Never throws.
import { execFile } from 'node:child_process';
import { scrubbedEnv } from '../claude-print.ts';

/** It ran (any exit code), or it could not run or finish. */
export type CliRun = { code: number; stdout: string; stderr: string } | { error: string };

/** `userEnv`: over the daemon's environment, the user's CLI config dirs (PluginContext.userEnv, issue #158). */
export function runCli(bin: string, args: string[], o: { cwd: string; timeoutMs: number; signal: AbortSignal; userEnv?: Readonly<Record<string, string>> }): Promise<CliRun> {
  return new Promise((resolve) => {
    execFile(bin, args, {
      cwd: o.cwd, env: scrubbedEnv({ ...process.env, ...o.userEnv }), timeout: o.timeoutMs, killSignal: 'SIGKILL', signal: o.signal, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (!err) return resolve({ code: 0, stdout, stderr });
      const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
      if (e.name === 'AbortError') return resolve({ error: 'stopped' });
      if (e.code === 'ENOENT') return resolve({ error: `not found: ${bin}` });
      if (e.killed) return resolve({ error: `timeout after ${o.timeoutMs / 1000}s` });
      if (typeof e.code === 'number') return resolve({ code: e.code, stdout, stderr });
      resolve({ error: e.message });
    });
  });
}
