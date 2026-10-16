// The hopper owns its users (issue #1380): a GitHub connection is a source the user attached, not their sign-in. When it
// ends, only the source is marked as needing re-auth; the person stays signed in, signed in with GitHub or not (this
// replaces issue #513, which ended their sessions). They connect GitHub again from Sources. The daemon, store and HTTP
// edge are real; GitHub is a fake on loopback (test/support/fake-forges.ts).
//
// Feature: a source that expires does not sign the user out
//   Scenario: the connection ends, and the sessions stay
//     Given octo-user signed in with GitHub in two browsers
//     When GitHub refuses the connection's token and it has nothing to renew it with
//     Then both sessions still live, and no ui_session.ended is recorded
//     And the GitHub account reads as expired: reconnect needed
//   Scenario: connecting GitHub again from Sources restores the source
//     When the user connects GitHub again with the device code, from the same session
//     Then the GitHub account reads as connected
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
const post = async (url: string, origin: string, path: string, body: unknown, token?: string): Promise<{ status: number; body: any }> => {
  const r = await rawRequest(url, { method: 'POST', path, body: JSON.stringify(body), headers: { 'content-type': 'application/json', origin, ...(token ? { 'x-hopper-session': token } : {}) } });
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

describe('a source that expires marks only the source (issue #1380)', () => {
  it('the connection ends: every session stays, the source reads reconnect needed; connecting again from Sources restores it', async () => {
    const github = await forge(8 * 3600);
    const { app, origin } = await startWithAuth(h, undefined, ENV(github));
    const first = await signInAs(app.url, origin, github, 'octo-user');
    const second = await signInAs(app.url, origin, github, 'octo-user');
    expect(second.userId).toBe(first.userId);

    // GitHub refuses the token and its refresh token: the connection ends.
    const token = await app.user(first.userId).connectedAccounts.token('github');
    revoke(github, 'octo-user');
    await expect(app.user(first.userId).connectedAccounts.renew('github', token)).rejects.toThrow(/sign-in expired/);

    expect((await session(app, first.token)).authenticated).toBe(true);
    expect((await session(app, second.token)).authenticated).toBe(true);
    expect(app.user(first.userId).store.events.recent(10, ['ui_session.ended'])).toEqual([]);
    const read = async () => (await app.api<{ accounts: ConnectedAccountStatus[] }>('GET', '/api/connected-accounts', undefined, { 'x-hopper-session': first.token })).body.accounts.find((a) => a.provider === 'github');
    expect(await read()).toMatchObject({ state: 'expired', account: 'octo-user' });

    // Connect GitHub again from Sources, in the same session: the source is connected again.
    const connect = await post(app.url, origin, '/ui/api/connected-accounts', { action: 'connect', provider: 'github' }, first.token);
    expect(connect.status).toBe(200);
    github.approve('octo-user');
    await waitFor(async () => (await read())?.state === 'connected', { what: 'github connected again' });
    expect(await read()).toMatchObject({ state: 'connected', account: 'octo-user' });
    expect((await session(app, first.token)).authenticated).toBe(true);
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
