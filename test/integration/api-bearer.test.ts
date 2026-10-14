// The API door (issue #255): a token in `Authorization: Bearer …` reads /api/ as the user the same token
// signs in as at the UI door — one pipeline, two doors. The same sign-in service checks it, the same
// role rules grant it a role, and the same identity link names its user; the API door signs nobody new in.
//   - A gateway realm's JWT (issue #215): its signature checked against the issuer's keys (JWKS), as
//     POST /ui/auth/gateway checks it. The issuer is a loopback OIDC issuer signing with its own key.
//   - A GitHub token (issue #214): GitHub says whose it is, as the GitHub sign-in asks; it reads only as
//     the user whose connected GitHub account it is. GitHub is a fake on loopback.
// Everything else is real: the daemon, its store, its HTTP edge. Requests name the public URL's Host, as a
// reverse proxy passes them on: there /api/ needs a credential (on loopback, one user's hopper reads without).
//
// Feature: a token reads the API as the user it signs in as
//   Scenario: a gateway JWT reads as its user, and only its own user's work
//   Scenario: a token the gateway realm refuses is refused at both doors, on loopback too
//   Scenario: a valid JWT of someone who never signed in is refused, and makes no user
//   Scenario: turning the realm off, or a rule granting no role, closes both doors at once
//   Scenario: a token reads; it never mutates, and admin reads need an admin
//   Scenario: a GitHub token reads as the user whose connected GitHub account it is
//   Scenario: a GitHub token not tied to a connected GitHub account is refused
import { afterEach, describe, expect, it } from 'vitest';
import type { ConnectedAccountStatus } from '../../src/domain/types.ts';
import type { TestApp } from '../support/app.ts';
import { createFakeGitHub, type FakeForge } from '../support/fake-forges.ts';
import { rawRequest } from '../support/http.ts';
import type { OidcIdp } from '../support/idp.ts';
import { harness, oidcIdp, startWithAuth, stopAll } from '../support/sign-in-app.ts';
import { waitFor } from '../support/wait.ts';

const h = harness();
afterEach(() => stopAll(h));

