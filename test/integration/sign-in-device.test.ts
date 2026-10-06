// Users sign in with GitHub, and that connection is what jobs work through (issue #214): GitHub's
// device flow through the hopper's GitHub App, with its public client id and no secret. The person
// enters the code at GitHub; the browser that began the sign-in gets the session, and the session's
// user gets the GitHub connection their job source reads through. Every hopper offers it, a fresh one
// too, and the first person to sign in with GitHub becomes admin (issue #239). The daemon, store and
// HTTP edge are real; GitHub is a fake on loopback (test/support/fake-forges.ts).
//
// Feature: sign in with GitHub
//   Scenario: a fresh hopper offers GitHub sign-in, and the first person to use it becomes admin
//     Given a fresh hopper (no sign-in set up)
//     Then the sign-in page offers "Sign in with GitHub"
//     When the browser starts the sign-in
//     Then it shows the device code, asked for with the app's client id alone
//     When octo-user approves the code at GitHub
//     Then the browser's next poll is a session as the user octo-user, with role admin
//     And that user's GitHub is connected as octo-user
//     And the next person gets what the role rules grant: none, so no session
//   Scenario: the first GitHub admin stays admin after a restart
//   Scenario: a hopper where someone signed in with GitHub before makes nobody admin
//   Scenario: role rules grant a role
//   Scenario: another browser cannot take the sign-in (the binding); another site cannot start one
import { afterEach, describe, expect, it } from 'vitest';
import type { ConnectedAccountStatus } from '../../src/domain/types.ts';
import { createFakeGitHub, type FakeForge } from '../support/fake-forges.ts';
import { rawRequest } from '../support/http.ts';
import { harness, restartSame, restartWithAuth, session, startWithAuth, stopAll } from '../support/sign-in-app.ts';
import { waitFor } from '../support/wait.ts';

const h = harness();
afterEach(() => stopAll(h));

const BINDING = 'b'.repeat(43);

async function forge(): Promise<FakeForge> {
  const github = await createFakeGitHub({ clientId: 'gh-app-client' });
  h.stops.push(() => github.close());
  return github;
}

const ENV = (github: FakeForge) => ({ HOPPER_GITHUB_URL: github.url, HOPPER_GITHUB_CLIENT_ID: 'gh-app-client', HOPPER_GITHUB_APP_SLUG: 'hopper-test' });
const withRoles = (roles: unknown) => ({ version: 1, realms: [{ name: 'github', label: 'GitHub', type: 'github', roles }] });

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read loose JSON
const post = async (url: string, origin: string, path: string, body: unknown): Promise<{ status: number; body: any }> => {
  const r = await rawRequest(url, { method: 'POST', path, body: JSON.stringify(body), headers: { 'content-type': 'application/json', origin } });
  return { status: r.status, body: r.text ? JSON.parse(r.text) : undefined };
};

/** Start a GitHub sign-in, approve it at GitHub as `login`, and answer the poll that ends it. */
async function signInAs(url: string, origin: string, github: FakeForge, login: string) {
  const started = await post(url, origin, '/ui/auth/github/device', { binding: BINDING });
  expect(started.status).toBe(200);
  github.approve(login);
  return waitFor(async () => {
    const r = await post(url, origin, '/ui/auth/device/poll', { flow: started.body.flow, binding: BINDING });
    return r.body?.state === 'waiting' ? undefined : r;
  }, { what: `${login}'s sign-in to end` });
}

const originOf = (app: { url: string }): string => `http://localhost:${new URL(app.url).port}`;

