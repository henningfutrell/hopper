// The sign-in config at start (issues #216, #237, design.md "Sign-in: realms"), in this order, then stored
// in one write against the version read:
//   1. A realm stored before #216 named its secret's variable (`clientSecretEnv`, `bindPasswordEnv`): the
//      secret is taken from the runtime into the realm. Persisted state is the user's, so this migrates
//      it; it needs the daemon's environment, which a schema migration (also run by the CLI) has not.
//   2. What the HOPPER_SIGN_IN_* variables set (src/auth/environment.ts) is applied: the environment wins.
//   3. No way in — no realm that is on, the login code off, no sign-in off — turns the login code on.
// The result must load: an invalid one stops the daemon (sign-in fails closed) and nothing is written.
//
// The first sign-in is the login code (issue #237): the hopper keeps no password accounts of its own.
// While the login code is on, no sign-in is off, the default admin account signs in through no realm that
// is on, and no first GitHub admin (issue #239) signs in through one, each start logs a one-time login code for it (`firstSignInLine`), the way Jenkins logs its
// first admin's key. `hopper login-code` mints another.
import type { InstanceStore, StoredRealm, StoredSignIn } from '../domain/ports.ts';
import type { RuntimeSecrets } from '../secrets/runtime.ts';
import { loadSignInConfig, type AuthConfig } from './config.ts';
import { applySignInEnvironment, readSignInEnvironment } from './environment.ts';

type Instance = Pick<InstanceStore, 'signInConfig' | 'identities' | 'users'>;
interface Logger { info(line: string): void; warn(line: string): void }

/** Step 1: each secret a realm named by its variable, now in the realm. A realm that is on needs it set. */
function takeNamedSecrets(s: StoredSignIn, secret: RuntimeSecrets): StoredSignIn {
  const named: [string, string][] = [['clientSecretEnv', 'clientSecret'], ['bindPasswordEnv', 'bindPassword']];
  const realms = s.realms.map((r, i) => {
    let out: StoredRealm = r;
    for (const [from, to] of named) {
      if (typeof out[from] !== 'string') continue;
      const { [from]: variable, ...rest } = out;
      const value = secret(variable as string);
      if (value === undefined && r.enabled !== false) throw new Error(`invalid sign-in config: realms.${i}.${from}: environment variable ${String(variable)} is not set; the realm's secret is taken from it into the database once`);
      out = { ...rest, ...(value === undefined ? {} : { [to]: value }) } as StoredRealm;
    }
    return out;
  });
  return { ...s, realms };
}

/** Step 3: the config with the login code on when nothing else lets anyone in; undefined when something does. */
function withWayIn(s: StoredSignIn): StoredSignIn | undefined {
  if (s.local?.enabled !== false || s.none !== undefined || s.realms.some((r) => r.enabled !== false)) return undefined;
  return { ...s, local: { enabled: true } };
}

/** Whether the start hands out the first sign-in, a login code for the default admin account: nothing else signs an admin in. */
function needsFirstSignIn(config: AuthConfig, instance: Instance): boolean {
  if (!config.local.enabled || config.none !== null) return false;
  const on = new Set(config.realms.filter((r) => r.enabled).map((r) => r.name));
  if (config.githubAdmin && on.has(config.githubAdmin.realm)) return false;
  return !instance.identities.realmsOf(instance.users.admin().id).some((realm) => on.has(realm));
}

/**
 * The sign-in config to start with, stored; the realms the environment set up; and whether the start
 * hands out the first sign-in (`firstSignInLine`). Throws when it would not load.
 */
export function prepareSignIn(o: { instance: Instance; env: Record<string, string | undefined>; secret: RuntimeSecrets; logger: Logger }): { config: AuthConfig; environment: string[]; firstSignIn: boolean } {
  const store = o.instance.signInConfig;
  const version = store.version();
  const before = store.read();
  const env = readSignInEnvironment(o.env);
  let next = applySignInEnvironment(takeNamedSecrets(before, o.secret), env);
  const opened = withWayIn(next);
  if (opened) next = opened;
  const config = loadSignInConfig(next);
  if (JSON.stringify(next) !== JSON.stringify(before) && !store.write(next, version)) {
    throw new Error('the sign-in config changed while the daemon started: start it again');
  }
  if (env.realms.length) o.logger.info(`hopper: sign-in from the environment: realms ${env.realms.map((r) => r.name).join(', ')}`);
  if (opened) o.logger.warn('hopper: the sign-in config had no way to sign in (no realm on, login code off, no sign-in off): the login code is turned on');
  return { config, environment: env.realms.map((r) => r.name), firstSignIn: needsFirstSignIn(config, o.instance) };
}

/** The start line that hands out `code`, a fresh login code for the default admin account, with its link at `origin`. */
export const firstSignInLine = (code: string, origin: string, minutes: number): string =>
  `hopper: first sign-in: login code ${code} signs in once as admin, for ${minutes} minutes: ${origin.replace(/\/+$/, '')}/#login=${code} (another: hopper login-code)`;
