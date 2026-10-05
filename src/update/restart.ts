// Starting again on the swapped install. Under a supervisor — systemd (INVOCATION_ID set) or a
// container's PID 1 — the process exits with RESTART_EXIT_CODE and the supervisor starts it again
// (the unit's RestartForceExitStatus; a container restart policy). Unsupervised, it starts its
// successor detached after releasing the port, then exits. HOPPER_RESTART forces either.
// Under systemd the units the new install ships are installed first when they differ.
import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Restarter } from '../domain/ports.ts';

const exec = promisify(execFile);
export const RESTART_EXIT_CODE = 75;
const UNITS = ['hopper.service', 'hopper-herdr.service'];

export type RestartMode = 'exit' | 'respawn';

export function restartMode(env: Record<string, string | undefined>, pid: number, forced?: RestartMode): RestartMode {
  if (forced) return forced;
  return env.INVOCATION_ID || pid === 1 ? 'exit' : 'respawn';
}

/**
 * The systemd --user units the new install ships, written over the installed ones that differ.
 * Only units already installed are touched; hopper-herdr is never restarted (that kills every pane).
 */
export async function syncUserUnits(appDir: string, logger: { info(l: string): void; warn(l: string): void }): Promise<void> {
  const unitDir = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'systemd', 'user');
  let changed = false;
  for (const unit of UNITS) {
    const shipped = join(appDir, 'systemd', unit);
    const installed = join(unitDir, unit);
    if (!existsSync(shipped) || !existsSync(installed)) continue;
    const text = readFileSync(shipped, 'utf8');
    if (text === readFileSync(installed, 'utf8')) continue;
    writeFileSync(installed, text, { mode: 0o644 });
    logger.info(`hopper: update installed the new ${installed}`);
    changed = true;
  }
  if (changed) await exec('systemctl', ['--user', 'daemon-reload']).catch((e: Error) => logger.warn(`hopper: systemctl --user daemon-reload failed: ${e.message}`));
}

export function createRestarter(o: {
  appDir: string; forced?: RestartMode; stop: () => Promise<void>; logger: { info(l: string): void; warn(l: string): void };
}): Restarter {
  return async () => {
    const mode = restartMode(process.env, process.pid, o.forced);
    if (process.env.INVOCATION_ID) await syncUserUnits(o.appDir, o.logger);
    await o.stop();
    if (mode === 'exit') {
      o.logger.info(`hopper: exiting ${RESTART_EXIT_CODE} for the supervisor to start the new install`);
      process.exit(RESTART_EXIT_CODE);
    }
    o.logger.info('hopper: starting the new install');
    spawn(process.execPath, [...process.execArgv, join(o.appDir, 'src', 'main.ts')], { detached: true, stdio: 'inherit', env: process.env }).unref();
    process.exit(0);
  };
}
