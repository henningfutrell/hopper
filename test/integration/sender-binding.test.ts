// Issue #892, part 2: sender binding (DPoP, RFC 9449). A grant bound to its agent's key is good only with a DPoP proof
// of that key: each refresh, each use of its API tokens, and a device grant request's poll. So a stolen refresh token,
// API token or device code alone is not enough. Real daemon, real HTTP server; OpenFGA is a double at its port.
//
// Feature: sender binding
//   Scenario: a device grant request with a proof binds its grant; the poll, the refresh and each use need the key
//   Scenario: a grant minted with jkt is bound; a refresh without the key neither works nor ends the grant
//   Scenario: an unbound grant is bound at its first refresh with a proof, and stays bound
//   Scenario: an unbound grant works with no proof, as before
//   Scenario: a bound token's mutation needs the proof too
//   Scenario: the operator CLI mints a bound grant
import { afterEach, describe, expect, it } from 'vitest';
import { createFakeAuthorizationServer } from '../support/fake-authorization-server.ts';
import { dpopKey, type DpopKey } from '../support/dpop.ts';
import { rawRequest } from '../support/http.ts';
import { runCli, type CliIo } from '../../src/cli.ts';
import { databaseUrlFor } from '../support/database.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { KEY } from '../support/webhooks.ts';

let t: TestApp | undefined;
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  await t?.stop();
  t = undefined;
  for (const c of cleanups.splice(0)) await c();
});

async function boot(): Promise<TestApp> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  t = await startTestApp({ dbPath: db.dbPath, secrets: { HOPPER_MASTER_KEY: KEY }, seams: { authorizationServer: createFakeAuthorizationServer() } });
  return t;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read loose JSON
type Answer = { status: number; body: any; text: string; headers: Record<string, string | string[] | undefined> };
const parsed = (r: { status: number; text: string; headers: Record<string, string | string[] | undefined> }): Answer => ({ status: r.status, text: r.text, headers: r.headers, body: r.text ? JSON.parse(r.text) : undefined });

/** A POST, with a DPoP proof of `key` for it when one is named. */
async function post(a: TestApp, path: string, body: unknown, o: { key?: DpopKey; authorization?: string; token?: string } = {}): Promise<Answer> {
  const proof = o.key && await o.key.proof('POST', new URL(path, a.url).href, o.token === undefined ? {} : { token: o.token });
  return parsed(await rawRequest(a.url, {
    method: 'POST', path, body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...(proof ? { dpop: proof } : {}), ...(o.authorization ? { authorization: o.authorization } : {}) },
  }));
}
/** A read with an API token: `scheme` `DPoP` and a proof of `key` when one is named. */
async function read(a: TestApp, path: string, token: string, o: { key?: DpopKey; scheme?: string } = {}): Promise<Answer> {
  const proof = o.key && await o.key.proof('GET', new URL(path, a.url).href, { token });
  return parsed(await rawRequest(a.url, { method: 'GET', path, headers: { authorization: `${o.scheme ?? (o.key ? 'DPoP' : 'Bearer')} ${token}`, ...(proof ? { dpop: proof } : {}) } }));
}
const refresh = (a: TestApp, token: string, key?: DpopKey) => post(a, '/ui/auth/token/refresh', { refresh: token }, key ? { key } : {});
async function mint(a: TestApp, session: string, body: Record<string, unknown> = {}): Promise<Answer> {
  const r = await a.ui('/ui/api/api-tokens', { action: 'mint', label: 'Grok Bot', holder: 'grok-bot', scopes: ['*'], ...body }, { token: session });
  return { status: r.status, body: r.body, text: JSON.stringify(r.body), headers: {} };
}

