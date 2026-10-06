// Realms are managed in the UI (issue #185, design.md "Sign-in: realms"): an admin reads them
// (GET /api/realms) and adds, changes, removes, orders and turns them on and off (POST /ui/api/realms).
// A change applies at once, without a restart: the sign-in on offer follows it, and stored sessions
// follow it as they do at start. A change that would end the acting admin's own admin session is
// refused, so nobody locks themselves out from the UI.
import argon2 from 'argon2';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { rawRequest } from '../support/http.ts';
import { harness, oidcIdp, oidcRealm, session, startWithAuth, stopAll } from '../support/sign-in-app.ts';
import type { TestApp } from '../support/app.ts';

const h = harness();
afterEach(() => stopAll(h));

let hash = '';
beforeAll(async () => { hash = await argon2.hash('correct horse', { type: argon2.argon2id }); });

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read loose JSON
const realms = async (app: TestApp, token: string): Promise<any> => (await app.api('GET', '/api/realms', undefined, { 'x-hopper-session': token })).body;
const edit = (app: TestApp, token: string, body: Record<string, unknown>) => app.ui<{ error?: string; version?: string }>('/ui/api/realms', body, { token });

const passwordRealm = (role = 'operator') => JSON.stringify({ name: 'staff', type: 'password', users: [{ username: 'ada', passwordHash: hash, role }] });
const passwordSignIn = async (o: { app: TestApp; origin: string; host: string }, username: string, password: string) => {
  const res = await rawRequest(o.app.url, {
    path: '/ui/auth/password', method: 'POST', body: JSON.stringify({ username, password }),
    headers: { host: o.host, origin: o.origin, 'content-type': 'application/json' },
  });
  return { status: res.status, token: res.status === 200 ? (JSON.parse(res.text) as { token: string }).token : undefined };
};

describe('GET /api/realms', () => {
  it('an admin reads every realm, in order, as its JSON, with the config version', async () => {
    const o = await startWithAuth(h, { version: 1, realms: [{ name: 'staff', type: 'password', users: [] }, { name: 'gh', type: 'github', clientId: 'g', clientSecretEnv: 'GITHUB_CLIENT_SECRET', enabled: false }] });
    const v = await realms(o.app, await o.app.login());
    expect(v).toMatchObject({ local: true, none: null, origin: o.origin, version: expect.any(String) });
    expect(v.realms.map((r: { name: string; type: string; enabled: boolean }) => [r.name, r.type, r.enabled])).toEqual([['staff', 'password', true], ['gh', 'github', false]]);
    expect(JSON.parse(v.realms[1].entry)).toEqual({ name: 'gh', type: 'github', clientId: 'g', clientSecretEnv: 'GITHUB_CLIENT_SECRET', enabled: false });
    expect(v.realms[1].callback).toBe(`${o.origin}/ui/auth/gh/callback`);
  });

  it('a session that is not admin is refused', async () => {
    const o = await startWithAuth(h, { version: 1, none: { role: 'operator' } });
    const res = await rawRequest(o.app.url, { path: '/ui/auth/none', method: 'POST', body: '{}', headers: { host: o.host, origin: o.origin, 'content-type': 'application/json' } });
    const token = (JSON.parse(res.text) as { token: string }).token;
    expect((await o.app.api('GET', '/api/realms', undefined, { 'x-hopper-session': token })).status).toBe(403);
  });
});

