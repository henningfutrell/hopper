// Sign-in is managed in the UI (issues #185, #198, #200, design.md "Sign-in: realms"): an admin reads the
// realms (GET /api/realms) and adds, changes, removes, orders and turns them on and off from their
// fields, and adds, changes and removes a password realm's accounts (POST /ui/api/realms). Everything
// is in the database, every setting a field; no YAML or JSON to write. A change applies at once, without a restart: the sign-in
// on offer follows it, and stored sessions follow it as they do at start. A change that would end the
// acting admin's own admin session is refused, so nobody locks themselves out from the UI.
import argon2 from 'argon2';
import { afterEach, beforeAll, describe, expect, it, vi, type MockInstance } from 'vitest';
import { rawRequest } from '../support/http.ts';
import { harness, oidcIdp, oidcRealm, restartSame, session, startWithAuth, stopAll } from '../support/sign-in-app.ts';
import type { TestApp } from '../support/app.ts';

const h = harness();
afterEach(() => stopAll(h));

let hash = '';
beforeAll(async () => { hash = await argon2.hash('correct horse', { type: argon2.argon2id }); });

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read loose JSON
const realms = async (app: TestApp, token: string): Promise<any> => (await app.api('GET', '/api/realms', undefined, { 'x-hopper-session': token })).body;
const edit = (app: TestApp, token: string, body: Record<string, unknown>) => app.ui<{ error?: string; version?: string }>('/ui/api/realms', body, { token });
/** One change against the version read now. */
const change = async (app: TestApp, token: string, body: Record<string, unknown>) => edit(app, token, { ...body, version: (await realms(app, token)).version });

/** The password fallback (issue #219), so a test may change staff freely. */
const fallback = () => ({ name: 'password', type: 'password', users: [{ username: 'root', passwordHash: hash, role: 'admin' }] });
const staff = (role = 'operator') => ({ version: 1, realms: [{ name: 'staff', type: 'password', users: [{ username: 'ada', passwordHash: hash, role }] }, fallback()] });
const passwordSignIn = async (o: { app: TestApp; origin: string; host: string }, username: string, password: string) => {
  const res = await rawRequest(o.app.url, {
    path: '/ui/auth/password', method: 'POST', body: JSON.stringify({ username, password }),
    headers: { host: o.host, origin: o.origin, 'content-type': 'application/json' },
  });
  return { status: res.status, token: res.status === 200 ? (JSON.parse(res.text) as { token: string }).token : undefined };
};

/** The account and password a start added for the password fallback, from its start line (issue #219). */
const fallbackOf = (warn: MockInstance): { username: string; password: string } => {
  const line = warn.mock.calls.map((c) => String(c[0])).find((l) => l.includes('password fallback'))!;
  const m = /added account (\S+) to realm \S+, password (\S+) /.exec(line)!;
  return { username: m[1]!, password: m[2]! };
};

