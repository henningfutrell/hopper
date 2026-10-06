// This machine's herdr session (issue #260, design.md "This machine"): the one named when the machine
// was added, started by the hopper when it is not running. Under systemd it runs as a transient user
// unit, so it outlives a restart of the daemon; elsewhere as a detached process. Never the default session.
import { execFile, spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { HERDR_SESSION } from '../../domain/types.ts';
import { scrubbedEnv, userProcessEnv } from '../env.ts';

export { HERDR_SESSION };

/** Why a session name cannot be used, or undefined. */
export function sessionProblem(session: string): string | undefined {
  if (session === 'default') return 'must not be the default herdr session';
  if (!HERDR_SESSION.test(session)) return 'a herdr session is a plain name: letters, digits, dot, dash, underscore';
  return undefined;
}

export interface EnsureSessionOptions {
  /** The herdr CLI: a path, or a name looked up on PATH. */
  bin: string;
  session: string;
  /** The user's CLI config dirs (issue #158), over the daemon's environment. */
  userEnv?: Readonly<Record<string, string>>;
  /** systemd-run, to start the server as a transient user unit; null: a detached process. Default: systemd-run under a user manager. */
  systemdRun?: string | null;
  waitMs?: number;
  pollMs?: number;
}

/** The executable `bin` names: itself when it has a slash, else the first on PATH. */
function locate(bin: string, path: string | undefined): string | undefined {
  const ok = (p: string): boolean => { try { accessSync(p, constants.X_OK); return true; } catch { return false; } };
  if (bin.includes('/')) return ok(bin) ? bin : undefined;
  return (path ?? '').split(delimiter).filter(Boolean).map((d) => join(d, bin)).find(ok);
}

/**
 * Make sure the herdr session runs on this machine: `running` when it already did, `started` when the
 * hopper started it (`herdr --session <s> server`) and it now answers. Rejects with the reason.
 */
export async function ensureHerdrSession(o: EnsureSessionOptions): Promise<'running' | 'started'> {
  const problem = sessionProblem(o.session);
  if (problem) throw new Error(`herdr session ${o.session}: ${problem}`);
  const env = scrubbedEnv(userProcessEnv(o.userEnv));
  const bin = locate(o.bin, env.PATH);
  if (!bin) throw new Error(`herdr not found: ${o.bin}`);
  const running = (): Promise<boolean> => new Promise((resolve) => {
    execFile(bin, ['--session', o.session, 'status', 'server'], { env, timeout: 10000, killSignal: 'SIGKILL', encoding: 'utf8' },
      (_err, stdout) => resolve(/^status: running$/m.test(stdout ?? '')));
  });
  if (await running()) return 'running';

  const systemdRun = o.systemdRun === undefined ? (env.XDG_RUNTIME_DIR ? locate('systemd-run', env.PATH) : undefined) : o.systemdRun ?? undefined;
  const started = systemdRun ? await startUnit(systemdRun, bin, o.session, env, o.userEnv ?? {}) : false;
  if (!started) spawn(bin, ['--session', o.session, 'server'], { env, detached: true, stdio: 'ignore' }).on('error', () => {}).unref();

  const wait = o.waitMs ?? 10000;
  const poll = o.pollMs ?? 250;
  for (const end = Date.now() + wait; Date.now() < end;) {
    await new Promise((r) => setTimeout(r, poll));
    if (await running()) return 'started';
  }
  throw new Error(`herdr session ${o.session} did not start within ${Math.round(wait / 1000)} s (${bin} --session ${o.session} server)`);
}

/** The server as a transient user unit, `hopper-herdr-<session>`; false when systemd-run could not start it. */
function startUnit(systemdRun: string, bin: string, session: string, env: NodeJS.ProcessEnv, userEnv: Readonly<Record<string, string>>): Promise<boolean> {
  const setenv = Object.entries({ ...(env.PATH ? { PATH: env.PATH } : {}), ...userEnv }).map(([k, v]) => `--setenv=${k}=${v}`);
  return new Promise((resolve) => {
    execFile(systemdRun, [
      '--user', '--collect', '--quiet', `--unit=hopper-herdr-${session}`,
      `--description=hopper's herdr session ${session} (jobs on this machine)`, ...setenv, '--', bin, '--session', session, 'server',
    ], { env, timeout: 10000, killSignal: 'SIGKILL' }, (err) => resolve(!err));
  });
}