describe('POST /ui/api/realms', () => {
  it('a realm added applies at once: password sign-in works without a restart, and the change is stored', async () => {
    const o = await startWithAuth(h, undefined);
    const admin = await o.app.login();
    expect((await session(o.app)).signIn.password).toBe(false);
    const { version } = await realms(o.app, admin);
    const r = await edit(o.app, admin, { action: 'save', entry: passwordRealm(), version });
    expect(r.status).toBe(200);
    expect((await session(o.app)).signIn.password).toBe(true);
    const ada = await passwordSignIn(o, 'ada', 'correct horse');
    expect(await session(o.app, ada.token)).toMatchObject({ user: { realm: 'staff', role: 'operator' } });
    expect(o.app.app.instance.config.read('sign-in')).toMatchObject({ realms: [{ name: 'staff', type: 'password' }] });
  });

  it('an OIDC realm added is offered at once, in realm order', async () => {
    const idp = await oidcIdp(h);
    const o = await startWithAuth(h, { version: 1, realms: [{ name: 'staff', type: 'password', users: [] }] });
    const admin = await o.app.login();
    const entry = JSON.stringify(oidcRealm(idp, { defaultRole: 'viewer' }));
    let { version } = await realms(o.app, admin);
    expect((await edit(o.app, admin, { action: 'save', entry, version })).status).toBe(200);
    ({ version } = await realms(o.app, admin));
    expect((await edit(o.app, admin, { action: 'move', name: 'corp', to: 0, version })).status).toBe(200);
    expect((await session(o.app)).signIn.realms).toEqual([{ name: 'corp', label: 'Corp SSO', type: 'oidc' }]);
    expect((await realms(o.app, admin)).realms.map((r: { name: string }) => r.name)).toEqual(['corp', 'staff']);
  });

  it('a realm turned off ends its sessions at once; turned on, it signs people in again', async () => {
    const o = await startWithAuth(h, { version: 1, realms: [{ name: 'staff', type: 'password', users: [{ username: 'ada', passwordHash: hash, role: 'viewer' }] }] });
    const admin = await o.app.login();
    const ada = (await passwordSignIn(o, 'ada', 'correct horse')).token;
    let { version } = await realms(o.app, admin);
    expect((await edit(o.app, admin, { action: 'enable', name: 'staff', enabled: false, version })).status).toBe(200);
    expect((await session(o.app, ada)).authenticated).toBe(false);
    expect((await passwordSignIn(o, 'ada', 'correct horse')).status).toBe(403);
    ({ version } = await realms(o.app, admin));
    expect((await edit(o.app, admin, { action: 'enable', name: 'staff', enabled: true, version })).status).toBe(200);
    expect((await passwordSignIn(o, 'ada', 'correct horse')).status).toBe(200);
  });

  it('a changed role applies to the stored sessions at once', async () => {
    const o = await startWithAuth(h, { version: 1, realms: [{ name: 'staff', type: 'password', users: [{ username: 'ada', passwordHash: hash, role: 'viewer' }] }] });
    const admin = await o.app.login();
    const ada = (await passwordSignIn(o, 'ada', 'correct horse')).token;
    const { version } = await realms(o.app, admin);
    expect((await edit(o.app, admin, { action: 'save', name: 'staff', entry: passwordRealm('operator'), version })).status).toBe(200);
    expect((await session(o.app, ada)).user.role).toBe('operator');
  });

  it('a realm that would not load is refused, naming the field; nothing is stored or applied', async () => {
    const o = await startWithAuth(h, undefined);
    const admin = await o.app.login();
    const { version } = await realms(o.app, admin);
    const bad = await edit(o.app, admin, { action: 'save', entry: JSON.stringify({ name: 'gh', type: 'github', clientId: 'g' }), version });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/realms\.0\.clientSecretEnv/);
    const unset = await edit(o.app, admin, { action: 'save', entry: JSON.stringify({ name: 'gh', type: 'github', clientId: 'g', clientSecretEnv: 'NOT_SET_ANYWHERE' }), version });
    expect(unset.status).toBe(400);
    expect(unset.body.error).toMatch(/NOT_SET_ANYWHERE/);
    expect(o.app.app.instance.config.read('sign-in')).toBeUndefined();
  });

  it('a realm in YAML, or not an object, is refused; nothing is stored', async () => {
    const o = await startWithAuth(h, undefined);
    const admin = await o.app.login();
    const { version } = await realms(o.app, admin);
    const yaml = await edit(o.app, admin, { action: 'save', entry: 'name: gh\ntype: github\nclientId: g\n', version });
    expect(yaml.status).toBe(400);
    expect(yaml.body.error).toMatch(/^the realm is not valid JSON: /);
    const list = await edit(o.app, admin, { action: 'save', entry: '["gh"]', version });
    expect(list.status).toBe(400);
    expect(list.body.error).toBe('a realm is an object: name, type and its settings');
    expect(o.app.app.instance.config.read('sign-in')).toBeUndefined();
  });

  it('a stale version is refused', async () => {
    const o = await startWithAuth(h, undefined);
    const admin = await o.app.login();
    const { version } = await realms(o.app, admin);
    expect((await edit(o.app, admin, { action: 'save', entry: passwordRealm(), version })).status).toBe(200);
    expect((await edit(o.app, admin, { action: 'remove', name: 'staff', version })).status).toBe(409);
  });

  it('a change that would end the acting admin\'s own session is refused', async () => {
    const o = await startWithAuth(h, { version: 1, realms: [{ name: 'staff', type: 'password', users: [{ username: 'ada', passwordHash: hash, role: 'admin' }] }] });
    const ada = (await passwordSignIn(o, 'ada', 'correct horse')).token!;
    const { version } = await realms(o.app, ada);
    for (const body of [
      { action: 'enable', name: 'staff', enabled: false, version },
      { action: 'remove', name: 'staff', version },
      { action: 'save', name: 'staff', entry: passwordRealm('operator'), version },
    ]) {
      const r = await edit(o.app, ada, body);
      expect(r.status).toBe(409);
      expect(r.body.error).toMatch(/your own/);
    }
    const loginCode = await o.app.login();
    expect((await edit(o.app, loginCode, { action: 'settings', local: false, version })).status).toBe(409);
    expect((await edit(o.app, ada, { action: 'settings', local: false, version })).status).toBe(200);
  });

  it('an operator may not change the realms', async () => {
    const o = await startWithAuth(h, { version: 1, realms: [{ name: 'staff', type: 'password', users: [{ username: 'ada', passwordHash: hash, role: 'operator' }] }] });
    const ada = (await passwordSignIn(o, 'ada', 'correct horse')).token!;
    const r = await edit(o.app, ada, { action: 'remove', name: 'staff', version: 'x' });
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ needs: 'admin' });
  });
});