describe('a fresh hopper', () => {
  it('offers the password form at once: the account admin, with a password made at start and shown once in its start lines, signs in as owner, admin', async () => {
    const warn = vi.spyOn(console, 'warn');
    const o = await startWithAuth(h, undefined);
    const { username, password } = fallbackOf(warn);
    warn.mockRestore();
    expect(username).toBe('admin');
    expect(password).toMatch(/^[A-Za-z0-9_-]{24,}$/);
    expect((await session(o.app)).signIn.password).toBe(true);
    const admin = (await passwordSignIn(o, username, password)).token;
    expect(await session(o.app, admin)).toMatchObject({ user: { id: 'owner', realm: 'password', role: 'admin' } });
    const v = await realms(o.app, admin!);
    expect(v.realms).toEqual([{ name: 'password', label: 'Password', type: 'password', enabled: true, settings: {}, secrets: [], accounts: [{ username: 'admin', role: 'admin', user: { id: 'owner', name: 'owner' } }] }]);
    expect(JSON.stringify(o.app.app.instance.signInConfig.read())).not.toContain(password);
  });

  it('a second start keeps the account and makes no new password', async () => {
    const warn = vi.spyOn(console, 'warn');
    const o = await startWithAuth(h, undefined);
    const { username, password } = fallbackOf(warn);
    warn.mockClear();
    const again = await restartSame(h, o.app);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('password fallback'))).toBe(false);
    warn.mockRestore();
    const port = new URL(again.url).port;
    expect((await passwordSignIn({ app: again, origin: `http://localhost:${port}`, host: `localhost:${port}` }, username, password)).status).toBe(200);
  });

  it('a sign-in config left without an admin password account gets one at the next start', async () => {
    const warn = vi.spyOn(console, 'warn');
    const o = await startWithAuth(h, { version: 1, realms: [staff('viewer').realms[0]] });
    const { username, password } = fallbackOf(warn);
    warn.mockRestore();
    expect(username).toBe('admin');
    expect((await passwordSignIn(o, 'ada', 'correct horse')).status).toBe(200);
    expect((await passwordSignIn(o, username, password)).status).toBe(200);
    expect(o.app.app.instance.signInConfig.read().realms[0]!.users!.map((u) => [u.username, u.role])).toEqual([['ada', 'viewer'], ['admin', 'admin']]);
  });
});

describe('POST /ui/api/realms: the password fallback (issue #219)', () => {
  it.each([
    ['turning its realm off', { action: 'enable', name: 'staff', enabled: false }],
    ['removing its realm', { action: 'remove', name: 'staff' }],
    ['removing the last admin account', { action: 'account-remove', realm: 'staff', username: 'ada' }],
    ['demoting the last admin account', { action: 'account', realm: 'staff', username: 'ada', role: 'operator' }],
  ])('refuses %s', async (_what, body) => {
    const o = await startWithAuth(h, { version: 1, realms: [staff('admin').realms[0]] });
    const admin = await o.app.login();
    const r = await change(o.app, admin, body);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/fallback/);
    expect((await session(o.app)).signIn.password).toBe(true);
  });

  it('allows it once another admin account in a password realm that is on holds the fallback', async () => {
    const o = await startWithAuth(h, { version: 1, realms: [staff('admin').realms[0]] });
    const admin = await o.app.login();
    expect((await change(o.app, admin, { action: 'account', realm: 'staff', username: 'bea', password: 'correct horse', role: 'admin' })).status).toBe(200);
    expect((await change(o.app, admin, { action: 'account-remove', realm: 'staff', username: 'ada' })).status).toBe(200);
  });
});

describe('GET /api/realms', () => {
  it('an admin reads every realm, in order, with its settings, the accounts without their hashes, and the version', async () => {
    const o = await startWithAuth(h, { version: 1, realms: [staff().realms[0], { name: 'gh', type: 'github', clientId: 'g', clientSecret: 'gh-secret', enabled: false }, fallback()] });
    const v = await realms(o.app, await o.app.login());
    expect(v).toMatchObject({ local: true, none: null, origin: o.origin, version: expect.any(String) });
    expect(v.realms.map((r: { name: string; type: string; enabled: boolean }) => [r.name, r.type, r.enabled])).toEqual([['staff', 'password', true], ['gh', 'github', false], ['password', 'password', true]]);
    expect(v.realms[0].accounts).toEqual([{ username: 'ada', role: 'operator' }]);
    expect(v.realms[1].settings).toEqual({ clientId: 'g' });
    expect(v.realms[1].secrets).toEqual(['clientSecret']);
    expect(v.realms[1].callback).toBe(`${o.origin}/ui/auth/gh/callback`);
    expect(JSON.stringify(v)).not.toContain('argon2');
    expect(JSON.stringify(v)).not.toContain('gh-secret');
  });

  it('a session that is not admin is refused', async () => {
    const o = await startWithAuth(h, { version: 1, none: { role: 'operator' } });
    const res = await rawRequest(o.app.url, { path: '/ui/auth/none', method: 'POST', body: '{}', headers: { host: o.host, origin: o.origin, 'content-type': 'application/json' } });
    const token = (JSON.parse(res.text) as { token: string }).token;
    expect((await o.app.api('GET', '/api/realms', undefined, { 'x-hopper-session': token })).status).toBe(403);
  });
});

