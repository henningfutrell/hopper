// Identity keyed by email (issue #1380, design.md "Identity keyed by email"): a user keeps the verified email it is known
// by, and a sign-in whose realm vouches for that email signs in as that user, from any realm. So a person who signed in
// with GitHub moves to a local account or single sign-on of the same email and keeps their user: their work, and their
// GitHub connection as a source. An admin never adds a local account for the email of another user. The daemon, store,
// CLI and HTTP edge are real; GitHub and the OIDC issuer are fakes on loopback.
//
// Feature: a GitHub-signed-in user becomes a hopper user with GitHub attached as a source
//   Scenario: the operator adds a local account of the user's email
//     Given octo-user signed in with GitHub, its verified email octo-user@example.com
//     When the operator adds the local account octo-user@example.com and it signs in
//     Then the session is octo-user's user, and its GitHub account reads as connected
// Feature: single sign-on keyed by email
//   Scenario: a second identity of a verified email signs in as the same user
//   Scenario: an unverified email is not trusted to name a user
//   Scenario: an admin is refused a local account for another user's email
import { afterEach, describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../../src/cli.ts';
import type { ConnectedAccountStatus } from '../../src/domain/types.ts';
import type { TestApp } from '../support/app.ts';
import { databaseUrlFor } from '../support/database.ts';
import { createFakeGitHub, type FakeForge } from '../support/fake-forges.ts';
import { rawRequest } from '../support/http.ts';
import { signIn as oidcSignIn } from '../support/idp.ts';
import { harness, oidcIdp, oidcRealm, session, startNewHopper, startWithAuth, stopAll } from '../support/sign-in-app.ts';
import { waitFor } from '../support/wait.ts';

const h = harness();
afterEach(() => stopAll(h));

const PASSWORD = 'correct horse battery staple';
const BINDING = 'b'.repeat(43);
const ENV = (github: FakeForge) => ({ HOPPER_GITHUB_URL: github.url, HOPPER_GITHUB_CLIENT_ID: 'gh-app-client', HOPPER_GITHUB_APP_SLUG: 'hopper-test' });

async function cli(app: TestApp, argv: string[], stdin = '') {
  const err: string[] = [];
  const io: CliIo = { env: { HOPPER_DATABASE_URL: databaseUrlFor(app.dbPath) }, stdin: () => stdin, out: () => {}, err: (t) => err.push(t) };
  return { code: await runCli(argv, io), err: err.join('') };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read loose JSON
const post = async (url: string, origin: string, path: string, body: unknown, token?: string): Promise<{ status: number; body: any }> => {
  const r = await rawRequest(url, { method: 'POST', path, body: JSON.stringify(body), headers: { 'content-type': 'application/json', origin, ...(token ? { 'x-hopper-session': token } : {}) } });
  return { status: r.status, body: r.text ? JSON.parse(r.text) : undefined };
};

const passwordSignIn = async (app: TestApp, origin: string, username: string): Promise<string> => {
  const r = await post(app.url, origin, '/ui/auth/password', { username, password: PASSWORD });
  expect(r.status).toBe(200);
  return r.body.token as string;
};

async function githubSignIn(url: string, origin: string, github: FakeForge, login: string): Promise<{ token: string; userId: string }> {
  const started = await post(url, origin, '/ui/auth/github/device', { binding: BINDING });
  expect(started.status).toBe(200);
  github.approve(login);
  const done = await waitFor(async () => {
    const r = await post(url, origin, '/ui/auth/device/poll', { flow: started.body.flow, binding: BINDING });
    return r.body?.state === 'waiting' ? undefined : r;
  }, { what: `${login}'s sign-in to end` });
  expect(done.body).toMatchObject({ state: 'signed-in' });
  return { token: done.body.token, userId: done.body.user.id };
}

describe('a GitHub-signed-in user becomes a hopper user with GitHub as a source (issue #1380)', () => {
  it('a local account of the user\'s verified email signs in as that user, and its GitHub connection stays', async () => {
    const github = await createFakeGitHub({ clientId: 'gh-app-client' });
    h.stops.push(() => github.close());
    const { app, origin } = await startWithAuth(h, undefined, ENV(github));
    const gh = await githubSignIn(app.url, origin, github, 'octo-user');
    expect(app.app.instance.users.get(gh.userId)?.email).toBe('octo-user@example.com');
    const before = app.app.instance.users.list().length;

    expect((await cli(app, ['local-account', 'add', 'Octo-User@example.com'], `${PASSWORD}\n`)).code).toBe(0);
    const local = await passwordSignIn(app, origin, 'octo-user@example.com');
    expect(await session(app, local)).toMatchObject({ authenticated: true, user: { id: gh.userId, realm: 'local-accounts' } });

    const accounts = (await app.api<{ accounts: ConnectedAccountStatus[] }>('GET', '/api/connected-accounts', undefined, { 'x-hopper-session': local })).body.accounts;
    expect(accounts.find((a) => a.provider === 'github')).toMatchObject({ state: 'connected', account: 'octo-user' });
    expect(app.app.instance.users.list()).toHaveLength(before);
  }, 60_000); // a daemon, a CLI and two sign-ins: 8 s on a loaded CI shard
});

describe('single sign-on keyed by email (issue #1380)', () => {
  it('a second identity of a verified email is the same user; an unverified one is not; an admin may not add a local account for it', async () => {
    const idp = await oidcIdp(h, { claims: { sub: 'sub-ada', preferred_username: 'ada', email: 'ada@example.com', email_verified: true }, userinfo: { sub: 'sub-ada' } });
    const { app, origin } = await startNewHopper(h, { version: 1, realms: [oidcRealm(idp, { defaultRole: 'operator' })] });
    expect((await cli(app, ['local-account', 'add', 'boss@example.com'], `${PASSWORD}\n`)).code).toBe(0);
    const boss = await passwordSignIn(app, origin, 'boss@example.com');
    expect((await session(app, boss)).user).toMatchObject({ instanceAdmin: true });

    const ada = (await session(app, (await oidcSignIn(app.url, origin, 'corp')).token!)).user.id as string;
    expect(app.app.instance.users.get(ada)?.email).toBe('ada@example.com');

    // The identity provider gives Ada a new subject: the verified email names her user.
    Object.assign(idp.claims, { sub: 'sub-ada-2' });
    Object.assign(idp.userinfo, { sub: 'sub-ada-2' });
    expect((await session(app, (await oidcSignIn(app.url, origin, 'corp')).token!)).user.id).toBe(ada);

    // An email the provider does not vouch for names no user: a user of its own.
    Object.assign(idp.claims, { sub: 'sub-eve', preferred_username: 'eve', email_verified: false });
    Object.assign(idp.userinfo, { sub: 'sub-eve' });
    expect((await session(app, (await oidcSignIn(app.url, origin, 'corp')).token!)).user.id).not.toBe(ada);

    // An admin runs the hopper, never another user's work: no local account of Ada's email from the UI.
    const refused = await app.ui<{ error?: string }>('/ui/api/local-accounts', { action: 'save', email: 'ada@example.com', role: 'operator', password: PASSWORD }, { token: boss });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/signs in as another user/);
    expect(app.app.instance.localAccounts.get('ada@example.com')).toBeUndefined();

    // The users list names each user's email, for the admin to see who is who.
    const users = (await app.api<{ users: { id: string; email?: string }[] }>('GET', '/api/users', undefined, { 'x-hopper-session': boss })).body.users;
    expect(users.find((u) => u.id === ada)).toMatchObject({ email: 'ada@example.com' });
  }, 60_000); // three sign-ins, a CLI and a daemon: timed out at 15 s on a loaded CI shard
});
