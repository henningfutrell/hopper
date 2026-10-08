// Whether this machine runs a systemd user manager a test may start a transient scope in (issue #410):
// the scope tests run for real where it does, and are skipped where it does not (a container, CI).
import { spawnSync } from 'node:child_process';

export const userSystemd = ((): boolean => {
  try {
    return spawnSync('systemd-run', ['--user', '--scope', '--quiet', '--collect', '--', 'true'], { timeout: 10000 }).status === 0;
  } catch {
    return false;
  }
})();
