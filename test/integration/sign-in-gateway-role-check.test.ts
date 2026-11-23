// A gateway realm's role provider (issue #2986, docs/sign-in.md "Roles from an authorization service"): an
// authorization service decides the role in place of the role rules. For each permission the hopper posts
// `{ object, permission }` to the check URL with the person's own token, and the highest one allowed decides.
// Through the daemon's HTTP routes, against a loopback issuer and a loopback decision API.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { rawRequest } from '../support/http.ts';
import type { OidcIdp } from '../support/idp.ts';
import { harness, oidcIdp, session, startWithAuth, stopAll } from '../support/sign-in-app.ts';

const h = harness();
afterEach(() => stopAll(h));

interface Asked { authorization: string | undefined; object: string; permission: string }

/** A decision API on loopback: `allowed` says, per bearer token, which permissions it holds; `fail` answers 500. */
async function decisionApi(allowed: Record<string, string[]>): Promise<{ url: string; asked: Asked[]; fail: (on: boolean) => void }> {
  const asked: Asked[] = [];
  let failing = false;
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => { body += c.toString(); });
    req.on('end', () => {
      const { object, permission } = JSON.parse(body) as { object: string; permission: string };
      asked.push({ authorization: req.headers.authorization, object, permission });
      if (failing) { res.writeHead(500).end('down'); return; }
      const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ allowed: object === 'app:hopper' && (allowed[token] ?? []).includes(permission) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  h.stops.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/check`, asked, fail: (on) => { failing = on; } };
}

const realm = (idp: OidcIdp, url: string, roles: Record<string, unknown> = {}) => ({
  name: 'edge', label: 'Edge gateway', type: 'gateway', issuer: idp.issuer, audience: ['hopper'],
  roles: { provider: 'check', check: { url, object: 'app:hopper' }, ...roles },
});

const exchange = (app: { url: string }, host: string, origin: string, token: string) =>
  rawRequest(app.url, { method: 'POST', path: '/ui/auth/gateway', body: '{}', headers: { host, origin, 'content-type': 'application/json', authorization: `Bearer ${token}` } });
const tokenOf = (text: string): string => (JSON.parse(text) as { token: string }).token;

async function setUp(allowed: (tokens: { ada: string; bea: string; cy: string }) => Record<string, string[]>, roles: Record<string, unknown> = {}) {
  const idp = await oidcIdp(h);
  const tokens = {
    ada: await idp.token({ sub: 'ada-1', aud: 'hopper' }, 300),
    bea: await idp.token({ sub: 'bea-1', aud: 'hopper' }, 300),
    cy: await idp.token({ sub: 'cy-1', aud: 'hopper' }, 300),
  };
  const api = await decisionApi(allowed(tokens));
  const started = await startWithAuth(h, { version: 1, realms: [realm(idp, api.url, roles)] });
  return { ...started, api, tokens };
}

describe('a gateway realm with the check role provider', () => {
  it('can_admin signs in as admin, can_view as viewer, nothing as no role', async () => {
    const { app, origin, host, tokens } = await setUp((t) => ({ [t.ada]: ['can_admin', 'can_view'], [t.bea]: ['can_view'] }));
    const ada = await exchange(app, host, origin, tokens.ada);
    expect(ada.status).toBe(200);
    expect((await session(app, tokenOf(ada.text))).user).toMatchObject({ role: 'admin', realm: 'edge' });
    const bea = await exchange(app, host, origin, tokens.bea);
    expect((await session(app, tokenOf(bea.text))).user.role).toBe('viewer');
    const cy = await exchange(app, host, origin, tokens.cy);
    expect(cy.status).toBe(403);
    expect(cy.text).toMatch(/authorization service grants this account no role/);
  });

  it('asks for each permission on the object with the person\'s own token, and keeps the answer a short time', async () => {
    const { app, origin, host, tokens, api } = await setUp((t) => ({ [t.ada]: ['can_operate'] }));
    expect((await session(app, tokenOf((await exchange(app, host, origin, tokens.ada)).text))).user.role).toBe('operator');
    expect(api.asked.map((a) => a.permission).sort()).toEqual(['can_admin', 'can_operate', 'can_view']);
    expect(api.asked.every((a) => a.authorization === `Bearer ${tokens.ada}` && a.object === 'app:hopper')).toBe(true);
    expect((await exchange(app, host, origin, tokens.ada)).status).toBe(200);
    expect(api.asked).toHaveLength(3);
  });

  it('a check that fails is "authorization service unavailable", never a session and never "no role"; it is not kept', async () => {
    const { app, origin, host, tokens, api } = await setUp((t) => ({ [t.ada]: ['can_admin'] }));
    api.fail(true);
    const down = await exchange(app, host, origin, tokens.ada);
    expect(down.status).toBe(502);
    expect(down.text).toMatch(/authorization service unavailable/);
    expect(down.text).not.toMatch(/no role/);
    api.fail(false);
    expect((await exchange(app, host, origin, tokens.ada)).status).toBe(200);
  });

  it('the role rules still grant break-glass admin by subject, with no check; other rules grant nothing', async () => {
    const { app, origin, host, tokens, api } = await setUp(() => ({}), { admin: { subjects: ['ada-1'] }, defaultRole: 'viewer' });
    api.fail(true);
    const ada = await exchange(app, host, origin, tokens.ada);
    expect((await session(app, tokenOf(ada.text))).user.role).toBe('admin');
    api.fail(false);
    expect((await exchange(app, host, origin, tokens.bea)).status).toBe(403);
  });

  it('Settings → Sign-in says where each role comes from', async () => {
    const { app, origin, host, tokens } = await setUp((t) => ({ [t.bea]: ['can_view'] }), { admin: { subjects: ['ada-1'] } });
    const admin = tokenOf((await exchange(app, host, origin, tokens.ada)).text);
    await exchange(app, host, origin, tokens.bea);
    const view = JSON.parse((await rawRequest(app.url, { path: '/api/realms', headers: { host, 'x-hopper-session': admin } })).text) as { people: { subject: string; role: string | null; roleFrom: string }[] };
    expect(view.people.find((p) => p.subject === 'ada-1')).toMatchObject({ role: 'admin', roleFrom: 'rule' });
    expect(view.people.find((p) => p.subject === 'bea-1')).toMatchObject({ role: 'viewer', roleFrom: 'provider' });
  });
});
