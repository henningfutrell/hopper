// No bootstrap login (issue #238, docs/sign-in.md "No bootstrap login"): a new hopper creates no user, no
// account and no password, and its start hands out no login code — not on a hopper from before either.
// The way in is a realm — every hopper offers GitHub (issue #214) — and each identity's first sign-in makes
// its own user. There is no password realm and no username-and-password account of the hopper's own
// (issue #237). Edge realms (LDAP, OIDC, GitHub, SAML, gateway) stay.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TestApp } from '../support/app.ts';
import { signIn } from '../support/idp.ts';
import { harness, oidcIdp, oidcRealm, restartSame, session, startNewHopper, startWithAuth, stopAll } from '../support/sign-in-app.ts';

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

describe('a new hopper: no bootstrap login (issue #238)', () => {
  it('holds no user; only the github realm; its start logs no login code and no password', async () => {
    const lines = startLines();
    const o = await startNewHopper(h, undefined);
    expect(o.app.app.instance.users.list()).toEqual([]);
    expect(stored(o.app).realms).toEqual([{ name: 'github', label: 'GitHub', type: 'github' }]);
    expect(codeIn(lines())).toBeUndefined();
    expect(lines().filter((l) => /first sign-in|password/.test(l))).toEqual([]);
    expect((await session(o.app)).signIn).toMatchObject({ password: false, devices: [{ name: 'github', label: 'GitHub', type: 'github' }] });
  });

  it('a second start hands out nothing either and adds no user', async () => {
    const o = await startNewHopper(h, undefined);
    const lines = startLines();
    const again = await restartSame(h, o.app);
    expect(codeIn(lines())).toBeUndefined();
    expect(again.app.instance.users.list()).toEqual([]);
  });

  it('a hopper from before: its start hands out no login code for admin either', async () => {
    const lines = startLines();
    await startWithAuth(h, { version: 1, realms: [] });
    expect(codeIn(lines())).toBeUndefined();
  });

  it('the first identity a realm signs in gets a user of its own', async () => {
    const idp = await oidcIdp(h, { claims: { email: 'ada@example.com', email_verified: true, name: 'Ada', preferred_username: 'ada' } });
    const o = await startNewHopper(h, { version: 1, realms: [oidcRealm(idp, { admin: { emails: ['ada@example.com'] } })] });
    const run = await signIn(o.app.url, o.origin, 'corp');
    expect(await session(o.app, run.token)).toMatchObject({ authenticated: true, user: { id: 'ada', name: 'ada', role: 'admin', realm: 'corp' } });
    expect(o.app.app.instance.users.list().map((u) => [u.id, u.workDir])).toEqual([['ada', 'users/ada']]);
  });

  it('a sign-in config with no way in is left as it is: the login code is not turned on', async () => {
    const lines = startLines();
    const o = await startNewHopper(h, { version: 1, local: { enabled: false }, realms: [] });
    expect(stored(o.app).local).toEqual({ enabled: false });
    expect(lines().some((l) => l.includes('login code is turned on'))).toBe(false);
  });
});

describe('the password user realm is gone', () => {
  it('Settings refuses a password realm', async () => {
    const o = await startWithAuth(h, undefined);
    const admin = await o.app.login();
    const r = await change(o.app, admin, { action: 'save', realm: { name: 'password', type: 'password' } });
    expect(r.status).toBe(400);
    expect(stored(o.app).realms.map((x) => x.type)).toEqual(['github']);
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
