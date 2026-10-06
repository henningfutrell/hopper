// A gateway realm (issue #215, design.md "Sign-in behind an auth gateway"): the hopper runs behind an
// auth gateway (Envoy Gateway with OIDC, oauth2-proxy, …) that signs people in and forwards their token.
// The hopper only checks that token — a JWT against the issuer's keys, or by token introspection — and
// turns it into a UI session. Through the daemon's HTTP routes, against a loopback issuer.
import { afterEach, describe, expect, it } from 'vitest';
import { rawRequest } from '../support/http.ts';
import { startOidcIdp, type OidcIdp } from '../support/idp.ts';
import { harness, oidcIdp, session, startWithAuth, stopAll, type Harness } from '../support/sign-in-app.ts';

const h = harness();
afterEach(() => stopAll(h));
const start = (auth: unknown) => startWithAuth(h, auth);

const gatewayRealm = (idp: Pick<OidcIdp, 'issuer'>, roles: unknown, extra: Record<string, unknown> = {}) =>
  ({ name: 'edge', label: 'Edge gateway', type: 'gateway', issuer: idp.issuer, audience: ['hopper'], roles, ...extra });

/** A token the issuer signs, as the gateway would forward it. */
const tokenFrom = (idp: OidcIdp, claims: Record<string, unknown>, expiresIn = 300) =>
  idp.token({ sub: 'ada-1', aud: 'hopper', ...claims }, expiresIn);

/** POST /ui/auth/gateway with what the gateway adds to the request. */
const exchange = (app: { url: string }, host: string, origin: string, headers: Record<string, string> = {}) =>
  rawRequest(app.url, { method: 'POST', path: '/ui/auth/gateway', body: '{}', headers: { host, origin, 'content-type': 'application/json', ...headers } });
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const tokenOf = (text: string): string => (JSON.parse(text) as { token: string }).token;

async function otherIssuer(hh: Harness): Promise<OidcIdp> {
  const idp = await startOidcIdp();
  hh.stops.push(() => idp.stop());
  return idp;
}

describe('a gateway realm, checking JWTs', () => {
  it('the session view offers the gateway, not a sign-in button', async () => {
    const idp = await oidcIdp(h);
    const { app } = await start({ version: 1, local: { enabled: false }, realms: [gatewayRealm(idp, { defaultRole: 'viewer' })] });
    const offer = (await session(app)).signIn;
    expect(offer.gateway).toBe(true);
    expect(offer.realms).toEqual([]);
    expect(offer.password).toBe(false);
  });

  it('a token the gateway forwards becomes a session: role from its groups, the user named from its claims', async () => {
    const idp = await oidcIdp(h);
    const { app, origin, host } = await start({ version: 1, realms: [gatewayRealm(idp, { admin: { groups: ['hopper-admins'] } })] });
    const res = await exchange(app, host, origin, bearer(await tokenFrom(idp, { groups: ['hopper-admins'], preferred_username: 'ada', name: 'Ada' })));
    expect(res.status).toBe(200);
    expect(await session(app, tokenOf(res.text))).toMatchObject({ authenticated: true, user: { role: 'admin', realm: 'edge', identity: 'Ada' } });
  });

  it('a verified email grants a role; an unverified one does not', async () => {
    const idp = await oidcIdp(h);
    const { app, origin, host } = await start({ version: 1, realms: [gatewayRealm(idp, { operator: { emails: ['ada@example.com'] } })] });
    const ok = await exchange(app, host, origin, bearer(await tokenFrom(idp, { email: 'ada@example.com', email_verified: true })));
    expect((await session(app, tokenOf(ok.text))).user.role).toBe('operator');
    const unverified = await exchange(app, host, origin, bearer(await tokenFrom(idp, { email: 'ada@example.com' })));
    expect(unverified.status).toBe(403);
    expect(unverified.text).toMatch(/no role/);
  });

  it('no token on the request: refused', async () => {
    const idp = await oidcIdp(h);
    const { app, origin, host } = await start({ version: 1, realms: [gatewayRealm(idp, { defaultRole: 'admin' })] });
    const res = await exchange(app, host, origin);
    expect(res.status).toBe(403);
    expect(res.text).toMatch(/no token/);
  });

  it('a token for another audience, an expired token, or one another issuer signed: refused', async () => {
    const idp = await oidcIdp(h);
    const other = await otherIssuer(h);
    const { app, origin, host } = await start({ version: 1, realms: [gatewayRealm(idp, { defaultRole: 'admin' })] });
    for (const token of [
      await tokenFrom(idp, { aud: 'someone-else' }),
      await tokenFrom(idp, {}, -120),
      await other.token({ sub: 'ada-1', aud: 'hopper', iss: idp.issuer }, 300),
      'not-a-jwt',
    ]) {
      const res = await exchange(app, host, origin, bearer(token));
      expect(res.status).toBe(403);
      expect(JSON.parse(res.text)).toEqual({ error: expect.stringMatching(/token/) });
    }
  });

  it('the token can come in another header, as the gateway names it, without the Bearer scheme', async () => {
    const idp = await oidcIdp(h);
    const { app, origin, host } = await start({ version: 1, realms: [gatewayRealm(idp, { defaultRole: 'viewer' }, { header: 'X-Forwarded-Access-Token' })] });
    const token = await tokenFrom(idp, {});
    expect((await exchange(app, host, origin, bearer(token))).status).toBe(403);
    const res = await exchange(app, host, origin, { 'x-forwarded-access-token': token });
    expect(res.status).toBe(200);
    expect((await session(app, tokenOf(res.text))).user.role).toBe('viewer');
  });

  it('from another origin it is refused, token or not', async () => {
    const idp = await oidcIdp(h);
    const { app, host } = await start({ version: 1, realms: [gatewayRealm(idp, { defaultRole: 'admin' })] });
    expect((await exchange(app, host, 'http://evil.example', bearer(await tokenFrom(idp, {})))).status).toBe(403);
  });

  it('an issuer that cannot be reached is 502, naming the realm; never a session', async () => {
    const { app, origin, host } = await start({ version: 1, realms: [gatewayRealm({ issuer: 'http://127.0.0.1:9/' }, { defaultRole: 'admin' })] });
    const res = await exchange(app, host, origin, bearer('x.y.z'));
    expect(res.status).toBe(502);
    expect(res.text).toMatch(/Edge gateway/);
  });

  it('a realm that is off is not asked', async () => {
    const idp = await oidcIdp(h);
    const { app, origin, host } = await start({ version: 1, realms: [gatewayRealm(idp, { defaultRole: 'admin' }, { enabled: false })] });
    expect((await session(app)).signIn.gateway).toBe(false);
    expect((await exchange(app, host, origin, bearer(await tokenFrom(idp, {})))).status).toBe(403);
  });
});

