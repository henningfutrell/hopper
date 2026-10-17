// Signing in at hopper.io with GitHub (issue #463, docs/cloud-hosting-identity.md): through the hosted GitHub App's web
// flow (authorization code with PKCE), the account keyed by GitHub's numeric user id, its login and avatar kept for
// display, and no GitHub token kept. The store is real (Postgres), the server is real (Fastify, by inject); GitHub is a
// fake on loopback.
//
// Feature: a hopper.io account from a GitHub sign-in
//   Scenario: a person signs in with GitHub
//     Then the browser goes to GitHub with the hosted app's client id, the callback, a state and a PKCE challenge
//     And back at hopper.io the account is kept by its numeric id, with its login and avatar
//     And a hopper.io session is open, kept only as a hash, and no GitHub token is kept
//   Scenario: the same GitHub account signs in again: one account, its login and avatar now
//   Scenario: a callback whose state this browser did not start: no session
//   Scenario: the person denies it at GitHub: no account, no session
//   Scenario: sign-out ends the session only, and only from hopper.io itself
//   Scenario: two accounts: each session reads only its own account (R3)
//   Scenario: sign-ins past the limit per address are refused (R7)
import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import type { CloudConfig } from '../../cloud/config.ts';
import { CALLBACK_PATH, SESSION_COOKIE, SIGN_IN_COOKIE, SIGN_IN_LIMIT, cloudServer, cookiesOf } from '../../cloud/server.ts';
import { hashOf, openCloudStore } from '../../cloud/store.ts';
import { testDatabaseUrl } from '../support/database.ts';
import { createFakeGitHub } from '../support/fake-forges.ts';
import { rawRequest } from '../support/http.ts';

const SECRET = 'hosted-app-secret-for-tests';
const PUBLIC = 'http://127.0.0.1:8099';
const stops: (() => Promise<void>)[] = [];
afterEach(async () => { for (const s of stops.splice(0).reverse()) await s(); });

async function setUp() {
  const github = await createFakeGitHub({ clientId: 'hosted-app', clientSecret: SECRET });
  stops.push(() => github.close());
  const databaseUrl = testDatabaseUrl();
  const store = await openCloudStore(databaseUrl);
  stops.push(() => store.close());
  const config: CloudConfig = { databaseUrl, publicUrl: PUBLIC, githubUrl: github.url, clientId: 'hosted-app', clientSecret: SECRET, host: '127.0.0.1', port: 0, trustProxy: false };
  const server = await cloudServer({ config, store });
  stops.push(() => server.close());
  return { github, store, server, databaseUrl };
}

type Set = Awaited<ReturnType<typeof setUp>>;
const setCookies = (h: string | string[] | number | undefined): Map<string, string> =>
  cookiesOf((Array.isArray(h) ? h : [String(h ?? '')]).map((c) => c.split(';')[0]).join('; '));

/** A browser's whole sign-in: hopper.io → GitHub → the callback. */
async function signIn(s: Set) {
  const start = await s.server.inject({ method: 'GET', url: '/auth/github' });
  const state = setCookies(start.headers['set-cookie']).get(SIGN_IN_COOKIE)!;
  const atGitHub = await rawRequest(s.github.url, { path: new URL(String(start.headers.location)).pathname + new URL(String(start.headers.location)).search });
  const back = new URL(String(atGitHub.headers.location));
  const callback = await s.server.inject({ method: 'GET', url: back.pathname + back.search, headers: { cookie: `${SIGN_IN_COOKIE}=${state}` } });
  return { start, state, callback, session: setCookies(callback.headers['set-cookie']).get(SESSION_COOKIE) || undefined };
}

const account = (s: Set, session: string | undefined) =>
  s.server.inject({ method: 'GET', url: '/api/account', ...(session ? { headers: { cookie: `${SESSION_COOKIE}=${session}` } } : {}) });

async function rows(databaseUrl: string): Promise<string> {
  const u = new URL(databaseUrl);
  const schema = u.searchParams.get('schema')!;
  u.searchParams.delete('schema');
  const c = new pg.Client({ connectionString: u.toString() });
  await c.connect();
  try {
    const out: unknown[] = [];
    for (const t of ['account', 'session', 'sign_in']) out.push((await c.query(`SELECT row_to_json(x) AS r FROM "${schema}".${t} x`)).rows);
    return JSON.stringify(out);
  } finally { await c.end(); }
}