describe('POST /ui/api/realms: realms', () => {
  it('an OIDC realm added from its fields is offered at once, in realm order', async () => {
    const idp = await oidcIdp(h);
    const o = await startWithAuth(h, staff());
    const admin = await o.app.login();
    expect((await change(o.app, admin, { action: 'save', realm: oidcRealm(idp, { defaultRole: 'viewer' }) })).status).toBe(200);
    expect((await change(o.app, admin, { action: 'move', name: 'corp', to: 0 })).status).toBe(200);
    expect((await session(o.app)).signIn.realms).toEqual([{ name: 'corp', label: 'Corp SSO', type: 'oidc' }]);
    expect((await realms(o.app, admin)).realms.map((r: { name: string }) => r.name)).toEqual(['corp', 'staff', 'password']);
    expect(o.app.app.instance.signInConfig.read().realms[0]).toMatchObject({ name: 'corp', type: 'oidc', issuer: idp.issuer, clientSecret: 'shh' });
  });

  it('a realm turned off ends its sessions at once; turned on, it signs people in again', async () => {
    const o = await startWithAuth(h, staff('viewer'));
    const admin = await o.app.login();
    const ada = (await passwordSignIn(o, 'ada', 'correct horse')).token;
    expect((await change(o.app, admin, { action: 'enable', name: 'staff', enabled: false })).status).toBe(200);
    expect((await session(o.app, ada)).authenticated).toBe(false);
    expect((await passwordSignIn(o, 'ada', 'correct horse')).status).toBe(403);
    expect((await change(o.app, admin, { action: 'enable', name: 'staff', enabled: true })).status).toBe(200);
    expect((await passwordSignIn(o, 'ada', 'correct horse')).status).toBe(200);
  });

  it('a realm that would not load is refused, naming the field; nothing is stored or applied', async () => {
    const o = await startWithAuth(h, { version: 1 });
    const admin = await o.app.login();
    const bad = await change(o.app, admin, { action: 'save', realm: { name: 'gh', type: 'github', clientId: 'g' } });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/realms\.1\.clientSecret/);
    const named = await change(o.app, admin, { action: 'save', realm: { name: 'gh', type: 'github', clientId: 'g', clientSecretEnv: 'GITHUB_CLIENT_SECRET' } });
    expect(named.status).toBe(400);
    expect(named.body.error).toMatch(/clientSecretEnv/);
    expect(o.app.app.instance.signInConfig.read().realms.map((r) => r.name)).toEqual(['password']);
    expect(o.app.app.instance.config.read('sign-in')).toEqual({ version: 1, realms: [{ name: 'password', label: 'Password', type: 'password' }] });
  });

  it('a stale version is refused', async () => {
    const o = await startWithAuth(h, { version: 1 });
    const admin = await o.app.login();
    const { version } = await realms(o.app, admin);
    expect((await edit(o.app, admin, { action: 'save', realm: { name: 'staff', type: 'password' }, version })).status).toBe(200);
    expect((await edit(o.app, admin, { action: 'remove', name: 'staff', version })).status).toBe(409);
  });

  it('a change that would end the acting admin\'s own session is refused', async () => {
    const o = await startWithAuth(h, staff('admin'));
    const ada = (await passwordSignIn(o, 'ada', 'correct horse')).token!;
    for (const body of [
      { action: 'enable', name: 'staff', enabled: false },
      { action: 'remove', name: 'staff' },
      { action: 'account', realm: 'staff', username: 'ada', role: 'operator' },
      { action: 'account-remove', realm: 'staff', username: 'ada' },
    ]) {
      const r = await change(o.app, ada, body);
      expect(r.status).toBe(409);
      expect(r.body.error).toMatch(/your own/);
    }
    const loginCode = await o.app.login();
    expect((await change(o.app, loginCode, { action: 'settings', local: false })).status).toBe(409);
    expect((await change(o.app, ada, { action: 'settings', local: false })).status).toBe(200);
  });

  it('an operator may not change sign-in', async () => {
    const o = await startWithAuth(h, staff('operator'));
    const ada = (await passwordSignIn(o, 'ada', 'correct horse')).token!;
    const r = await edit(o.app, ada, { action: 'remove', name: 'staff', version: 'x' });
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ needs: 'admin' });
  });
});

