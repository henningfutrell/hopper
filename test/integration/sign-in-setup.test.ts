// Setting sign-in up (issue #216, docs/sign-in.md): a realm's secrets are set in the UI and stored with
// it, never answered back; realms, the login code and no sign-in can be injected through HOPPER_SIGN_IN_*
// variables at launch, written to the database at each start; and the password fallback's admin account
// (issue #219: a random password at start, the way Nexus, Jenkins and Argo bootstrap their first admin)
// can take its password from HOPPER_SIGN_IN_ADMIN_PASSWORD instead.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startTestApp, type TestApp } from '../support/app.ts';
import { rawRequest } from '../support/http.ts';
import { signIn } from '../support/idp.ts';
import { harness, oidcIdp, oidcRealm, session, startWithAuth, stopAll } from '../support/sign-in-app.ts';

const h = harness();
afterEach(async () => { vi.restoreAllMocks(); await stopAll(h); });

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read loose JSON
const realms = async (app: TestApp, token: string): Promise<any> => (await app.api('GET', '/api/realms', undefined, { 'x-hopper-session': token })).body;
const change = async (app: TestApp, token: string, body: Record<string, unknown>) =>
  app.ui<{ error?: string }>('/ui/api/realms', { ...body, version: (await realms(app, token)).version }, { token });
const passwordSignIn = async (o: { app: TestApp; origin: string; host: string }, username: string, password: string) => {
  const res = await rawRequest(o.app.url, {
    path: '/ui/auth/password', method: 'POST', body: JSON.stringify({ username, password }),
    headers: { host: o.host, origin: o.origin, 'content-type': 'application/json' },
  });
  return { status: res.status, token: res.status === 200 ? (JSON.parse(res.text) as { token: string }).token : undefined };
};
const stored = (app: TestApp) => app.app.instance.signInConfig.read();
const storedRealm = (app: TestApp, name: string) => stored(app).realms.find((r) => r.name === name);

describe('a realm\'s secret is set in the UI and stored with it', () => {
  it('saved with the realm, used by it, never answered back; a save without it keeps it', async () => {
    const idp = await oidcIdp(h, { claims: { email: 'ada@example.com', email_verified: true } });
    const o = await startWithAuth(h, { version: 1 });
    const admin = await o.app.login();
    const realm = { ...oidcRealm(idp, { operator: { emails: ['ada@example.com'] } }), clientSecret: 'typed-in-the-ui' };
    expect((await change(o.app, admin, { action: 'save', realm })).status).toBe(200);
    expect(storedRealm(o.app, 'corp')).toMatchObject({ clientSecret: 'typed-in-the-ui' });
    const v = await realms(o.app, admin);
    expect(v.realms.find((r: { name: string }) => r.name === 'corp').secrets).toEqual(['clientSecret']);
    expect(JSON.stringify(v)).not.toContain('typed-in-the-ui');
    const { clientSecret: _s, ...withoutSecret } = realm;
    expect((await change(o.app, admin, { action: 'save', name: 'corp', realm: { ...withoutSecret, label: 'Corp' } })).status).toBe(200);
    expect(storedRealm(o.app, 'corp')).toMatchObject({ label: 'Corp', clientSecret: 'typed-in-the-ui' });
    const run = await signIn(o.app.url, o.origin, 'corp');
    expect(await session(o.app, run.token)).toMatchObject({ user: { realm: 'corp', role: 'operator' } });
  });

  it('a GitHub realm without its secret is refused, naming the field; nothing is stored', async () => {
    const o = await startWithAuth(h, { version: 1 });
    const admin = await o.app.login();
    const r = await change(o.app, admin, { action: 'save', realm: { name: 'gh', type: 'github', clientId: 'g' } });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/realms\.1\.clientSecret/);
    expect(stored(o.app).realms.map((x) => x.name)).toEqual(['password']);
  });

  it('a stored realm that named its secret\'s variable takes the secret into the database at the next start', async () => {
    const legacy = { version: 1, realms: [{ name: 'corp', type: 'oidc', issuer: 'https://idp.example.com', clientId: 'c', clientSecretEnv: 'CORP_CLIENT_SECRET' }] };
    const o = await startWithAuth(h, legacy);
    expect(storedRealm(o.app, 'corp')).toEqual({ name: 'corp', type: 'oidc', issuer: 'https://idp.example.com', clientId: 'c', clientSecret: 'shh' });
  });
});

