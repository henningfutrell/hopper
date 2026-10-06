// Sign-in (issue #39, design.md "Sign-in: realms"): local sign-in, and OIDC end to end
// through the daemon's HTTP routes against a loopback issuer.
import { afterEach, describe, expect, it } from 'vitest';
import { rawRequest } from '../support/http.ts';
import { signIn } from '../support/idp.ts';
import { harness, oidcIdp, oidcRealm, restartWithAuth, session, startWithAuth, stopAll } from '../support/sign-in-app.ts';

const h = harness();
afterEach(() => stopAll(h));
const start = (auth: unknown, env?: Record<string, string>) => startWithAuth(h, auth, env);
const oidc = (o?: Parameters<typeof oidcIdp>[1]) => oidcIdp(h, o);
// Issue #183: every page the daemon serves shows the app's icon.
const ICON = '<link rel="icon" type="image/svg+xml" href="/favicon.svg">';

describe('a fresh hopper: the login code and the password fallback', () => {
  it('the session view offers the login code, the password form and no redirect realms', async () => {
    const { app, origin } = await start(undefined);
    expect(await session(app)).toEqual({ authenticated: false, viewing: { id: 'owner', name: 'owner' }, signIn: { local: true, none: null, password: true, gateway: false, origin, realms: [], required: false } });
  });

  it('the login code signs in as admin, provider local', async () => {
    const { app } = await start(undefined);
    const token = await app.login();
    expect(await session(app, token)).toMatchObject({ authenticated: true, expiresAt: expect.any(String), user: { id: 'owner', name: 'owner', role: 'admin', realm: 'local', identity: 'login code' } });
  });
});

