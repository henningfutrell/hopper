// Issue #795, the auth boundary: an API token alone may read, hold and cancel, but a box action — a route that starts a
// job, runs a command, approves or merges work, updates the hopper or a client, or changes the work on a machine — needs
// a box token: an API token minted with `box: true` from a person's UI session, never by the sign-in exchange, and
// allowed by Access (OpenFGA's `api_token#can_run_on_box`, which holds only for a box token). Real daemon, real HTTP
// server; OpenFGA and the container runtime are doubles at their ports, the gateway realm's issuer a loopback OIDC issuer.
//
// Feature: box tokens
//   Scenario: a token without box reads, holds and cancels, but every box action is refused with the reason
//   Scenario: a person mints a box token; with it an agent launches a sandbox box
//   Scenario: the sign-in exchange never mints a box token
//   Scenario: every listed box action is a route the hopper serves, and no other route asks for a box token
//   Scenario: a model edited before box tokens refuses box actions only
import { afterEach, describe, expect, it } from 'vitest';
import { BOX_ACTIONS } from '../../src/http/ui/box-actions.ts';
import { createFakeAuthorizationServer } from '../support/fake-authorization-server.ts';
import { createFakeContainerRuntime, type FakeContainerRuntime } from '../support/fake-container-runtime.ts';
import { writeConfig } from '../support/files.ts';
import { rawRequest } from '../support/http.ts';
import { startOidcIdp, type OidcIdp } from '../support/idp.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { KEY } from '../support/webhooks.ts';

const IMAGE = 'ghcr.io/henningfutrell/hopper:box-claude';
const BOX_REFUSAL = /box action.*box: true/;

let t: TestApp | undefined;
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  await t?.stop();
  t = undefined;
  for (const c of cleanups.splice(0)) await c();
});