const PUBLIC = 'https://hopper.example.com';
const HOST = 'hopper.example.com';
const ENV = { HOPPER_PUBLIC_URL: PUBLIC };

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read loose JSON
async function read(app: TestApp, path: string, headers: Record<string, string> = {}, host = HOST): Promise<{ status: number; body: any }> {
  const r = await rawRequest(app.url, { path, headers: { host, ...headers } });
  return { status: r.status, body: r.text ? JSON.parse(r.text) : undefined };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read loose JSON
async function post(app: TestApp, path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  const r = await rawRequest(app.url, { method: 'POST', path, body: JSON.stringify(body), headers: { host: HOST, origin: PUBLIC, 'content-type': 'application/json', ...headers } });
  return { status: r.status, body: r.text ? JSON.parse(r.text) : undefined };
}

// ---- the gateway realm: a JWT checked against the issuer's keys -----------------------------------

const gatewayRealm = (idp: Pick<OidcIdp, 'issuer'>, roles: unknown) =>
  ({ name: 'edge', label: 'Edge gateway', type: 'gateway', issuer: idp.issuer, audience: ['hopper'], roles });
const ROLES = { admin: { usernames: ['ada'] }, defaultRole: 'viewer' };

const jwtOf = (idp: OidcIdp, who: string, claims: Record<string, unknown> = {}, expiresIn = 300) =>
  idp.token({ sub: `${who}-1`, aud: 'hopper', preferred_username: who, ...claims }, expiresIn);

/** The UI door: the gateway's token exchanged for a session (the identity is linked to its user here). */
const uiDoor = (app: TestApp, token: string) => post(app, '/ui/auth/gateway', {}, bearer(token));

async function withGateway(roles: unknown = ROLES) {
  const idp = await oidcIdp(h);
  const { app } = await startWithAuth(h, { version: 1, realms: [gatewayRealm(idp, roles)] }, ENV);
  return { idp, app };
}

describe('the API door: a gateway realm\'s JWT', () => {
  it('reads /api/ as the user the same token signs in as at the UI door, and only that user\'s work', async () => {
    const { idp, app } = await withGateway();
    const ada = await jwtOf(idp, 'ada');
    const bob = await jwtOf(idp, 'bob');
    const adaSession = await uiDoor(app, ada);
    expect(adaSession.status).toBe(200);
    expect((await uiDoor(app, bob)).status).toBe(200);
    // ada's own setting, made through her UI session: her queue waits for review.
    expect((await post(app, '/ui/api/queue-gate', { mode: 'review', autoAcceptPerHour: null }, { 'x-hopper-session': adaSession.body.token })).status).toBe(200);

    expect((await read(app, '/api/queue')).status).toBe(401);
    const asAda = await read(app, '/api/queue', bearer(ada));
    expect(asAda.status).toBe(200);
    expect(asAda.body.gate.mode).toBe('review');
    // A token minted later for the same person is the same user.
    expect((await read(app, '/api/queue', bearer(await jwtOf(idp, 'ada')))).body.gate.mode).toBe('review');
    const asBob = await read(app, '/api/queue', bearer(bob));
    expect(asBob.status).toBe(200);
    expect(asBob.body.gate.mode).toBe('auto-accept');
    // The token reads what the session reads.
    expect(asAda.body).toEqual((await read(app, '/api/queue', { 'x-hopper-session': adaSession.body.token })).body);
  });

  it('a token the realm refuses is refused at both doors with the same reason, and on loopback too', async () => {
    const { idp, app } = await withGateway({ defaultRole: 'admin' });
    const other = await oidcIdp(h);
    expect((await uiDoor(app, await jwtOf(idp, 'ada'))).status).toBe(200);
    const loopback = `127.0.0.1:${new URL(app.url).port}`;
    // Loopback with one user would read without a credential: a credential given and refused still fails.
    for (const token of [
      await jwtOf(idp, 'ada', { aud: 'someone-else' }),
      await jwtOf(idp, 'ada', {}, -120),
      await other.token({ sub: 'ada-1', aud: 'hopper', preferred_username: 'ada', iss: idp.issuer }, 300),
      'not-a-jwt.at.all',
    ]) {
      const ui = await uiDoor(app, token);
      const api = await read(app, '/api/queue', bearer(token));
      expect(ui.status).toBe(403);
      expect(api.status).toBe(401);
      expect(api.body.error).toContain(ui.body.error);
      expect((await read(app, '/api/queue', bearer(token), loopback)).status).toBe(401);
    }
  });

  it('a valid JWT of someone who never signed in at the UI door is refused, and makes no user', async () => {
    const { idp, app } = await withGateway({ defaultRole: 'admin' });
    const users = app.app.instance.users.list().length;
    const r = await read(app, '/api/queue', bearer(await jwtOf(idp, 'carol')));
    expect(r.status).toBe(401);
    expect(r.body.error).toMatch(/no hopper user/);
    expect(app.app.instance.users.list()).toHaveLength(users);
  });

  it('turning the realm off, or a rule that grants no role, closes both doors at once', async () => {
    const { idp, app } = await withGateway({ operator: { usernames: ['ada'] } });
    const ada = await jwtOf(idp, 'ada');
    expect((await uiDoor(app, ada)).status).toBe(200);
    expect((await read(app, '/api/queue', bearer(ada))).status).toBe(200);
    const admin = await app.login();
    const change = async (body: Record<string, unknown>) => {
      const version = (await app.api<{ version: string }>('GET', '/api/realms', undefined, { 'x-hopper-session': admin })).body.version;
      expect((await app.ui('/ui/api/realms', { ...body, version }, { token: admin })).status).toBe(200);
    };

    await change({ action: 'save', name: 'edge', realm: { ...gatewayRealm(idp, { operator: { usernames: ['someone-else'] } }) } });
    expect((await uiDoor(app, ada)).body.error).toMatch(/no role/);
    const noRole = await read(app, '/api/queue', bearer(ada));
    expect(noRole.status).toBe(403);
    expect(noRole.body.error).toMatch(/no role/);

    await change({ action: 'save', name: 'edge', realm: { ...gatewayRealm(idp, { operator: { usernames: ['ada'] } }) } });
    expect((await read(app, '/api/queue', bearer(ada))).status).toBe(200);
    await change({ action: 'enable', name: 'edge', enabled: false });
    expect((await uiDoor(app, ada)).status).toBe(403);
    expect((await read(app, '/api/queue', bearer(ada))).status).toBe(401);
  });

  it('a token reads; it never mutates, and an admin read needs an admin', async () => {
    const { idp, app } = await withGateway();
    const ada = await jwtOf(idp, 'ada');
    const bob = await jwtOf(idp, 'bob');
    await uiDoor(app, ada);
    await uiDoor(app, bob);
    // Mutations stay behind a UI session (AGENTS.md): a token is no session.
    expect((await post(app, '/ui/api/queue-gate', { mode: 'review', autoAcceptPerHour: null }, bearer(ada))).status).toBe(403);
    // Instance reads need admin: ada's rule grants it, bob is a viewer.
    for (const path of ['/api/users', '/api/instance', '/api/realms']) {
      expect((await read(app, path, bearer(ada))).status).toBe(200);
      expect((await read(app, path, bearer(bob))).status).toBe(403);
    }
  });
});

// ---- GitHub: the token GitHub grants, tied to the connected account -------------------------------

const BINDING = 'b'.repeat(43);
const GITHUB_ENV = (github: FakeForge) => ({ ...ENV, HOPPER_GITHUB_URL: github.url, HOPPER_GITHUB_CLIENT_ID: 'gh-app-client', HOPPER_GITHUB_APP_SLUG: 'hopper-test' });

async function withGitHub() {
  const github = await createFakeGitHub({ clientId: 'gh-app-client' });
  h.stops.push(() => github.close());
  const { app } = await startWithAuth(h, { version: 1, realms: [{ name: 'github', label: 'GitHub', type: 'github', roles: { defaultRole: 'viewer' } }] }, GITHUB_ENV(github));
  return { github, app };
}

/** The UI door: sign in with GitHub's device flow as `login`; the session, and the token GitHub granted. */
async function signInWithGitHub(app: TestApp, github: FakeForge, login: string): Promise<{ session: string; token: string }> {
  const started = await post(app, '/ui/auth/github/device', { binding: BINDING });
  expect(started.status).toBe(200);
  github.approve(login);
  const done = await waitFor(async () => {
    const r = await post(app, '/ui/auth/device/poll', { flow: started.body.flow, binding: BINDING });
    return r.body?.state === 'waiting' ? undefined : r;
  }, { what: `${login}'s sign-in` });
  expect(done.status).toBe(200);
  const token = [...github.tokens].filter(([, l]) => l === login).at(-1)![0];
  return { session: done.body.token, token };
}

/** A token GitHub granted `login`, without signing in to the hopper. */
const grant = (github: FakeForge, login: string, token = `gho_${login}`): string => { github.tokens.set(token, login); return token; };

const githubOf = (r: { body: { accounts: ConnectedAccountStatus[] } }) => r.body.accounts.find((a) => a.provider === 'github');

describe('the API door: a GitHub token', () => {
  it('reads /api/ as the user whose connected GitHub account it is, as that user\'s session does', async () => {
    const { github, app } = await withGitHub();
    const octo = await signInWithGitHub(app, github, 'octo-user');
    const second = await signInWithGitHub(app, github, 'second');
    const asOcto = await read(app, '/api/connected-accounts', bearer(octo.token));
    expect(asOcto.status).toBe(200);
    expect(githubOf(asOcto)).toMatchObject({ state: 'connected', account: 'octo-user' });
    expect(githubOf(await read(app, '/api/connected-accounts', bearer(second.token)))).toMatchObject({ account: 'second' });
    // Another token GitHub grants the same account (gh, a later sign-in) is the same user.
    expect(githubOf(await read(app, '/api/connected-accounts', bearer(grant(github, 'octo-user'))))).toMatchObject({ account: 'octo-user' });
    expect(githubOf(await read(app, '/api/connected-accounts', { 'x-hopper-session': octo.session }))).toMatchObject({ account: 'octo-user' });
  });

  it('a GitHub token not tied to a connected GitHub account is refused, and makes no user', async () => {
    const { github, app } = await withGitHub();
    const octo = await signInWithGitHub(app, github, 'octo-user');
    const users = app.app.instance.users.list().length;

    // An account that never signed in to this hopper.
    const stranger = await read(app, '/api/connected-accounts', bearer(grant(github, 'stranger')));
    expect(stranger.status).toBe(401);
    expect(stranger.body.error).toMatch(/connected GitHub account/);
    expect(app.app.instance.users.list()).toHaveLength(users);

    // A token GitHub does not know.
    const unknown = await read(app, '/api/connected-accounts', bearer('gho_revoked'));
    expect(unknown.status).toBe(401);

    // The user disconnected GitHub: the connection is forgotten (never reported through GitHub's credential
    // revocation, issue #597), so neither its token nor another GitHub still grants the account reads as them.
    const other = grant(github, 'octo-user');
    expect((await post(app, '/ui/api/connected-accounts', { action: 'disconnect', provider: 'github' }, { 'x-hopper-session': octo.session })).status).toBe(200);
    expect(github.revoked).toEqual([]);
    expect((await read(app, '/api/connected-accounts', bearer(octo.token))).status).toBe(401);
    const gone = await read(app, '/api/connected-accounts', bearer(other));
    expect(gone.status).toBe(401);
    expect(gone.body.error).toMatch(/connected GitHub account/);
  });
});