describe('sign-in from the environment', () => {
  const ENV = (idp: { issuer: string }) => ({
    HOPPER_SIGN_IN_REALM_CORP_TYPE: 'oidc', HOPPER_SIGN_IN_REALM_CORP_LABEL: 'Corp SSO', HOPPER_SIGN_IN_REALM_CORP_ISSUER: idp.issuer,
    HOPPER_SIGN_IN_REALM_CORP_CLIENT_ID: 'hopper', HOPPER_SIGN_IN_REALM_CORP_CLIENT_SECRET: 'from-the-env',
    HOPPER_SIGN_IN_REALM_CORP_ROLES_ADMIN_EMAILS: 'ada@example.com',
  });

  it('a realm set up by HOPPER_SIGN_IN_* variables is in the database at start, signs people in, and shows where it came from', async () => {
    const idp = await oidcIdp(h, { claims: { email: 'ada@example.com', email_verified: true } });
    const o = await startWithAuth(h, undefined, {}, ENV(idp));
    expect(stored(o.app).realms.map((r) => r.name)).toEqual(['password', 'corp']);
    expect(stored(o.app).realms[1]).toMatchObject({ clientSecret: 'from-the-env', roles: { admin: { emails: ['ada@example.com'] } } });
    const run = await signIn(o.app.url, o.origin, 'corp');
    expect(await session(o.app, run.token)).toMatchObject({ user: { realm: 'corp', role: 'admin' } });
    const v = await realms(o.app, run.token!);
    expect(v.realms.map((r: { name: string; environment?: boolean }) => [r.name, r.environment === true])).toEqual([['password', false], ['corp', true]]);
  });

  it('the environment wins at every start; without it the stored realm stays', async () => {
    const idp = await oidcIdp(h);
    const o = await startWithAuth(h, undefined, {}, ENV(idp));
    const admin = await o.app.login();
    expect((await change(o.app, admin, { action: 'save', name: 'corp', realm: { name: 'corp', type: 'oidc', issuer: idp.issuer, clientId: 'changed-in-ui' } })).status).toBe(200);
    await o.app.stop();
    h.t = await startTestApp({ dbPath: o.app.dbPath, secrets: { ...ENV(idp) } });
    expect(stored(h.t).realms[1]).toMatchObject({ clientId: 'hopper', clientSecret: 'from-the-env' });
    await h.t.stop();
    h.t = await startTestApp({ dbPath: o.app.dbPath, secrets: {} });
    expect(stored(h.t).realms[1]).toMatchObject({ clientId: 'hopper', clientSecret: 'from-the-env' });
  });

  it('the login code and no sign-in from the environment', async () => {
    const o = await startWithAuth(h, undefined, {}, { HOPPER_SIGN_IN_LOCAL_ENABLED: 'false', HOPPER_SIGN_IN_NONE_ROLE: 'viewer' });
    expect((await session(o.app)).signIn).toMatchObject({ local: false, none: 'viewer' });
  });

  it('a variable the hopper cannot use stops it at start, naming the variable; nothing is written', async () => {
    await expect(startWithAuth(h, undefined, {}, { HOPPER_SIGN_IN_REALM_CORP_TYPE: 'oidc', HOPPER_SIGN_IN_REALM_CORP_ISSUER: 'https://idp.example.com' }))
      .rejects.toThrow(/HOPPER_SIGN_IN_REALM_CORP_CLIENT_ID/);
  });
});

describe('the password fallback\'s password from the environment', () => {
  it('HOPPER_SIGN_IN_ADMIN_PASSWORD is the password of the admin account the start adds; it is not logged', async () => {
    const lines = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn')];
    const o = await startWithAuth(h, undefined, {}, { HOPPER_SIGN_IN_ADMIN_PASSWORD: 'chosen at deploy' });
    const logged = lines.flatMap((spy) => spy.mock.calls.map((c) => String(c[0])));
    expect(logged.some((l) => l.includes('chosen at deploy'))).toBe(false);
    expect(logged.some((l) => l.includes('added account admin') && l.includes('HOPPER_SIGN_IN_ADMIN_PASSWORD'))).toBe(true);
    const admin = await passwordSignIn(o, 'admin', 'chosen at deploy');
    expect(admin.status).toBe(200);
    expect(await session(o.app, admin.token)).toMatchObject({ user: { id: 'admin', role: 'admin', realm: 'password' } });
  });

  it('a start that adds no account leaves the password realm as it is', async () => {
    const o = await startWithAuth(h, undefined);
    const before = stored(o.app);
    await o.app.stop();
    h.t = await startTestApp({ dbPath: o.app.dbPath, secrets: { HOPPER_SIGN_IN_ADMIN_PASSWORD: 'chosen at deploy' } });
    expect(stored(h.t)).toEqual(before);
  });
});
