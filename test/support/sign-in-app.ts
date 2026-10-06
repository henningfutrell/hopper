// The daemon side of sign-in tests: start the real app with a sign-in config, read GET /ui/api/session,
// start loopback OIDC issuers. Everything started is stopped by `stopAll` (call it in afterEach).
import { startTestApp, tempDbPath, type TestApp } from './app.ts';
import { writeConfig } from './files.ts';
import { rawRequest } from './http.ts';
import { startOidcIdp, type OidcIdp } from './idp.ts';

/** The daemon's environment: the variables a sign-in config from before issue #216 named its secrets by (`clientSecretEnv`). */
export const SECRETS = { CORP_CLIENT_SECRET: 'shh', GITHUB_CLIENT_SECRET: 'gh-secret', LDAP_BIND_PASSWORD: 'GoodNewsEveryone' };

export interface Harness { t: TestApp | undefined; cleanup: (() => void) | undefined; stops: (() => unknown)[] }
export const harness = (): Harness => ({ t: undefined, cleanup: undefined, stops: [] });

export async function stopAll(h: Harness): Promise<void> {
  await h.t?.stop();
  h.t = undefined;
  for (const s of h.stops.splice(0)) await s();
  h.cleanup?.();
}

/**
 * The app with this sign-in config (a fresh hopper's when undefined: no realm, the login code on), and
 * its sign-in origin (http://localhost:<port>). `env`: the daemon's HOPPER_* config;
 * `runtime`: more of its environment over SECRETS (HOPPER_SIGN_IN_* variables).
 */
export async function startWithAuth(h: Harness, auth: unknown, env: Record<string, string> = {}, runtime: Record<string, string> = {}): Promise<{ app: TestApp; origin: string; host: string }> {
  const db = tempDbPath();
  h.cleanup = db.cleanup;
  if (auth !== undefined) writeConfig(db.dbPath, 'sign-in', auth);
  h.t = await startTestApp({ dbPath: db.dbPath, env, secrets: { ...SECRETS, ...runtime } });
  const port = new URL(h.t.url).port;
  return { app: h.t, origin: `http://localhost:${port}`, host: `localhost:${port}` };
}

/** Restart on the same store with this sign-in config. */
export async function restartWithAuth(h: Harness, app: TestApp, auth: unknown, env: Record<string, string> = {}): Promise<TestApp> {
  await app.stop();
  writeConfig(app.dbPath, 'sign-in', auth);
  h.t = await startTestApp({ dbPath: app.dbPath, env, secrets: { ...SECRETS } });
  return h.t;
}

/** Restart on the same store, its sign-in config as it is. `env`: the daemon's HOPPER_* config. */
export async function restartSame(h: Harness, app: TestApp, env: Record<string, string> = {}): Promise<TestApp> {
  await app.stop();
  h.t = await startTestApp({ dbPath: app.dbPath, env, secrets: { ...SECRETS } });
  return h.t;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read loose JSON
export const session = async (app: TestApp, token?: string): Promise<any> => JSON.parse((await rawRequest(app.url, {
  path: '/ui/api/session', headers: token ? { 'x-hopper-session': token } : {},
})).text);

export async function oidcIdp(h: Harness, o: { claims?: Record<string, unknown>; userinfo?: Record<string, unknown> } = {}): Promise<OidcIdp> {
  const idp = await startOidcIdp();
  h.stops.push(() => idp.stop());
  Object.assign(idp.claims, o.claims);
  Object.assign(idp.userinfo, o.userinfo);
  return idp;
}

export const oidcRealm = (idp: Pick<OidcIdp, 'issuer'>, roles: unknown, extra: Record<string, unknown> = {}) =>
  ({ name: 'corp', label: 'Corp SSO', type: 'oidc', issuer: idp.issuer, clientId: 'hopper', clientSecret: 'shh', roles, ...extra });
