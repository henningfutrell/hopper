// The sign-in config at start (issue #216, design.md "Sign-in: realms"), in this order, then stored in one
// write against the version read:
//   1. A realm stored before #216 named its secret's variable (`clientSecretEnv`, `bindPasswordEnv`): the
//      secret is taken from the runtime into the realm. Persisted state is the user's, so this migrates
//      it; it needs the daemon's environment, which a schema migration (also run by the CLI) has not.
//   2. What the HOPPER_SIGN_IN_* variables set (src/auth/environment.ts) is applied: the environment wins.
//   3. The password fallback (issue #219, src/auth/fallback.ts): a config without an admin account in a
//      password realm that is on gets `admin`, signing in as the default admin account — the way Nexus, Jenkins and Argo
//      bootstrap their first admin — with HOPPER_SIGN_IN_ADMIN_PASSWORD, else a random password shown
//      once in the start lines. Only its argon2id hash is stored.
// The result must load: an invalid one stops the daemon (sign-in fails closed) and nothing is written.
import { randomBytes } from 'node:crypto';
import type { InstanceStore, StoredRealm, StoredSignIn } from '../domain/ports.ts';
import type { RuntimeSecrets } from '../secrets/runtime.ts';
import { loadSignInConfig, type AuthConfig } from './config.ts';
import { applySignInEnvironment, readSignInEnvironment } from './environment.ts';
import { withPasswordFallback } from './fallback.ts';
import { hashPassword } from './password.ts';

type Instance = Pick<InstanceStore, 'signInConfig' | 'identities' | 'users' | 'tx'>;
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

/** The sign-in config to start with, stored; and the realms the environment set up. Throws when it would not load. */
export async function prepareSignIn(o: { instance: Instance; env: Record<string, string | undefined>; secret: RuntimeSecrets; logger: Logger }): Promise<{ config: AuthConfig; environment: string[] }> {
  const store = o.instance.signInConfig;
  const version = store.version();
  const before = store.read();
  const env = readSignInEnvironment(o.env);
  let next = applySignInEnvironment(takeNamedSecrets(before, o.secret), env);
  const password = env.adminPassword ?? randomBytes(18).toString('base64url');
  const added = withPasswordFallback(next, await hashPassword(password));
  if (added) next = added.next;
  const config = loadSignInConfig(next);
  if (JSON.stringify(next) !== JSON.stringify(before)) {
    o.instance.tx(() => {
      if (!store.write(next, version)) throw new Error('the sign-in config changed while the daemon started: start it again');
      if (added) o.instance.identities.replace(added.realm, added.username, o.instance.users.admin().id);
    });
  }
  if (env.realms.length) o.logger.info(`hopper: sign-in from the environment: realms ${env.realms.map((r) => r.name).join(', ')}`);
  if (added && env.adminPassword !== undefined) {
    o.logger.warn(`hopper: password fallback: no admin account signs in with a password; added account ${added.username} to realm ${added.realm}, password from HOPPER_SIGN_IN_ADMIN_PASSWORD`);
  } else if (added) {
    o.logger.warn(`hopper: password fallback: no admin account signs in with a password; added account ${added.username} to realm ${added.realm}, password ${password} (shown only this once: sign in with it and change it in Settings → Sign-in)`);
  }
  return { config, environment: env.realms.map((r) => r.name) };
}