async function boot(o: { signIn?: unknown } = {}): Promise<{ a: TestApp; runtime: FakeContainerRuntime }> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  if (o.signIn !== undefined) writeConfig(db.dbPath, 'sign-in', o.signIn);
  const runtime = createFakeContainerRuntime();
  t = await startTestApp({
    dbPath: db.dbPath, secrets: { HOPPER_MASTER_KEY: KEY }, plugins: { machines: lanes(1) },
    seams: { containerRuntime: runtime, authorizationServer: createFakeAuthorizationServer() },
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

/** A saved, approved sandbox template `kube`, set up with a token that is no box token: none of it is a box action. */
async function template(a: TestApp, token: string): Promise<void> {
  expect((await agent(a, 'POST', '/ui/api/vault', token, { action: 'save-template', name: 'kube', image: IMAGE, secrets: [], profiles: [] })).status).toBe(200);
  expect((await agent(a, 'POST', '/ui/api/vault', token, { action: 'approve-template', name: 'kube' })).status).toBe(200);
}

const openApiPaths = async (a: TestApp): Promise<Record<string, Record<string, unknown>>> =>
  (parsed(await rawRequest(a.url, { path: '/docs/openapi.json' })).body as { paths: Record<string, Record<string, unknown>> }).paths;
const asOpenApi = (route: string): string => route.replace(/:([A-Za-z]+)/g, '{$1}');

describe('box tokens (issue #795)', () => {
  it('a token without box reads, holds and cancels, but every box action is refused with the reason', async () => {
    const { a, runtime } = await boot();
    const token = (await mint(a, await a.login())).body.token as string;
    expect((await agent(a, 'GET', '/api/queue', token)).status).toBe(200);
    expect((await agent(a, 'POST', '/ui/api/queue/order', token, { jobIds: [] })).status).toBe(200);
    // A hold and a cancel reach the engine: a job that is not there, not a refusal.
    expect((await agent(a, 'POST', '/ui/api/jobs/nope/park', token, {})).status).not.toBe(403);
    expect((await agent(a, 'POST', '/ui/api/jobs/nope/cancel', token, {})).status).not.toBe(403);
    await template(a, token);

    const launch = await agent(a, 'POST', '/ui/api/machines/sandbox', token, { template: 'kube', params: {} });
    expect(launch.status).toBe(403);
    expect(launch.body.error).toMatch(BOX_REFUSAL);
    expect(runtime.boxes.size).toBe(0);
    for (const path of ['/ui/api/jobs/nope/approve', '/ui/api/questions/nope/answer', '/ui/api/pull-requests/merge', '/ui/api/update']) {
      const r = await agent(a, 'POST', path, token, {});
      expect(r.status, `${path}: ${r.text}`).toBe(403);
      expect(r.body.error, path).toMatch(BOX_REFUSAL);
    }
  });

  it('a person mints a box token; with it an agent launches a sandbox box', async () => {
    const { a, runtime } = await boot();
    const session = await a.login();
    const minted = await mint(a, session, { box: true, minutes: 10 });
    expect(minted.status).toBe(200);
    expect(minted.body).toMatchObject({ box: true, role: 'admin' });
    const plain = (await mint(a, session)).body as { id: string; box: boolean };
    expect(plain.box).toBe(false);
    const listed = await a.api('GET', '/api/api-tokens', undefined, { 'x-hopper-session': session });
    expect(listed.body.tokens).toEqual([
      expect.objectContaining({ id: minted.body.id, box: true }), expect.objectContaining({ id: plain.id, box: false }),
    ]);

    const token = minted.body.token as string;
    await template(a, token);
    const launch = await agent(a, 'POST', '/ui/api/machines/sandbox', token, { template: 'kube', params: {} });
    expect(launch.status, launch.text).toBe(200);
    expect(runtime.boxes.get(launch.body.container as string)?.spec.image).toBe(IMAGE);
    // A box token does not mint one either.
    expect((await agent(a, 'POST', '/ui/api/api-tokens', token, { action: 'mint', label: 'again', box: true })).status).toBe(403);
  });

  it('the sign-in exchange never mints a box token', async () => {
    const idp: OidcIdp = await startOidcIdp();
    cleanups.push(() => idp.stop());
    const realm = { name: 'edge', label: 'Edge gateway', type: 'gateway', issuer: idp.issuer, audience: ['hopper'], roles: { admin: { usernames: ['ada'] } } };
    const { a } = await boot({ signIn: { version: 1, realms: [realm] } });
    const jwt = () => idp.token({ sub: 'ada-1', aud: 'hopper', preferred_username: 'ada' }, 300);
    const signedIn = await rawRequest(a.url, { method: 'POST', path: '/ui/auth/gateway', body: '{}', headers: { authorization: `Bearer ${await jwt()}`, origin: `http://127.0.0.1:${new URL(a.url).port}`, 'content-type': 'application/json' } });
    expect(signedIn.status).toBe(200);
    const exchange = async (body: Record<string, unknown>) => parsed(await rawRequest(a.url, {
      method: 'POST', path: '/ui/auth/api-token', body: JSON.stringify(body), headers: { authorization: `Bearer ${await jwt()}`, 'content-type': 'application/json' },
    }));

    expect((await exchange({ label: 'grok-bot', box: true })).status).toBe(400);
    const r = await exchange({ label: 'grok-bot' });
    expect(r.status).toBe(200);
    expect(r.body.box).toBe(false);
    const refused = await agent(a, 'POST', '/ui/api/jobs/nope/approve', r.body.token, {});
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatch(BOX_REFUSAL);
  });

  it('every listed box action is a route the hopper serves, and no other route asks for a box token', async () => {
    const { a } = await boot();
    const token = (await mint(a, await a.login())).body.token as string;
    const paths = await openApiPaths(a);
    const boxPaths = new Set(BOX_ACTIONS.map((b) => asOpenApi(b.route)));
    for (const path of boxPaths) expect(paths[path], `${path} is listed as a box action, but the hopper serves no POST there`).toHaveProperty('post');
    const routes = Object.entries(paths).filter(([path, ops]) => path.startsWith('/ui/api/') && 'post' in ops && path !== '/ui/api/logout').map(([path]) => path);
    for (const path of routes) {
      const r = await agent(a, 'POST', path.replace(/\{[^}]+\}/g, 'x'), token, { probe: true });
      if (boxPaths.has(path)) expect(r.body?.error, `${path}: ${r.text}`).toMatch(BOX_REFUSAL);
      else expect(r.body?.error ?? '', `${path}: ${r.text}`).not.toMatch(BOX_REFUSAL);
    }
  });

  it('a model edited before box tokens refuses box actions only', async () => {
    const { a } = await boot();
    const session = await a.login();
    const token = (await mint(a, session, { box: true })).body.token as string;
    const access = await a.api('GET', '/api/access', undefined, { 'x-hopper-session': session });
    const dsl = (access.body.model.dsl as string).replace(/\n *define box_runner: \[user\]\n *define can_run_on_box: [^\n]*/, '');
    expect(dsl).not.toBe(access.body.model.dsl);
    expect((await a.ui('/ui/api/access', { action: 'model', dsl, version: access.body.model.version }, { token: session })).status).toBe(200);

    expect((await agent(a, 'POST', '/ui/api/queue/order', token, { jobIds: [] })).status).toBe(200);
    const refused = await agent(a, 'POST', '/ui/api/jobs/nope/approve', token, {});
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatch(/can_run_on_box/);
    // A box token is not minted against a model that cannot decide it.
    const again = await mint(a, session, { box: true });
    expect(again.status).toBe(403);
    expect(again.body.error).toMatch(/can_run_on_box/);
  });
});