describe('a gateway realm, introspecting tokens', () => {
  const introspecting = (idp: OidcIdp, roles: unknown, extra: Record<string, unknown> = {}) =>
    gatewayRealm(idp, roles, { check: 'introspection', clientId: 'hopper', clientSecretEnv: 'CORP_CLIENT_SECRET', audience: undefined, ...extra });

  it('an active token becomes a session, with the claims the issuer answers; the hopper authenticates as its client', async () => {
    const idp = await oidcIdp(h);
    const seen: string[] = [];
    idp.onIntrospect((body, auth) => {
      seen.push(auth);
      Object.assign(body, { active: true, sub: 'ada-1', username: 'ada', groups: ['ops'] });
    });
    const { app, origin, host } = await start({ version: 1, realms: [introspecting(idp, { operator: { groups: ['ops'] } }, { claims: { username: 'username' } })] });
    const res = await exchange(app, host, origin, bearer('opaque-1'));
    expect(res.status).toBe(200);
    expect(await session(app, tokenOf(res.text))).toMatchObject({ user: { role: 'operator', realm: 'edge', identity: 'ada' } });
    expect(seen[0]).toBe(`Basic ${Buffer.from('hopper:shh').toString('base64')}`);
  });

  it('an inactive token is refused', async () => {
    const idp = await oidcIdp(h);
    idp.onIntrospect((body) => { body.active = false; });
    const { app, origin, host } = await start({ version: 1, realms: [introspecting(idp, { defaultRole: 'admin' })] });
    const res = await exchange(app, host, origin, bearer('revoked'));
    expect(res.status).toBe(403);
    expect(res.text).toMatch(/not active/);
  });

  it('with an audience set, an active token for another audience is refused', async () => {
    const idp = await oidcIdp(h);
    idp.onIntrospect((body) => { Object.assign(body, { active: true, sub: 'ada-1', aud: ['someone-else'] }); });
    const { app, origin, host } = await start({ version: 1, realms: [introspecting(idp, { defaultRole: 'admin' }, { audience: ['hopper'] })] });
    expect((await exchange(app, host, origin, bearer('opaque-1'))).status).toBe(403);
  });
});

describe('the gateway realm in Settings → Sign-in', () => {
  it('lists it without a callback URL', async () => {
    const idp = await oidcIdp(h);
    const { app } = await start({ version: 1, realms: [gatewayRealm(idp, { defaultRole: 'viewer' })] });
    const token = await app.login();
    const res = await rawRequest(app.url, { path: '/api/realms', headers: { 'x-hopper-session': token } });
    const view = JSON.parse(res.text) as { realms: Record<string, unknown>[] };
    expect(view.realms[0]).toMatchObject({ name: 'edge', type: 'gateway', settings: { issuer: idp.issuer, audience: ['hopper'] } });
    expect(view.realms[0]!.callback).toBeUndefined();
  });
});
