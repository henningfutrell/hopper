// Bootstrap with the login key (issue #237, docs/sign-in.md "First sign-in"): there is no password
// realm and no username-and-password account of the hopper's own. A start at which nobody can sign in
// as the default admin account through a realm that is on logs a one-time login code for it, the way
// Jenkins logs its first admin's key; the code signs in once as admin. A sign-in config that would leave
// no way in at all keeps the login code on. Edge realms (LDAP, OIDC, GitHub, SAML, gateway) stay.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TestApp } from '../support/app.ts';
import { rawRequest } from '../support/http.ts';
import { harness, oidcIdp, oidcRealm, restartSame, restartWithAuth, session, startWithAuth, stopAll } from '../support/sign-in-app.ts';

const h = harness();
afterEach(async () => { vi.restoreAllMocks(); await stopAll(h); });

const startLines = (): (() => string[]) => {
  const spies = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn')];
  return () => spies.flatMap((spy) => spy.mock.calls.map((c) => String(c[0])));
};
/** The login code a start line hands out, or undefined. */
const codeIn = (lines: string[]): string | undefined => lines.map((l) => /login code ([0-9a-f]{64})/.exec(l)?.[1]).find((c) => c !== undefined);
const stored = (app: TestApp) => app.app.instance.signInConfig.read();
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read loose JSON
const realms = async (app: TestApp, token: string): Promise<any> => (await app.api('GET', '/api/realms', undefined, { 'x-hopper-session': token })).body;
const change = async (app: TestApp, token: string, body: Record<string, unknown>) =>
  app.ui<{ error?: string }>('/ui/api/realms', { ...body, version: (await realms(app, token)).version }, { token });

describe('a fresh hopper bootstraps with the login key', () => {
  it('has no realm; the start logs a one-time login code that signs in once as admin', async () => {
    const lines = startLines();
    const o = await startWithAuth(h, undefined);
    expect(stored(o.app).realms).toEqual([]);
    const code = codeIn(lines());
    expect(code).toBeDefined();
    const token = await o.app.loginWith(code!);
    expect(await session(o.app, token)).toMatchObject({ user: { id: 'admin', role: 'admin', realm: 'local' } });
    await expect(o.app.loginWith(code!)).rejects.toThrow(/login failed/);
  });

  it('offers no username and password form: password sign-in is off', async () => {
    const o = await startWithAuth(h, undefined);
    expect((await session(o.app)).signIn).toMatchObject({ local: true, password: false, realms: [] });
    const res = await rawRequest(o.app.url, {
      path: '/ui/auth/password', method: 'POST', body: JSON.stringify({ username: 'admin', password: 'anything at all' }),
      headers: { host: o.host, origin: o.origin, 'content-type': 'application/json' },
    });
    expect(res.status).toBe(403);
  });

  it('no login code is logged while admin signs in through a realm that is on; one is again when that realm is off', async () => {
    const idp = await oidcIdp(h);
    const realm = oidcRealm(idp, { defaultRole: 'admin' });
    const o = await startWithAuth(h, { version: 1, realms: [realm] });
    o.app.app.instance.identities.link('corp', 'ada-subject', 'admin');
    let lines = startLines();
    await restartSame(h, o.app);
    expect(codeIn(lines())).toBeUndefined();
    vi.restoreAllMocks();
    lines = startLines();
    await restartWithAuth(h, h.t!, { version: 1, realms: [{ ...realm, enabled: false }] });
    expect(codeIn(lines())).toBeDefined();
  });

  it('no login code is logged while the login code is off', async () => {
    const idp = await oidcIdp(h);
    const lines = startLines();
    await startWithAuth(h, { version: 1, local: { enabled: false }, realms: [oidcRealm(idp, { defaultRole: 'viewer' })] });
    expect(codeIn(lines())).toBeUndefined();
  });

  it('a sign-in config with no way in keeps the login code on', async () => {
    const lines = startLines();
    const o = await startWithAuth(h, { version: 1, local: { enabled: false }, realms: [] });
    expect(stored(o.app).local).toEqual({ enabled: true });
    expect(lines().some((l) => l.includes('no way to sign in') && l.includes('login code'))).toBe(true);
    expect(codeIn(lines())).toBeDefined();
  });
});

describe('the password user realm is gone', () => {
  it('Settings refuses a password realm', async () => {
    const o = await startWithAuth(h, undefined);
    const admin = await o.app.login();
    const r = await change(o.app, admin, { action: 'save', realm: { name: 'password', type: 'password' } });
    expect(r.status).toBe(400);
    expect(stored(o.app).realms).toEqual([]);
  });

  it('a stored password realm stops the daemon at start, naming the field', async () => {
    await expect(startWithAuth(h, { version: 1, realms: [{ name: 'password', type: 'password' }] })).rejects.toThrow(/realms\.0\.type/);
  });

  it('the environment cannot set up a password realm or an admin password', async () => {
    await expect(startWithAuth(h, undefined, {}, { HOPPER_SIGN_IN_REALM_PW_TYPE: 'password' })).rejects.toThrow(/HOPPER_SIGN_IN_REALM_PW_TYPE/);
    await stopAll(h);
    await expect(startWithAuth(h, undefined, {}, { HOPPER_SIGN_IN_ADMIN_PASSWORD: 'chosen at deploy' })).rejects.toThrow(/HOPPER_SIGN_IN_ADMIN_PASSWORD/);
  });

  it('there is no route to change your own password', async () => {
    const o = await startWithAuth(h, undefined);
    const admin = await o.app.login();
    const r = await o.app.ui('/ui/api/password', { current: 'x', password: 'long enough' }, { token: admin });
    expect(r.status).toBe(404);
  });

  it('a realm that is on keeps working at a restart, with no account added', async () => {
    const idp = await oidcIdp(h, { claims: { email: 'ada@example.com', email_verified: true } });
    const o = await startWithAuth(h, { version: 1, realms: [oidcRealm(idp, { admin: { emails: ['ada@example.com'] } })] });
    const app = await restartSame(h, o.app);
    expect(stored(app).realms.map((r) => r.name)).toEqual(['corp']);
  });
});
