// Signing in with GitHub by a browser redirect when the hopper can (issue #258), the device code when it
// cannot. GitHub's web flow for a GitHub App takes the app's client secret, which the hopper never ships:
// the runtime gives it (HOPPER_GITHUB_CLIENT_SECRET, or the file HOPPER_GITHUB_CLIENT_SECRET_FILE names).
// With it, the browser on the sign-in origin goes to GitHub and comes back signed in — authorization
// code with PKCE, the state the flow's id, the binding the same as the other redirect realms. Without it,
// the device code stays the way in. The daemon, store and HTTP edge are real; GitHub is a fake on loopback.
//
// Feature: sign in with GitHub in the browser
//   Scenario: the runtime gives the app's client secret
//     Then the sign-in page offers GitHub by redirect
//     When the browser starts the sign-in on the sign-in origin
//     Then it goes to GitHub with the client id, the callback, a state and a PKCE challenge
//     When octo-user approves it at GitHub
//     Then the callback signs the browser in as the first GitHub admin, and their GitHub is connected
//     And the code was exchanged with the secret and the PKCE verifier
//     And the secret is in no answer
//   Scenario: no client secret: the device code, and no redirect
//   Scenario: the person denies it at GitHub: no session
//   Scenario: another browser cannot finish the sign-in (the binding)
import { afterEach, describe, expect, it } from 'vitest';
import type { ConnectedAccountStatus } from '../../src/domain/types.ts';
import { createFakeGitHub, type FakeForge } from '../support/fake-forges.ts';
import { rawRequest } from '../support/http.ts';
import { signIn } from '../support/idp.ts';
import { harness, session, startWithAuth, stopAll } from '../support/sign-in-app.ts';

const h = harness();
afterEach(() => stopAll(h));

const SECRET = 'gh-app-secret-for-tests';

async function forge(): Promise<FakeForge> {
  const github = await createFakeGitHub({ clientId: 'gh-app-client', clientSecret: SECRET });
  h.stops.push(() => github.close());
  return github;
}

const ENV = (github: FakeForge) => ({ HOPPER_GITHUB_URL: github.url, HOPPER_GITHUB_CLIENT_ID: 'gh-app-client' });
const start = (github: FakeForge, secret: boolean) => startWithAuth(h, undefined, ENV(github), secret ? { HOPPER_GITHUB_CLIENT_SECRET: SECRET } : {});

describe('sign in with GitHub by a browser redirect', () => {
  it('with the client secret: to GitHub and back, signed in as the first GitHub admin, the account connected', async () => {
    const github = await forge();
    github.webLogin = 'octo-user';
    const { app, origin } = await start(github, true);
    const offer = await session(app);
    expect(offer.signIn.devices).toEqual([{ name: 'github', label: 'GitHub', type: 'github', redirect: true }]);
    expect(JSON.stringify(offer)).not.toContain(SECRET);

    const run = await signIn(app.url, origin, 'github');
    expect(run.start.status).toBe(302);
    const to = new URL(String(run.start.headers.location));
    expect(`${to.origin}${to.pathname}`).toBe(`${github.url}/login/oauth/authorize`);
    expect(Object.fromEntries(to.searchParams)).toMatchObject({
      client_id: 'gh-app-client', redirect_uri: `${origin}/ui/auth/github/callback`, state: expect.any(String),
      code_challenge: expect.any(String), code_challenge_method: 'S256',
    });
    expect(to.searchParams.has('client_secret')).toBe(false);
    expect(run.callback?.status).toBe(200);
    expect(run.complete?.status).toBe(200);
    expect(await session(app, run.token)).toMatchObject({ user: { role: 'admin', realm: 'github', name: 'octo-user' } });

    const exchanged = github.requests.find((r) => r.path === '/login/oauth/access_token')!;
    expect(exchanged.body).toMatchObject({ client_id: 'gh-app-client', client_secret: SECRET, code_verifier: expect.any(String) });
    const accounts = (await app.api<{ accounts: ConnectedAccountStatus[] }>('GET', '/api/connected-accounts', undefined, { 'x-hopper-session': run.token! })).body.accounts;
    expect(accounts.find((a) => a.provider === 'github')).toMatchObject({ state: 'connected', account: 'octo-user' });
    expect(JSON.stringify(accounts)).not.toContain(SECRET);
  });

  it('no client secret: no redirect; the device code stays the way in', async () => {
    const github = await forge();
    const { app, origin } = await start(github, false);
    expect((await session(app)).signIn.devices).toEqual([{ name: 'github', label: 'GitHub', type: 'github' }]);
    const run = await signIn(app.url, origin, 'github');
    expect(run.start.status).toBe(404);
    expect(github.requests.some((r) => r.path === '/login/oauth/authorize')).toBe(false);
    const device = await rawRequest(app.url, { method: 'POST', path: '/ui/auth/github/device', body: JSON.stringify({ binding: 'b'.repeat(43) }), headers: { 'content-type': 'application/json', origin } });
    expect(device.status).toBe(200);
  });

  it('denied at GitHub: no session', async () => {
    const github = await forge();
    const { app, origin } = await start(github, true);
    const before = app.app.instance.users.list().length;
    const run = await signIn(app.url, origin, 'github');
    expect(run.callback?.status).toBe(502);
    expect(run.token).toBeUndefined();
    expect(app.app.instance.users.list()).toHaveLength(before);
  });

  it('another browser cannot finish the sign-in', async () => {
    const github = await forge();
    github.webLogin = 'octo-user';
    const { app, origin } = await start(github, true);
    const run = await signIn(app.url, origin, 'github', { completeBinding: 'c'.repeat(43) });
    expect(run.callback?.status).toBe(200);
    expect(run.complete?.status).toBe(403);
    expect(run.token).toBeUndefined();
  });
});