describe('sender binding (issue #892)', () => {
  it('a device grant request with a proof binds its grant: the poll, each refresh and each use need the key', async () => {
    const a = await boot();
    const key = await dpopKey();
    const other = await dpopKey();
    const asked = await post(a, '/ui/auth/device-grant', { label: 'Grok Bot', holder: 'grok-bot', scopes: ['*:read'] }, { key });
    expect(asked.status, asked.text).toBe(200);
    const { deviceCode, userCode } = asked.body as { deviceCode: string; userCode: string };
    const session = await a.login();
    const seen = await a.api('GET', `/api/api-tokens/device/${userCode}`, undefined, { 'x-hopper-session': session });
    expect(seen.body.ask).toMatchObject({ jkt: key.jkt });
    expect((await a.ui('/ui/api/api-tokens', { action: 'approve-device', code: userCode }, { token: session })).status).toBe(200);

    // The device code alone, or with another key, takes nothing; the request stands.
    for (const k of [undefined, other]) {
      const r = await post(a, '/ui/auth/device-grant/poll', { deviceCode }, k ? { key: k } : {});
      expect(r.status, r.text).toBe(401);
      expect(r.headers['www-authenticate']).toMatch(/^DPoP/);
    }
    const granted = await post(a, '/ui/auth/device-grant/poll', { deviceCode }, { key });
    expect(granted.status, granted.text).toBe(200);
    expect(granted.body).toMatchObject({ state: 'granted', tokenType: 'DPoP', view: { jkt: key.jkt } });
    const { token, refresh: first } = granted.body as { token: string; refresh: string };

    // Each use: Bearer is refused, DPoP with no proof, another key's, or a proof replayed; the key's own proof reads.
    expect((await read(a, '/api/queue', token)).status).toBe(401);
    expect((await read(a, '/api/queue', token, { scheme: 'DPoP' })).status).toBe(401);
    expect((await read(a, '/api/queue', token, { key: other })).status).toBe(401);
    const ok = await read(a, '/api/queue', token, { key });
    expect(ok.status, ok.text).toBe(200);
    const proof = await key.proof('GET', new URL('/api/queue', a.url).href, { token });
    const once = { method: 'GET', path: '/api/queue', headers: { authorization: `DPoP ${token}`, dpop: proof } };
    expect((await rawRequest(a.url, once)).status).toBe(200);
    expect((await rawRequest(a.url, once)).status).toBe(401);

    // Each refresh: without the key, or with another, it is refused and spends nothing.
    expect((await refresh(a, first)).status).toBe(401);
    expect((await refresh(a, first, other)).status).toBe(401);
    const next = await refresh(a, first, key);
    expect(next.status, next.text).toBe(200);
    expect(next.body).toMatchObject({ tokenType: 'DPoP' });
    expect((await read(a, '/api/queue', next.body.token, { key })).status).toBe(200);
    expect((await read(a, '/api/queue', next.body.token)).status).toBe(401);
  });

  it('a grant minted with jkt is bound; a spent refresh token sent without the key does not end it', async () => {
    const a = await boot();
    const key = await dpopKey();
    const session = await a.login();
    const minted = await mint(a, session, { jkt: key.jkt });
    expect(minted.status, minted.text).toBe(200);
    expect(minted.body).toMatchObject({ tokenType: 'DPoP', view: { jkt: key.jkt } });
    const r1 = await refresh(a, minted.body.refresh, key);
    expect(r1.status, r1.text).toBe(200);
    // A thief with the spent refresh token and no key: refused, and the grant stands (no reuse detection).
    await new Promise((r) => setTimeout(r, 10));
    expect((await refresh(a, minted.body.refresh)).status).toBe(401);
    const listed = await a.api('GET', '/api/api-tokens', undefined, { 'x-hopper-session': session });
    expect(listed.body.grants).toEqual([expect.objectContaining({ id: minted.body.grant, jkt: key.jkt })]);
    expect((await refresh(a, r1.body.refresh, key)).status).toBe(200);

    const bad = await mint(a, session, { jkt: 'not-a-thumbprint' });
    expect(bad.status).toBe(400);
  });

  it('an unbound grant is bound at its first refresh with a proof, and stays bound', async () => {
    const a = await boot();
    const key = await dpopKey();
    const session = await a.login();
    const minted = await mint(a, session);
    expect(minted.body.tokenType).toBeUndefined();
    const r1 = await refresh(a, minted.body.refresh, key);
    expect(r1.status, r1.text).toBe(200);
    expect(r1.body.tokenType).toBe('DPoP');
    expect((await refresh(a, r1.body.refresh)).status).toBe(401);
    const r2 = await refresh(a, r1.body.refresh, key);
    expect(r2.status, r2.text).toBe(200);
    // The API token the mint gave before the binding is the grant's too: now it needs the key.
    expect((await read(a, '/api/queue', minted.body.token)).status).toBe(401);
    expect((await read(a, '/api/queue', minted.body.token, { key })).status).toBe(200);
  });

  it('an unbound grant works with no proof, as before; a device grant request with no proof is unbound', async () => {
    const a = await boot();
    const session = await a.login();
    const minted = await mint(a, session);
    expect((await read(a, '/api/queue', minted.body.token)).status).toBe(200);
    const r1 = await refresh(a, minted.body.refresh);
    expect(r1.status, r1.text).toBe(200);
    expect(r1.body.tokenType).toBeUndefined();
    expect((await read(a, '/api/queue', r1.body.token)).status).toBe(200);

    // A bad proof is refused even where none is needed: it is no proof of this request.
    const key = await dpopKey();
    const stale = await key.proof('POST', new URL('/ui/auth/token/refresh', a.url).href, { iat: Math.floor(Date.now() / 1000) - 3600 });
    const r = parsed(await rawRequest(a.url, { method: 'POST', path: '/ui/auth/token/refresh', body: JSON.stringify({ refresh: r1.body.refresh }), headers: { 'content-type': 'application/json', dpop: stale } }));
    expect(r.status, r.text).toBe(401);
    expect(r.body.error).toMatch(/iat/);
  });

  it('a bound token\'s mutation needs the proof too', async () => {
    const a = await boot();
    const key = await dpopKey();
    const session = await a.login();
    const minted = await mint(a, session, { jkt: key.jkt });
    const body = { action: 'revoke', id: '0000000000000000' };
    const bare = await post(a, '/ui/api/api-tokens', body, { authorization: `DPoP ${minted.body.token}` });
    expect(bare.status, bare.text).toBe(401);
    const proved = await post(a, '/ui/api/api-tokens', body, { authorization: `DPoP ${minted.body.token}`, key, token: minted.body.token });
    expect(proved.status, proved.text).toBe(404);
  });

  it('the operator CLI mints a bound grant (--jkt)', async () => {
    const a = await boot();
    const key = await dpopKey();
    const out: string[] = [];
    const err: string[] = [];
    const io: CliIo = { env: { HOPPER_DATABASE_URL: databaseUrlFor(a.dbPath) }, stdin: () => '', out: (x) => out.push(x), err: (x) => err.push(x) };
    const code = await runCli(['token', 'mint', '--label', 'Grok Bot', '--scope', '*:read', `--jkt=${key.jkt}`, '--url', a.url], io);
    // The CLI says why it failed only on err: the assertion carries it, so a failure in CI names its cause.
    expect(code, err.join('')).toBe(0);
    const minted = JSON.parse(out.join('')) as { token: string; refresh: string; tokenType?: string };
    expect(minted.tokenType).toBe('DPoP');
    expect((await refresh(a, minted.refresh)).status).toBe(401);
    expect((await refresh(a, minted.refresh, key)).status).toBe(200);
  });
});