describe('local sign-in turned off', () => {
  it('ends the login-code sessions made before, at the next start', async () => {
    const { app } = await start(undefined);
    const token = await app.login();
    const after = await restartWithAuth(h, app, { version: 1, local: { enabled: false } });
    expect((await session(after, token)).authenticated).toBe(false);
  });

  it('no login code file, POST /ui/login refused, no device link', async () => {
    const { app } = await start({ version: 1, local: { enabled: false } });
    expect((await session(app)).signIn.local).toBe(false);
    await expect(app.login()).rejects.toThrow();
    const res = await rawRequest(app.url, { method: 'POST', path: '/ui/login', body: 'code=x', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(res.status).toBe(403);
  });
});

describe('OIDC', () => {
  it('signs in with a verified email granted a role; the session names the user', async () => {
    const idp = await oidc({ claims: { email: 'ada@example.com', email_verified: true, name: 'Ada' } });
    const { app, origin } = await start({ version: 1, realms: [oidcRealm(idp, { operator: { emails: ['ada@example.com'] } })] });
    expect((await session(app)).signIn.realms).toEqual([{ name: 'corp', label: 'Corp SSO', type: 'oidc' }]);
    const run = await signIn(app.url, origin, 'corp');
    expect(run.start.status).toBe(302);
    expect(run.callback?.status).toBe(200);
    expect(run.complete?.status).toBe(200);
    expect(await session(app, run.token)).toMatchObject({ authenticated: true, user: { role: 'operator', realm: 'corp', name: 'Ada' } });
  });

  it('groups from userinfo grant a role', async () => {
    const idp = await oidc({ userinfo: { groups: ['hopper-admins'] } });
    const { app, origin } = await start({ version: 1, realms: [oidcRealm(idp, { admin: { groups: ['hopper-admins'] } })] });
    const run = await signIn(app.url, origin, 'corp');
    expect((await session(app, run.token)).user.role).toBe('admin');
  });

  it('an unverified email grants nothing unless the provider trusts it', async () => {
    const idp = await oidc({ claims: { email: 'ada@example.com' } });
    const { app, origin } = await start({ version: 1, realms: [oidcRealm(idp, { admin: { emails: ['ada@example.com'] } })] });
    const run = await signIn(app.url, origin, 'corp');
    expect(run.callback?.status).toBe(403);
    expect(run.callback?.text).toMatch(/no role/);
    expect(run.token).toBeUndefined();
  });

  it('trustUnverifiedEmail counts the email', async () => {
    const idp = await oidc({ claims: { email: 'ada@example.com' } });
    const { app, origin } = await start({ version: 1, realms: [oidcRealm(idp, { admin: { emails: ['ada@example.com'] } }, { trustUnverifiedEmail: true })] });
    expect((await session(app, (await signIn(app.url, origin, 'corp')).token)).user.role).toBe('admin');
  });

  it('no matching rule and no default role: signed in at the provider, but no session', async () => {
    const idp = await oidc();
    const { app, origin } = await start({ version: 1, realms: [oidcRealm(idp, {})] });
    const run = await signIn(app.url, origin, 'corp');
    expect(run.callback?.status).toBe(403);
    expect(run.complete).toBeUndefined();
  });

  it('the default role lets every signed-in account in', async () => {
    const idp = await oidc();
    const { app, origin } = await start({ version: 1, realms: [oidcRealm(idp, { defaultRole: 'viewer' })] });
    expect((await session(app, (await signIn(app.url, origin, 'corp')).token)).user).toMatchObject({ role: 'viewer', name: 'johndoe' });
  });

  it('a callback completed by another browser (other binding) signs nobody in', async () => {
    const idp = await oidc();
    const { app, origin } = await start({ version: 1, realms: [oidcRealm(idp, { defaultRole: 'admin' })] });
    const run = await signIn(app.url, origin, 'corp', { completeBinding: 'b'.repeat(40) });
    expect(run.callback?.status).toBe(200);
    expect(run.complete?.status).toBe(403);
    expect(run.token).toBeUndefined();
  });

  it('a callback with an unknown state is refused', async () => {
    const idp = await oidc();
    const { app, host } = await start({ version: 1, realms: [oidcRealm(idp, { defaultRole: 'admin' })] });
    const res = await rawRequest(app.url, { path: '/ui/auth/corp/callback?code=x&state=nope', headers: { host } });
    expect(res.status).toBe(400);
    expect(res.text).toContain(ICON);
  });

  it('a ticket works once', async () => {
    const idp = await oidc();
    const { app, origin, host } = await start({ version: 1, realms: [oidcRealm(idp, { defaultRole: 'admin' })] });
    const binding = 'a'.repeat(40);
    const run = await signIn(app.url, origin, 'corp', { binding });
    expect(run.token).toBeDefined();
    expect(run.callback!.text).toContain(ICON);
    const again = await rawRequest(app.url, { method: 'POST', path: '/ui/auth/complete', body: run.complete ? JSON.stringify({ ticket: /'([0-9a-f]{64})'/.exec(run.callback!.text)![1], binding }) : '{}',
      headers: { host, origin, 'content-type': 'application/json' } });
    expect(again.status).toBe(403);
  });

  it('completing from another origin is refused', async () => {
    const idp = await oidc();
    const { app, origin, host } = await start({ version: 1, realms: [oidcRealm(idp, { defaultRole: 'admin' })] });
    const binding = 'c'.repeat(40);
    const run = await signIn(app.url, origin, 'corp', { binding, completeBinding: 'd'.repeat(40) });
    const ticket = /'([0-9a-f]{64})'/.exec(run.callback!.text)![1];
    const res = await rawRequest(app.url, { method: 'POST', path: '/ui/auth/complete', body: JSON.stringify({ ticket, binding }),
      headers: { host, origin: 'http://evil.example', 'content-type': 'application/json' } });
    expect(res.status).toBe(403);
  });

  it('start without a binding, or for an unknown provider, is refused', async () => {
    const idp = await oidc();
    const { app, host } = await start({ version: 1, realms: [oidcRealm(idp, { defaultRole: 'admin' })] });
    expect((await rawRequest(app.url, { path: '/ui/auth/corp/start', headers: { host } })).status).toBe(400);
    expect((await rawRequest(app.url, { path: `/ui/auth/nope/start?binding=${'a'.repeat(40)}`, headers: { host } })).status).toBe(404);
  });

  it('start on another origin than the sign-in origin is refused (the binding would not come back)', async () => {
    const idp = await oidc();
    const { app } = await start({ version: 1, realms: [oidcRealm(idp, { defaultRole: 'admin' })] });
    const res = await rawRequest(app.url, { path: `/ui/auth/corp/start?binding=${'a'.repeat(40)}` });
    expect(res.status).toBe(409);
    expect(res.text).toMatch(/localhost/);
  });
});

