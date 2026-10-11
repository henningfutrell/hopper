// Issue #718, item 4: everything a person can do in the UI, an agent can do over the API, with a short-lived API token
// scoped to what its user may do. The token is a kind of UI session: minted by a signed-in person (Settings, or the
// operator CLI), or exchanged for a sign-in the API door accepts (a gateway realm's JWT, a GitHub token); it lives an
// hour at most, acts with a role no higher than its minter's, never mints another token, and Access (OpenFGA's
// `api_token#can_view|can_operate|can_administer`) decides each use. Real daemon, real HTTP server, real CLI; OpenFGA and
// the container runtime are doubles at their ports, the gateway realm's issuer a loopback OIDC issuer.
//
// Feature: API tokens
//   Scenario: a person mints a token, and an agent with it sets a secret, saves and approves a template and launches a box
//     Given a hopper with a master key, a machine and OpenFGA
//     When the admin mints an API token for 15 minutes in the UI, as a box token (issue #795: a launch is a box action)
//     Then the token is answered once and listed with no value
//     And with only `Authorization: Bearer <token>` — no UI session, no Origin — the agent sets a vault secret, saves and
//       approves a template, and launches a sandbox box of it
//   Scenario: every POST /ui/api/* route takes an API token: a refusal is the role's, never the session's or the Origin's
//   Scenario: a token acts with the role it was minted with, at most an hour, and never mints a token
//   Scenario: revoked, a token is refused; a token the hopper never made is refused and never sent to GitHub
//   Scenario: Access decides each use: a model that denies can_administer refuses the token's admin actions only
//   Scenario: without OpenFGA, no API token is minted
//   Scenario: an agent exchanges its gateway sign-in for an API token, as the user it is linked to
//   Scenario: the operator CLI mints, lists and revokes a token
import { afterEach, describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../../src/cli.ts';
import { databaseUrlFor } from '../support/database.ts';
import { createFakeAuthorizationServer } from '../support/fake-authorization-server.ts';
import { createFakeContainerRuntime, type FakeContainerRuntime } from '../support/fake-container-runtime.ts';
import { writeConfig } from '../support/files.ts';
import { rawRequest } from '../support/http.ts';
import { startOidcIdp, type OidcIdp } from '../support/idp.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { KEY } from '../support/webhooks.ts';

const IMAGE = 'ghcr.io/henningfutrell/hopper:box-claude';
const VALUE = 'kube-value-0123456789abcdef-never-read-back';
const TOKEN = /^hopper_at_[0-9a-f]{64}$/;

let t: TestApp | undefined;
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  await t?.stop();
  t = undefined;
  for (const c of cleanups.splice(0)) await c();
});

async function boot(o: { openFga?: boolean; signIn?: unknown } = {}): Promise<{ a: TestApp; runtime: FakeContainerRuntime }> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  if (o.signIn !== undefined) writeConfig(db.dbPath, 'sign-in', o.signIn);
  const runtime = createFakeContainerRuntime();
  t = await startTestApp({
    dbPath: db.dbPath, secrets: { HOPPER_MASTER_KEY: KEY }, plugins: { machines: lanes(1) },
    seams: { containerRuntime: runtime, authorizationServer: o.openFga === false ? undefined : createFakeAuthorizationServer() },
  });
  return { a: t, runtime };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read loose JSON
type Answer = { status: number; body: any; text: string };
const parsed = (r: { status: number; text: string }): Answer => ({ status: r.status, text: r.text, body: r.text ? JSON.parse(r.text) : undefined });

