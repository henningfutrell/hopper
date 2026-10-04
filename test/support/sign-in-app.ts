// The daemon side of sign-in tests: start the real app with an auth.yaml, read GET /ui/api/session,
// start loopback OIDC issuers. Everything started is stopped by `stopAll` (call it in afterEach).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { startTestApp, tempDbPath, type TestApp } from './app.ts';
import { rawRequest } from './http.ts';
import { startOidcIdp, type OidcIdp } from './idp.ts';

export interface Harness { t: TestApp | undefined; cleanup: (() => void) | undefined; stops: (() => unknown)[] }
export const harness = (): Harness => ({ t: undefined, cleanup: undefined, stops: [] });

export async function stopAll(h: Harness): Promise<void> {
  await h.t?.stop();
  h.t = undefined;
  for (const s of h.stops.splice(0)) await s();
  h.cleanup?.();
}

/** The app with this auth.yaml (none when undefined), and its sign-in origin (http://localhost:<port>). */
export async function startWithAuth(h: Harness, auth: unknown, env: Record<string, string> = {}): Promise<{ app: TestApp; origin: string; host: string }> {
  const db = tempDbPath();
  h.cleanup = db.cleanup;
  const file = join(db.dbPath, '..', 'auth.yaml');
  if (auth !== undefined) writeFileSync(file, stringify(auth), { mode: 0o600 });
  h.t = await startTestApp({ dbPath: db.dbPath, env: { JOB_HOPPER_AUTH_FILE: file, ...env } });
  const port = new URL(h.t.url).port;
  return { app: h.t, origin: `http://localhost:${port}`, host: `localhost:${port}` };
}

/** Restart on the same store with this auth.yaml. */
export async function restartWithAuth(h: Harness, app: TestApp, auth: unknown): Promise<TestApp> {
  const file = app.app.config.authFile;
  await app.stop();
  writeFileSync(file, stringify(auth), { mode: 0o600 });
  h.t = await startTestApp({ dbPath: app.dbPath, env: { JOB_HOPPER_AUTH_FILE: file } });
  return h.t;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read loose JSON
export const session = async (app: TestApp, token?: string): Promise<any> => JSON.parse((await rawRequest(app.url, {
  path: '/ui/api/session', headers: token ? { 'x-jobhopper-session': token } : {},
})).text);

export async function oidcIdp(h: Harness, o: { claims?: Record<string, unknown>; userinfo?: Record<string, unknown> } = {}): Promise<OidcIdp> {
  const idp = await startOidcIdp();
  h.stops.push(() => idp.stop());
  Object.assign(idp.claims, o.claims);
  Object.assign(idp.userinfo, o.userinfo);
  return idp;
}

export const oidcProvider = (idp: Pick<OidcIdp, 'issuer'>, roles: unknown, extra: Record<string, unknown> = {}) =>
  ({ name: 'corp', label: 'Corp SSO', type: 'oidc', issuer: idp.issuer, clientId: 'hopper', clientSecret: 'shh', roles, ...extra });