describe('sign in with GitHub through the hopper\'s GitHub App', () => {
  it('a fresh hopper offers it; the code, then a session as the first GitHub admin, and the user\'s GitHub connected', async () => {
    const github = await forge();
    const { app, origin } = await startWithAuth(h, undefined, ENV(github));
    expect((await session(app)).signIn.devices).toEqual([{ name: 'github', label: 'GitHub', type: 'github' }]);
    // Settings → Sign-in (issue #256): nobody is the GitHub admin yet.
    expect((await app.api<{ githubAdmin: unknown }>('GET', '/api/realms')).body.githubAdmin).toBeNull();

    const started = await post(app.url, origin, '/ui/auth/github/device', { binding: BINDING });
    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({ userCode: 'GH1-CODE', verificationUri: `${github.url}/login/device`, flow: expect.any(String) });
    const asked = github.requests.find((r) => r.path === '/login/device/code')!;
    expect(asked.body).toMatchObject({ client_id: 'gh-app-client' });
    expect(asked.body).not.toHaveProperty('client_secret');

    expect((await post(app.url, origin, '/ui/auth/device/poll', { flow: started.body.flow, binding: BINDING })).body).toEqual({ state: 'waiting' });
    github.approve('octo-user');
    const done = await waitFor(async () => {
      const r = await post(app.url, origin, '/ui/auth/device/poll', { flow: started.body.flow, binding: BINDING });
      return r.body.state === 'waiting' ? undefined : r;
    }, { what: 'the sign-in to finish' });
    expect(done.status).toBe(200);
    // The first person to sign in with GitHub is admin, though no rule names them (issue #239).
    expect(done.body).toMatchObject({ state: 'signed-in', token: expect.any(String), user: { role: 'admin', realm: 'github', name: 'octo-user' } });
    expect(app.app.auth().githubAdmin).toMatchObject({ realm: 'github' });
    // Settings → Sign-in names who that is: the user they signed in as (issue #256).
    expect((await app.api<{ githubAdmin: unknown }>('GET', '/api/realms', undefined, { 'x-hopper-session': done.body.token })).body.githubAdmin)
      .toEqual({ realm: 'github', user: 'octo-user' });

    // The same connection is the user's GitHub: their job source reads through it.
    const accounts = (await app.api<{ accounts: ConnectedAccountStatus[] }>('GET', '/api/connected-accounts', undefined, { 'x-hopper-session': done.body.token })).body.accounts;
    expect(accounts.find((a) => a.provider === 'github')).toMatchObject({ state: 'connected', account: 'octo-user', via: 'the hopper\'s app' });
    // A finished flow is gone: polling it again signs nobody in.
    expect((await post(app.url, origin, '/ui/auth/device/poll', { flow: started.body.flow, binding: BINDING })).status).toBe(403);

    // The next person gets what the rules grant: none here, so no session, and nothing connected.
    const next = await signInAs(app.url, origin, github, 'second');
    expect(next.status).toBe(403);
    expect(next.body.error).toMatch(/grants this account no role/);
    expect(app.app.instance.users.list().map((u) => u.name)).not.toContain('second');
  });

  it('the first GitHub admin stays admin after a restart; the rules grant the rest', async () => {
    const github = await forge();
    const { app, origin } = await startWithAuth(h, withRoles({ defaultRole: 'viewer' }), ENV(github));
    expect((await signInAs(app.url, origin, github, 'octo-user')).body.user.role).toBe('admin');
    expect((await signInAs(app.url, origin, github, 'second')).body.user.role).toBe('viewer');
    const again = await restartSame(h, app, ENV(github));
    expect((await signInAs(again.url, originOf(again), github, 'octo-user')).body.user.role).toBe('admin');
  });

  it('a hopper where someone signed in with GitHub before makes nobody admin', async () => {
    const github = await forge();
    const auth = withRoles({ defaultRole: 'viewer' });
    const { app, origin } = await startWithAuth(h, auth, ENV(github));
    await signInAs(app.url, origin, github, 'octo-user');
    // As a hopper from before the rule: the GitHub sign-in is linked, no first GitHub admin recorded.
    const again = await restartWithAuth(h, app, auth, ENV(github));
    expect((await signInAs(again.url, originOf(again), github, 'second')).body.user.role).toBe('viewer');
    expect(again.app.auth().githubAdmin).toBeNull();
  });

  it('role rules grant a role by GitHub username', async () => {
    const github = await forge();
    const { app, origin } = await startWithAuth(h, withRoles({ operator: { usernames: ['second'] } }), ENV(github));
    await signInAs(app.url, origin, github, 'octo-user');
    expect((await signInAs(app.url, origin, github, 'second')).body.user).toMatchObject({ role: 'operator', name: 'second' });
  });

  it('another browser cannot take the sign-in; a page from another site cannot start one', async () => {
    const github = await forge();
    const { app, origin } = await startWithAuth(h, undefined, ENV(github));
    expect((await post(app.url, 'https://evil.example', '/ui/auth/github/device', { binding: BINDING })).status).toBe(403);
    const started = await post(app.url, origin, '/ui/auth/github/device', { binding: BINDING });
    github.approve('octo-user');
    await new Promise((r) => setTimeout(r, 1500));
    expect((await post(app.url, origin, '/ui/auth/device/poll', { flow: started.body.flow, binding: 'c'.repeat(43) })).status).toBe(403);
  });
});