describe('sign in at hopper.io with GitHub', () => {
  it('keeps the account by its numeric id, opens a session, and keeps no GitHub token', async () => {
    const s = await setUp();
    s.github.webLogin = 'octo-user';
    const run = await signIn(s);
    expect(run.start.statusCode).toBe(302);
    const to = new URL(String(run.start.headers.location));
    expect(`${to.origin}${to.pathname}`).toBe(`${s.github.url}/login/oauth/authorize`);
    expect(Object.fromEntries(to.searchParams)).toMatchObject({
      client_id: 'hosted-app', redirect_uri: `${PUBLIC}${CALLBACK_PATH}`, state: run.state, code_challenge: expect.any(String), code_challenge_method: 'S256',
    });
    expect(String(run.start.headers['set-cookie'])).toMatch(/HttpOnly; SameSite=Lax/);
    expect(run.callback.statusCode).toBe(303);
    expect(run.session).toBeDefined();

    const me = await account(s, run.session);
    expect(me.statusCode).toBe(200);
    const id = String((await rawUser(s)).id);
    expect(me.json()).toEqual({ githubUserId: id, login: 'octo-user', avatarUrl: `${s.github.url}/avatars/octo-user` });
    expect(await s.store.account(id)).toMatchObject({ login: 'octo-user' });

    const kept = await rows(s.databaseUrl);
    expect(kept).not.toContain('gho_');
    expect(kept).not.toContain(run.session);
    expect(kept).toContain(hashOf(run.session!));
    expect(s.github.requests.find((r) => r.path === '/login/oauth/access_token')?.body).toMatchObject({ client_secret: SECRET, code_verifier: expect.any(String) });

    const home = await s.server.inject({ method: 'GET', url: '/', headers: { cookie: `${SESSION_COOKIE}=${run.session}` } });
    expect(home.body).toContain('octo-user');
    expect(home.headers['content-security-policy']).toContain("default-src 'none'");
  });

  it('the same GitHub id again is one account, with its login and avatar now', async () => {
    const s = await setUp();
    await s.store.signedIn({ githubUserId: '4242', login: 'old-name' });
    await s.store.signedIn({ githubUserId: '4242', login: 'new-name', avatarUrl: 'https://avatars.example/4242' });
    expect(await s.store.account('4242')).toEqual({ githubUserId: '4242', login: 'new-name', avatarUrl: 'https://avatars.example/4242' });
    expect(JSON.parse(await rows(s.databaseUrl))[0]).toHaveLength(1);
  });

  it('a callback whose state this browser did not start opens no session', async () => {
    const s = await setUp();
    s.github.webLogin = 'octo-user';
    const start = await s.server.inject({ method: 'GET', url: '/auth/github' });
    const atGitHub = await rawRequest(s.github.url, { path: new URL(String(start.headers.location)).pathname + new URL(String(start.headers.location)).search });
    const back = new URL(String(atGitHub.headers.location));
    const other = await s.server.inject({ method: 'GET', url: back.pathname + back.search, headers: { cookie: `${SIGN_IN_COOKIE}=another-browser` } });
    expect(other.statusCode).toBe(400);
    expect(setCookies(other.headers['set-cookie']).get(SESSION_COOKIE)).toBeUndefined();
    expect(s.github.requests.some((r) => r.path === '/login/oauth/access_token')).toBe(false);
  });

  it('denied at GitHub: no account and no session', async () => {
    const s = await setUp();
    const run = await signIn(s);
    expect(run.callback.statusCode).toBe(502);
    expect(run.session).toBeUndefined();
    expect(JSON.parse(await rows(s.databaseUrl))[0]).toEqual([]);
  });

  it('sign-out ends the session only, and only from hopper.io itself', async () => {
    const s = await setUp();
    s.github.webLogin = 'octo-user';
    const run = await signIn(s);
    const cookie = `${SESSION_COOKIE}=${run.session}`;
    const form = { 'content-type': 'application/x-www-form-urlencoded' };
    const elsewhere = await s.server.inject({ method: 'POST', url: '/auth/sign-out', headers: { ...form, cookie, origin: 'https://evil.example' }, payload: '' });
    expect(elsewhere.statusCode).toBe(403);
    expect((await account(s, run.session)).statusCode).toBe(200);

    const out = await s.server.inject({ method: 'POST', url: '/auth/sign-out', headers: { ...form, cookie, origin: PUBLIC }, payload: '' });
    expect(out.statusCode).toBe(303);
    expect((await account(s, run.session)).statusCode).toBe(401);
    const id = String((await rawUser(s)).id);
    expect(await s.store.account(id)).toMatchObject({ login: 'octo-user' });
  });

  it('two accounts: each session reads only its own account', async () => {
    const s = await setUp();
    s.github.webLogin = 'ada';
    const a = await signIn(s);
    s.github.webLogin = 'grace';
    const b = await signIn(s);
    expect((await account(s, a.session)).json()).toMatchObject({ login: 'ada' });
    expect((await account(s, b.session)).json()).toMatchObject({ login: 'grace' });
    expect((await account(s, a.session)).json().githubUserId).not.toBe((await account(s, b.session)).json().githubUserId);
  });

  it('refuses sign-ins past the limit per address', async () => {
    const s = await setUp();
    const starts = [];
    for (let i = 0; i <= SIGN_IN_LIMIT.max; i++) starts.push((await s.server.inject({ method: 'GET', url: '/auth/github' })).statusCode);
    expect(starts.slice(0, SIGN_IN_LIMIT.max).every((c) => c === 302)).toBe(true);
    expect(starts.at(-1)).toBe(429);
    expect((await s.server.inject({ method: 'GET', url: '/auth/github', remoteAddress: '127.0.0.2' })).statusCode).toBe(302);
  });
});

/** The fake GitHub's own answer for octo-user: the numeric id the account must be keyed by. */
async function rawUser(s: Set): Promise<{ id: number }> {
  const { accessToken } = s.github.mint('octo-user');
  const r = await rawRequest(s.github.url, { path: '/api/v3/user', headers: { authorization: `token ${accessToken}` } });
  return JSON.parse(r.text) as { id: number };
}