describe('POST /ui/api/realms: password accounts', () => {
  it('a changed role applies to the stored sessions at once', async () => {
    const o = await startWithAuth(h, staff('viewer'));
    const admin = await o.app.login();
    const ada = (await passwordSignIn(o, 'ada', 'correct horse')).token;
    expect((await change(o.app, admin, { action: 'account', realm: 'staff', username: 'ada', role: 'operator' })).status).toBe(200);
    expect((await session(o.app, ada)).user.role).toBe('operator');
  });

  it('a new password replaces the old one at once', async () => {
    const o = await startWithAuth(h, staff());
    const admin = await o.app.login();
    expect((await change(o.app, admin, { action: 'account', realm: 'staff', username: 'ada', role: 'operator', password: 'battery staple' })).status).toBe(200);
    expect((await passwordSignIn(o, 'ada', 'correct horse')).status).toBe(403);
    expect((await passwordSignIn(o, 'ada', 'battery staple')).status).toBe(200);
  });

  it('an account removed signs out at once and signs in no more', async () => {
    const o = await startWithAuth(h, staff());
    const admin = await o.app.login();
    const ada = (await passwordSignIn(o, 'ada', 'correct horse')).token;
    expect((await change(o.app, admin, { action: 'account-remove', realm: 'staff', username: 'ada' })).status).toBe(200);
    expect((await session(o.app, ada)).authenticated).toBe(false);
    expect((await passwordSignIn(o, 'ada', 'correct horse')).status).toBe(403);
    expect((await realms(o.app, admin)).realms[0].accounts).toEqual([]);
  });

  it('a new account signs in as the user it names; without one, as a new user of its own', async () => {
    const o = await startWithAuth(h, { version: 1, realms: [{ name: 'staff', type: 'password', users: [] }, fallback()] });
    const admin = await o.app.login();
    expect((await change(o.app, admin, { action: 'account', realm: 'staff', username: 'boss', password: 'correct horse', role: 'admin', user: 'owner' })).status).toBe(200);
    expect((await change(o.app, admin, { action: 'account', realm: 'staff', username: 'bea', password: 'correct horse', role: 'viewer' })).status).toBe(200);
    expect((await realms(o.app, admin)).realms[0].accounts).toEqual([
      { username: 'bea', role: 'viewer' },
      { username: 'boss', role: 'admin', user: { id: 'owner', name: 'owner' } },
    ]);
    const boss = (await passwordSignIn(o, 'boss', 'correct horse')).token;
    expect((await session(o.app, boss)).user).toMatchObject({ id: 'owner', role: 'admin' });
    const bea = (await passwordSignIn(o, 'bea', 'correct horse')).token;
    expect((await session(o.app, bea)).user).toMatchObject({ name: 'bea', role: 'viewer' });
    expect((await session(o.app, bea)).user.id).not.toBe('owner');
  });

  it.each([
    ['a new account without a password', { username: 'bea', role: 'viewer' }, /password/],
    ['a password shorter than 8 characters', { username: 'bea', role: 'viewer', password: 'short' }, /8 characters/],
    ['a user that does not exist', { username: 'bea', role: 'viewer', password: 'correct horse', user: 'nobody' }, /nobody/],
    ['moving an account that signed in to another user', { username: 'ada', role: 'viewer', user: 'owner' }, /ada.*signs in as/],
  ])('refuses %s', async (_what, body, msg) => {
    const o = await startWithAuth(h, staff());
    const admin = await o.app.login();
    expect((await passwordSignIn(o, 'ada', 'correct horse')).status).toBe(200);
    const r = await change(o.app, admin, { action: 'account', realm: 'staff', ...body });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(msg);
  });
});