/** A request as an agent sends it: the token in Authorization, JSON, no UI session, no Origin. */
async function agent(a: TestApp, method: 'GET' | 'POST', path: string, token: string, body?: unknown): Promise<Answer> {
  return parsed(await rawRequest(a.url, {
    method, path, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
}

async function mint(a: TestApp, session: string, body: Record<string, unknown> = {}): Promise<Answer> {
  const r = await a.ui('/ui/api/api-tokens', { action: 'mint', label: 'grok-bot', ...body }, { token: session });
  return { status: r.status, body: r.body, text: JSON.stringify(r.body) };
}

describe('API tokens (issue #718)', () => {
  it('a person mints a token; with it alone an agent sets a secret, saves and approves a template, and launches a box', async () => {
    const { a, runtime } = await boot();
    const session = await a.login();
    const before = Date.now();
    const minted = await mint(a, session, { minutes: 15, box: true });
    expect(minted.status).toBe(200);
    expect(minted.body).toMatchObject({ label: 'grok-bot', role: 'admin', box: true, token: expect.stringMatching(TOKEN), id: expect.any(String) });
    const expires = Date.parse(minted.body.expiresAt);
    expect(expires).toBeGreaterThan(before);
    expect(expires).toBeLessThanOrEqual(Date.now() + 15 * 60_000);
    const token = minted.body.token as string;

    // Listed, never with the token; the token is no UI session: in the session header it acts for nobody.
    const listed = await a.api('GET', '/api/api-tokens', undefined, { 'x-hopper-session': session });
    expect(listed.status).toBe(200);
    expect(listed.body.tokens).toEqual([expect.objectContaining({ id: minted.body.id, label: 'grok-bot', role: 'admin', expiresAt: minted.body.expiresAt })]);
    expect(JSON.stringify(listed.body)).not.toContain(token);
    expect((await a.ui('/ui/api/queue/order', { jobIds: [] }, { token })).status).toBe(403);

    // The agent: the token alone.
    expect((await agent(a, 'POST', '/ui/api/vault', token, { action: 'set', name: 'KUBE_TOKEN', value: VALUE })).status).toBe(200);
    expect((await agent(a, 'POST', '/ui/api/vault', token, {
      action: 'save-template', name: 'kube', image: IMAGE, secrets: ['KUBE_TOKEN'], profiles: [],
    })).status).toBe(200);
    expect((await agent(a, 'POST', '/ui/api/vault', token, { action: 'approve-template', name: 'kube' })).status).toBe(200);
    const vault = await agent(a, 'GET', '/api/vault', token);
    expect(vault.status).toBe(200);
    expect(vault.body.secrets).toEqual([expect.objectContaining({ name: 'KUBE_TOKEN' })]);
    expect(vault.text).not.toContain(VALUE);
    const launch = await agent(a, 'POST', '/ui/api/machines/sandbox', token, { template: 'kube', params: {} });
    expect(launch.status).toBe(200);
    expect(runtime.boxes.get(launch.body.container as string)?.spec.image).toBe(IMAGE);
  });

  it('every POST /ui/api/* route takes an API token: a refusal is the role\'s, never the session\'s or the Origin\'s', async () => {
    const { a } = await boot();
    const viewer = (await mint(a, await a.login(), { role: 'viewer' })).body.token as string;
    const doc = parsed(await rawRequest(a.url, { path: '/docs/openapi.json' })).body as { paths: Record<string, Record<string, unknown>> };
    const routes = Object.entries(doc.paths).filter(([path, ops]) => path.startsWith('/ui/api/') && 'post' in ops && path !== '/ui/api/logout').map(([path]) => path);
    expect(routes.length).toBeGreaterThan(50);
    for (const path of routes) {
      const r = await agent(a, 'POST', path.replace(/\{[^}]+\}/g, 'x'), viewer, { probe: true });
      expect(r.status, `${path}: ${r.text}`).not.toBe(401);
      if (r.status === 403) expect(r.body, `${path}: ${r.text}`).toHaveProperty('needs');
    }
    // Logout with a token ends that token.
    expect((await agent(a, 'POST', '/ui/api/logout', viewer, {})).status).toBe(200);
    expect((await agent(a, 'GET', '/api/queue', viewer)).status).toBe(401);
  });

  it('a token acts with the role it was minted with, lives an hour at most, and never mints a token', async () => {
    const { a } = await boot();
    const session = await a.login();
    const operator = (await mint(a, session, { role: 'operator' })).body.token as string;
    const refused = await agent(a, 'POST', '/ui/api/vault', operator, { action: 'set', name: 'KUBE_TOKEN', value: VALUE });
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ needs: 'admin' });
    expect((await agent(a, 'POST', '/ui/api/queue/order', operator, { jobIds: [] })).status).toBe(200);

    expect((await mint(a, session, { minutes: 61 })).status).toBe(400);
    const chained = await agent(a, 'POST', '/ui/api/api-tokens', operator, { action: 'mint', label: 'again' });
    expect(chained.status).toBe(403);
    expect(chained.body.error).toMatch(/API token/);
  });

  it('a revoked token is refused; a token the hopper never made is refused and never sent to GitHub', async () => {
    const { a } = await boot();
    const session = await a.login();
    const minted = (await mint(a, session)).body as { token: string; id: string };
    expect((await agent(a, 'GET', '/api/queue', minted.token)).status).toBe(200);
    const revoked = await a.ui<{ tokens: unknown[] }>('/ui/api/api-tokens', { action: 'revoke', id: minted.id }, { token: session });
    expect(revoked.status).toBe(200);
    expect(revoked.body.tokens).toEqual([]);
    expect((await agent(a, 'GET', '/api/queue', minted.token)).status).toBe(401);
    expect((await agent(a, 'POST', '/ui/api/queue/order', minted.token, { jobIds: [] })).status).toBe(403);

    const unknown = await agent(a, 'GET', '/api/queue', `hopper_at_${'0'.repeat(64)}`);
    expect(unknown.status).toBe(401);
    expect(unknown.body.error).toMatch(/API token/);
  });

  it('Access decides each use: a model that denies can_administer refuses the token\'s admin actions only', async () => {
    const { a } = await boot();
    const session = await a.login();
    const token = (await mint(a, session)).body.token as string;
    const access = await a.api('GET', '/api/access', undefined, { 'x-hopper-session': session });
    const dsl = (access.body.model.dsl as string).replace(/define can_administer: owner/, 'define can_administer: [user]');
    expect(dsl).not.toBe(access.body.model.dsl);
    expect((await a.ui('/ui/api/access', { action: 'model', dsl, version: access.body.model.version }, { token: session })).status).toBe(200);

    const refused = await agent(a, 'POST', '/ui/api/vault', token, { action: 'set', name: 'KUBE_TOKEN', value: VALUE });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatch(/can_administer/);
    expect((await agent(a, 'POST', '/ui/api/queue/order', token, { jobIds: [] })).status).toBe(200);
    expect((await agent(a, 'GET', '/api/vault', token)).status).toBe(200);
    // The person's own session is not an API token: Access does not stand in its way.
    expect((await a.ui('/ui/api/vault', { action: 'set', name: 'KUBE_TOKEN', value: VALUE }, { token: session })).status).toBe(200);
  });

  it('without OpenFGA, no API token is minted', async () => {
    const { a } = await boot({ openFga: false });
    const r = await mint(a, await a.login());
    expect(r.status).toBe(503);
    expect(r.body.error).toMatch(/OpenFGA/);
  });

  it('an agent exchanges its gateway sign-in for an API token, as the user it is linked to', async () => {
    const idp: OidcIdp = await startOidcIdp();
    cleanups.push(() => idp.stop());
    const realm = { name: 'edge', label: 'Edge gateway', type: 'gateway', issuer: idp.issuer, audience: ['hopper'], roles: { admin: { usernames: ['ada'] }, defaultRole: 'viewer' } };
    const { a } = await boot({ signIn: { version: 1, realms: [realm] } });
    const jwt = (who: string) => idp.token({ sub: `${who}-1`, aud: 'hopper', preferred_username: who }, 300);
    const exchange = async (bearer: string, body: Record<string, unknown>) => parsed(await rawRequest(a.url, {
      method: 'POST', path: '/ui/auth/api-token', body: JSON.stringify(body), headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    }));

    // Nobody signed in as ada yet: the door signs nobody new in.
    expect((await exchange(await jwt('ada'), { label: 'grok-bot' })).status).toBe(401);
    const signedIn = await rawRequest(a.url, { method: 'POST', path: '/ui/auth/gateway', body: '{}', headers: { authorization: `Bearer ${await jwt('ada')}`, origin: `http://127.0.0.1:${new URL(a.url).port}`, 'content-type': 'application/json' } });
    expect(signedIn.status).toBe(200);

    const r = await exchange(await jwt('ada'), { label: 'grok-bot', minutes: 10 });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ role: 'admin', label: 'grok-bot', token: expect.stringMatching(TOKEN) });
    expect((await agent(a, 'POST', '/ui/api/queue-gate', r.body.token, { mode: 'review', autoAcceptPerHour: null })).status).toBe(200);
    // An API token is not a sign-in the door exchanges.
    expect((await exchange(r.body.token, { label: 'again' })).status).toBe(401);
    expect((await exchange(await jwt('ada'), { label: 'grok-bot', role: 'admin', minutes: 120 })).status).toBe(400);
  });

  it('the operator CLI mints, lists and revokes a token', async () => {
    const { a } = await boot();
    const out: string[] = [];
    const err: string[] = [];
    const io: CliIo = { env: { HOPPER_DATABASE_URL: databaseUrlFor(a.dbPath) }, stdin: () => '', out: (x) => out.push(x), err: (x) => err.push(x) };
    const hopper = async (argv: string[]) => {
      out.length = 0;
      err.length = 0;
      const code = await runCli([...argv, '--url', a.url], io);
      return { code, out: out.join(''), err: err.join('') };
    };
    const minted = await hopper(['token', 'mint', '--label', 'grok-bot', '--role', 'operator', '--minutes', '10']);
    expect(minted).toMatchObject({ code: 0 });
    const m = JSON.parse(minted.out) as { token: string; id: string; role: string };
    expect(m).toMatchObject({ role: 'operator', token: expect.stringMatching(TOKEN) });
    expect((await agent(a, 'POST', '/ui/api/queue/order', m.token, { jobIds: [] })).status).toBe(200);

    const list = await hopper(['token', 'list']);
    expect(list.code).toBe(0);
    expect(JSON.parse(list.out).tokens).toEqual([expect.objectContaining({ id: m.id, label: 'grok-bot', role: 'operator' })]);
    expect(list.out).not.toContain(m.token);
    expect((await hopper(['token', 'revoke', m.id])).code).toBe(0);
    expect((await agent(a, 'GET', '/api/queue', m.token)).status).toBe(401);
    expect(await hopper(['token', 'mint'])).toMatchObject({ code: 2, err: expect.stringContaining('--label') });
  });
});
