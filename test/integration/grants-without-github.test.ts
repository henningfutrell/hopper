// Service-account tokens with no GitHub (issue #1380; grants: issues #881, #909): a person who signs in with a local
// account or through an OIDC realm mints a grant for an agent, and the agent acts with its tokens as that person, within
// its scopes, on a hopper that holds no GitHub App and no GitHub connection. Two people's grants each reach only their
// own person's work. Real daemon, real HTTP server, the CLI on the same database; OpenFGA is a double at its port, the
// identity provider a loopback OIDC issuer.
//
// Feature: grants for people who sign in without GitHub
//   Scenario: the first admin of a realm-only hopper (operator CLI) mints a grant; its tokens refresh and act as them
//   Scenario: a second local account's grant reaches only its own person's grants, and no higher role than theirs
//   Scenario: a person signed in through OIDC mints a grant; its tokens act as them
import { afterEach, describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../../src/cli.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { databaseUrlFor, newHopper } from '../support/database.ts';
import { createFakeAuthorizationServer } from '../support/fake-authorization-server.ts';
import { writeConfig } from '../support/files.ts';
import { rawRequest } from '../support/http.ts';
import { signIn as oidcSignIn } from '../support/idp.ts';
import { harness, oidcIdp, oidcRealm, SECRETS, session, stopAll } from '../support/sign-in-app.ts';
import { KEY } from '../support/webhooks.ts';

const h = harness();
afterEach(() => stopAll(h));

const PASSWORD = 'correct horse battery staple';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read loose JSON
type Answer = { status: number; body: any; text: string };
const parsed = (r: { status: number; text: string }): Answer => ({ status: r.status, text: r.text, body: r.text ? JSON.parse(r.text) : undefined });

/** A new hopper (no user) with this sign-in config, a master key and OpenFGA: no GitHub App, no GitHub connection. */
async function start(auth: unknown): Promise<{ app: TestApp; origin: string; host: string }> {
  const db = tempDbPath();
  h.cleanup = db.cleanup;
  newHopper(db.dbPath);
  writeConfig(db.dbPath, 'sign-in', auth);
  h.t = await startTestApp({
    dbPath: db.dbPath, secrets: { ...SECRETS, HOPPER_MASTER_KEY: KEY },
    seams: { authorizationServer: createFakeAuthorizationServer() },
  });
  const port = new URL(h.t.url).port;
  return { app: h.t, origin: `http://localhost:${port}`, host: `localhost:${port}` };
}

async function cli(app: TestApp, argv: string[], stdin = ''): Promise<number> {
  const io: CliIo = { env: { HOPPER_DATABASE_URL: databaseUrlFor(app.dbPath) }, stdin: () => stdin, out: () => {}, err: () => {} };
  return runCli(argv, io);
}

async function passwordSignIn(o: { app: TestApp; origin: string; host: string }, email: string): Promise<string> {
  const r = await rawRequest(o.app.url, {
    path: '/ui/auth/password', method: 'POST', body: JSON.stringify({ username: email, password: PASSWORD }),
    headers: { host: o.host, origin: o.origin, 'content-type': 'application/json' },
  });
  expect(r.status, r.text).toBe(200);
  return (JSON.parse(r.text) as { token: string }).token;
}

async function mint(app: TestApp, token: string, body: Record<string, unknown>): Promise<Answer> {
  const r = await app.ui('/ui/api/api-tokens', { action: 'mint', label: 'Agent', holder: 'agent', ...body }, { token });
  return { status: r.status, body: r.body, text: JSON.stringify(r.body) };
}

const refresh = async (app: TestApp, token: string): Promise<Answer> =>
  parsed(await rawRequest(app.url, { method: 'POST', path: '/ui/auth/token/refresh', body: JSON.stringify({ refresh: token }), headers: { 'content-type': 'application/json' } }));

const agent = async (app: TestApp, method: 'GET' | 'POST', path: string, token: string, body?: unknown): Promise<Answer> =>
  parsed(await rawRequest(app.url, {
    method, path, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));

/** The grants an API token's own person holds, by holder: whose work the token reaches. */
const grantsSeen = async (app: TestApp, token: string): Promise<string[]> => {
  const r = await agent(app, 'GET', '/api/api-tokens', token);
  expect(r.status, r.text).toBe(200);
  return (r.body.grants as { holder: string }[]).map((g) => g.holder).sort();
};

describe('grants for people who sign in without GitHub (issue #1380)', () => {
  it('the first admin of a realm-only hopper mints a grant; its tokens refresh and act as them', async () => {
    const o = await start({ version: 1, realms: [] });
    expect(await cli(o.app, ['local-account', 'add', 'ada@example.com'], `${PASSWORD}\n`)).toBe(0);
    const ada = await passwordSignIn(o, 'ada@example.com');
    expect((await session(o.app, ada)).user).toMatchObject({ role: 'admin', realm: 'local-accounts', instanceAdmin: true });
    expect(o.app.app.instance.users.list().map((u) => u.email)).toEqual(['ada@example.com']);

    const minted = await mint(o.app, ada, { preset: 'agent-intake', role: 'operator', holder: 'ada-agent' });
    expect(minted.status, minted.text).toBe(200);
    expect(minted.body).toMatchObject({ token: expect.stringMatching(/^hopper_at_/), refresh: expect.stringMatching(/^hopper_rt_/), view: { role: 'operator', box: true } });
    let pair = { token: minted.body.token as string, refresh: minted.body.refresh as string };
    for (let i = 0; i < 2; i++) {
      const r = await refresh(o.app, pair.refresh);
      expect(r.status, r.text).toBe(200);
      pair = { token: r.body.token, refresh: r.body.refresh };
    }
    expect(await grantsSeen(o.app, pair.token)).toEqual(['ada-agent']);
    for (const read of ['/api/scopes', '/api/sources', '/api/queue']) expect((await agent(o.app, 'GET', read, pair.token)).status, read).toBe(200);
    // In scope: the route answers for itself (no such source), not the scope or the box flag.
    const intake = await agent(o.app, 'POST', '/ui/api/sources/nope/intake', pair.token, { kind: 'approve', keys: ['nope#1'] });
    expect(intake.body?.error ?? '').not.toMatch(/scope|box token/);
    // Out of scope: refused, naming the scope.
    expect((await agent(o.app, 'POST', '/ui/api/queue/order', pair.token, { jobIds: [] })).body.error).toMatch(/do not cover queue:order/);
  });

  it('a second local account\'s grant reaches only its own person\'s grants, and no higher role than theirs', async () => {
    const o = await start({ version: 1, realms: [] });
    expect(await cli(o.app, ['local-account', 'add', 'ada@example.com'], `${PASSWORD}\n`)).toBe(0);
    expect(await cli(o.app, ['local-account', 'add', 'bea@example.com', '--role', 'operator'], `${PASSWORD}\n`)).toBe(0);
    const ada = await passwordSignIn(o, 'ada@example.com');
    const bea = await passwordSignIn(o, 'bea@example.com');
    expect((await session(o.app, bea)).user).toMatchObject({ role: 'operator', realm: 'local-accounts' });

    const adas = await mint(o.app, ada, { scopes: ['*:read'], holder: 'ada-agent' });
    expect(adas.status, adas.text).toBe(200);
    expect((await mint(o.app, bea, { scopes: ['*:read'], role: 'admin', holder: 'bea-agent' })).body.error).toMatch(/may not act above its minter/);
    const beas = await mint(o.app, bea, { scopes: ['*:read'], holder: 'bea-agent' });
    expect(beas.status, beas.text).toBe(200);
    expect(beas.body.view).toMatchObject({ role: 'operator' });

    expect(await grantsSeen(o.app, adas.body.token)).toEqual(['ada-agent']);
    expect(await grantsSeen(o.app, beas.body.token)).toEqual(['bea-agent']);
    // An admin read is an admin's: bea's grant may not read the users.
    expect((await agent(o.app, 'GET', '/api/users', beas.body.token)).status).toBe(403);
    expect((await agent(o.app, 'GET', '/api/users', adas.body.token)).status).toBe(200);
  });

  it('a person signed in through OIDC mints a grant; its tokens act as them', async () => {
    const idp = await oidcIdp(h, { claims: { sub: 'sub-cy', preferred_username: 'cy', email: 'cy@example.com', email_verified: true }, userinfo: { sub: 'sub-cy' } });
    const o = await start({ version: 1, realms: [oidcRealm(idp, { defaultRole: 'operator' })] });
    const cy = (await oidcSignIn(o.app.url, o.origin, 'corp')).token!;
    expect((await session(o.app, cy)).user).toMatchObject({ role: 'operator', realm: 'corp' });

    const minted = await mint(o.app, cy, { preset: 'read-only', holder: 'cy-agent' });
    expect(minted.status, minted.text).toBe(200);
    const r = await refresh(o.app, minted.body.refresh);
    expect(r.status, r.text).toBe(200);
    expect(await grantsSeen(o.app, r.body.token)).toEqual(['cy-agent']);
    expect((await agent(o.app, 'GET', '/api/queue', r.body.token)).status).toBe(200);
  });
});
