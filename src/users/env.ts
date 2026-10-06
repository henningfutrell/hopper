// A user's environment (issue #158, design.md "Users: one hopper, separate users"): the user work
// dir, the secrets the runtime gives under the user's secret prefix, and the CLI config dirs every
// process of theirs starts with.
import { join } from 'node:path';
import { ADMIN_ID, type User } from '../domain/types.ts';
import { runtimeSecrets, type RuntimeSecrets } from '../secrets/runtime.ts';

/** The user work dir: HOPPER_WORK_DIR itself for admin, `<work dir>/users/<id>` for a user added later. */
export const userWorkDir = (workDir: string, user: User): string => (user.workDir ? join(workDir, user.workDir) : workDir);

/** The user's secret NAME: the runtime's `<secret prefix>NAME` (or `<secret prefix>NAME_FILE`). */
export function userSecrets(env: Record<string, string | undefined>, user: User): RuntimeSecrets {
  const secret = runtimeSecrets(env);
  return (name) => secret(`${user.secretPrefix}${name}`);
}

/**
 * What the user's processes add to the daemon's environment: for a user with a work dir of their own,
 * the gh and claude CLIs' config dirs in it (their logins); none for admin, whose environment is
 * the daemon's.
 */
export function userCliEnv(workDir: string, user: User): Record<string, string> {
  if (!user.workDir) return {};
  const dir = userWorkDir(workDir, user);
  return { GH_CONFIG_DIR: join(dir, 'gh'), CLAUDE_CONFIG_DIR: join(dir, 'claude') };
}

/** The herdr session the user's jobs run in on this machine: `hopper` for admin, `hopper-<id>` for a user added later. */
export const userHerdrSession = (user: User): string => (user.id === ADMIN_ID ? 'hopper' : `hopper-${user.id}`);
