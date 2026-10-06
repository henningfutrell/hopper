// Sign-in is managed in the UI (issues #185, #198, design.md "Sign-in: realms"): an admin reads the
// realms (GET /api/realms) and adds, changes, removes, orders and turns them on and off from their
// fields (POST /ui/api/realms). Everything is in the database, every setting a field; no YAML or JSON
// to write. A change applies at once, without a restart: the sign-in on offer follows it, and stored
// sessions follow it as they do at start. A change that would end the acting admin's own admin session
// is refused, so nobody locks themselves out from the UI.
import { afterEach, describe, expect, it } from 'vitest';
import { rawRequest } from '../support/http.ts';
import { signIn } from '../support/idp.ts';
import { harness, oidcIdp, oidcRealm, session, startWithAuth, stopAll } from '../support/sign-in-app.ts';
import type { TestApp } from '../support/app.ts';

const h = harness();
afterEach(() => stopAll(h));

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read loose JSON
const realms = async (app: TestApp, token: string): Promise<any> => (await app.api('GET', '/api/realms', undefined, { 'x-hopper-session': token })).body;
const edit = (app: TestApp, token: string, body: Record<string, unknown>) => app.ui<{ error?: string; version?: string }>('/ui/api/realms', body, { token });
/** One change against the version read now. */
const change = async (app: TestApp, token: string, body: Record<string, unknown>) => edit(app, token, { ...body, version: (await realms(app, token)).version });

/** A hopper with the OIDC realm `corp`, where ada signs in with `role`. */
async function withCorp(role: string) {
  const idp = await oidcIdp(h, { claims: { email: 'ada@example.com', email_verified: true } });
  const realm = oidcRealm(idp, { [role]: { emails: ['ada@example.com'] } });
  const o = await startWithAuth(h, { version: 1, realms: [realm] });
  const ada = async () => (await signIn(o.app.url, o.origin, 'corp')).token;
  return { ...o, idp, realm, ada };
}

describe('GET /api/realms', () => {
  it('an admin reads every realm, in order, with its settings, never a secret, and the version', async () => {
    const idp = await oidcIdp(h);
    const o = await startWithAuth(h, { version: 1, realms: [oidcRealm(idp, {}), { name: 'gh', type: 'github', enabled: false }] });
    const v = await realms(o.app, await o.app.login());
    expect(v).toMatchObject({ local: true, none: null, origin: o.origin, version: expect.any(String) });
    expect(v.realms.map((r: { name: string; type: string; enabled: boolean }) => [r.name, r.type, r.enabled])).toEqual([['corp', 'oidc', true], ['gh', 'github', false]]);
    // A GitHub realm signs in through the hopper's app (issue #214): no settings of an app, no secret, no callback.
    expect(v.realms[1].settings).toEqual({});
    expect(v.realms[1].secrets).toEqual([]);
    expect(v.realms[1]).not.toHaveProperty('callback');
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
    const o = await startWithAuth(h, { version: 1, realms: [{ name: 'gh', type: 'github', clientId: 'g', clientSecret: 's' }] });
    const admin = await o.app.login();
    expect((await change(o.app, admin, { action: 'save', realm: oidcRealm(idp, { defaultRole: 'viewer' }) })).status).toBe(200);
    expect((await change(o.app, admin, { action: 'move', name: 'corp', to: 0 })).status).toBe(200);
    expect((await session(o.app)).signIn.realms).toEqual([{ name: 'corp', label: 'Corp SSO', type: 'oidc' }, { name: 'gh', label: 'gh', type: 'github' }]);
    expect((await realms(o.app, admin)).realms.map((r: { name: string }) => r.name)).toEqual(['corp', 'gh']);
    expect(o.app.app.instance.signInConfig.read().realms[0]).toMatchObject({ name: 'corp', type: 'oidc', issuer: idp.issuer, clientSecret: 'shh' });
  });

  it('a realm turned off ends its sessions at once; turned on, it signs people in again', async () => {
    const o = await withCorp('viewer');
    const admin = await o.app.login();
    const ada = await o.ada();
    expect((await session(o.app, ada)).authenticated).toBe(true);
    expect((await change(o.app, admin, { action: 'enable', name: 'corp', enabled: false })).status).toBe(200);
    expect((await session(o.app, ada)).authenticated).toBe(false);
    expect(await o.ada()).toBeUndefined();
    expect((await change(o.app, admin, { action: 'enable', name: 'corp', enabled: true })).status).toBe(200);
    expect(await o.ada()).toBeDefined();
  });

  it('a changed role rule applies to the stored sessions at once', async () => {
    const o = await withCorp('admin');
    const admin = await o.app.login();
    const ada = await o.ada();
    expect((await change(o.app, admin, { action: 'save', name: 'corp', realm: { ...o.realm, roles: { operator: { emails: ['ada@example.com'] } } } })).status).toBe(200);
    expect((await session(o.app, ada)).user).toMatchObject({ role: 'operator' });
  });

  it('a realm that would not load is refused, naming the field; nothing is stored or applied', async () => {
    const o = await startWithAuth(h, { version: 1 });
    const admin = await o.app.login();
    const bad = await change(o.app, admin, { action: 'save', realm: { name: 'corp', type: 'oidc', issuer: 'not a url', clientId: 'g' } });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/issuer|Invalid URL/);
    const named = await change(o.app, admin, { action: 'save', realm: { name: 'corp', type: 'oidc', issuer: 'https://idp.example.com', clientId: 'g', clientSecretEnv: 'GITHUB_CLIENT_SECRET' } });
    expect(named.status).toBe(400);
    expect(named.body.error).toMatch(/clientSecretEnv/);
    expect(o.app.app.instance.config.read('sign-in')).toEqual({ version: 1, realms: [] });
  });

  it('a stale version is refused', async () => {
    const o = await startWithAuth(h, { version: 1 });
    const admin = await o.app.login();
    const { version } = await realms(o.app, admin);
    expect((await edit(o.app, admin, { action: 'save', realm: { name: 'gh', type: 'github', clientId: 'g', clientSecret: 's' }, version })).status).toBe(200);
    expect((await edit(o.app, admin, { action: 'remove', name: 'gh', version })).status).toBe(409);
  });

  it('a change that would end the acting admin\'s own session is refused', async () => {
    const o = await withCorp('admin');
    const ada = (await o.ada())!;
    for (const body of [
      { action: 'enable', name: 'corp', enabled: false },
      { action: 'remove', name: 'corp' },
      { action: 'save', name: 'corp', realm: { ...o.realm, roles: { operator: { emails: ['ada@example.com'] } } } },
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
    const o = await withCorp('operator');
    const ada = (await o.ada())!;
    const r = await edit(o.app, ada, { action: 'remove', name: 'corp', version: 'x' });
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ needs: 'admin' });
  });

  it('there are no password accounts to change', async () => {
    const o = await startWithAuth(h, { version: 1 });
    const admin = await o.app.login();
    const r = await change(o.app, admin, { action: 'account', realm: 'staff', username: 'bea', role: 'viewer', password: 'correct horse' });
    expect(r.status).toBe(400);
  });
});
