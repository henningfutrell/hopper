// When the GitHub connection of someone signed in with GitHub ends, their hopper sessions end with it (issue
// #513): the connection is what they signed in for, so the UI goes to sign-in rather than staying half-working
// with a reconnect banner. Signing in with GitHub again makes a session and a live connection in one step. The
// daemon, store and HTTP edge are real; GitHub is a fake on loopback (test/support/fake-forges.ts).
//
// Feature: a GitHub sign-in ends with its connection
//   Scenario: the connection ends, and every GitHub session of that user with it
//     Given octo-user signed in with GitHub in two browsers
//     When GitHub refuses the connection's token and it has nothing to renew it with
//     Then neither browser's session lives: the session read says to sign in
//     And ui_session.ended { reason: connection-ended, realm: github } is recorded for each
//   Scenario: signing in with GitHub again restores both
//     Then the new session lives and the GitHub account reads as connected
//   Scenario: a connection that lives drops no session
//     When the token is renewed
//     Then the session still lives
import { afterEach, describe, expect, it } from 'vitest';
import type { ConnectedAccountStatus } from '../../src/domain/types.ts';
import { createFakeGitHub, type FakeForge } from '../support/fake-forges.ts';
import { rawRequest } from '../support/http.ts';
import { harness, session, startWithAuth, stopAll } from '../support/sign-in-app.ts';
import { waitFor } from '../support/wait.ts';

const h = harness();
afterEach(() => stopAll(h));

const BINDING = 'b'.repeat(43);
const ENV = (github: FakeForge) => ({ HOPPER_GITHUB_URL: github.url, HOPPER_GITHUB_CLIENT_ID: 'gh-app-client', HOPPER_GITHUB_APP_SLUG: 'hopper-test' });

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read loose JSON
const post = async (url: string, origin: string, path: string, body: unknown): Promise<{ status: number; body: any }> => {
  const r = await rawRequest(url, { method: 'POST', path, body: JSON.stringify(body), headers: { 'content-type': 'application/json', origin } });
  return { status: r.status, body: r.text ? JSON.parse(r.text) : undefined };
};

/** Sign in with GitHub as `login`: the session's token and user id. */
async function signInAs(url: string, origin: string, github: FakeForge, login: string): Promise<{ token: string; userId: string }> {
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

async function forge(tokenLifetimeS?: number): Promise<FakeForge> {
  const github = await createFakeGitHub({ clientId: 'gh-app-client', ...(tokenLifetimeS ? { tokenLifetimeS } : {}) });
  h.stops.push(() => github.close());
  return github;
}

/** GitHub takes back everything it granted `login`: its tokens and refresh tokens. */
function revoke(github: FakeForge, login: string): void {
  for (const [t, who] of github.tokens) if (who === login) github.tokens.delete(t);
  for (const [r, g] of github.refreshTokens) if (g.login === login) github.refreshTokens.delete(r);
}

describe('a GitHub sign-in ends with its GitHub connection', () => {
  it('the connection ends: every GitHub session of that user ends, told as connection-ended; signing in again restores both', async () => {
    const github = await forge(8 * 3600);
    const { app, origin } = await startWithAuth(h, undefined, ENV(github));
    const first = await signInAs(app.url, origin, github, 'octo-user');
    const second = await signInAs(app.url, origin, github, 'octo-user');
    expect(second.userId).toBe(first.userId);
    expect((await session(app, first.token)).authenticated).toBe(true);

    // GitHub refuses the token and its refresh token: the connection ends.
    const token = await app.user(first.userId).connectedAccounts.token('github');
    revoke(github, 'octo-user');
    await expect(app.user(first.userId).connectedAccounts.renew('github', token)).rejects.toThrow(/sign-in expired/);

    expect((await session(app, first.token)).authenticated).toBe(false);
    expect((await session(app, second.token)).authenticated).toBe(false);
    // A change with an ended session is refused: the UI goes to sign-in.
    const refused = await rawRequest(app.url, {
      method: 'POST', path: '/ui/api/connected-accounts', body: JSON.stringify({ action: 'connect', provider: 'github' }),
      headers: { 'content-type': 'application/json', origin, 'x-hopper-session': first.token },
    });
    expect(refused.status).toBe(403);
    expect(app.user(first.userId).store.events.recent(10, ['ui_session.ended']).map((e) => e.data)).toEqual([{ reason: 'connection-ended', realm: 'github' }, { reason: 'connection-ended', realm: 'github' }]);

    // Signing in with GitHub again: a new session and a live connection, in one step.
    const again = await signInAs(app.url, origin, github, 'octo-user');
    expect(again.userId).toBe(first.userId);
    expect((await session(app, again.token)).authenticated).toBe(true);
    const accounts = (await app.api<{ accounts: ConnectedAccountStatus[] }>('GET', '/api/connected-accounts', undefined, { 'x-hopper-session': again.token })).body.accounts;
    expect(accounts.find((a) => a.provider === 'github')).toMatchObject({ state: 'connected', account: 'octo-user' });
  });

  it('a connection that lives drops no session: a renewal keeps it', async () => {
    const github = await forge(8 * 3600);
    const { app, origin } = await startWithAuth(h, undefined, ENV(github));
    const me = await signInAs(app.url, origin, github, 'octo-user');
    const token = await app.user(me.userId).connectedAccounts.token('github');
    github.tokens.delete(token);
    // GitHub refuses the token (a 401); the refresh token still works: renewed, not ended.
    await expect(app.user(me.userId).connectedAccounts.renew('github', token)).resolves.toEqual(expect.any(String));
    expect((await session(app, me.token)).authenticated).toBe(true);
    expect(app.user(me.userId).store.events.recent(10, ['ui_session.ended'])).toEqual([]);
  });
});
