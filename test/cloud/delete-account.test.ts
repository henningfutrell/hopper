// Deleting a hopper.io account (issue #463, docs/cloud-hosting-identity.md decision 5). The person confirms with a fresh
// GitHub sign-in through the hosted app: it proves they hold the GitHub account now, and it gives the one token GitHub's
// grant deletion needs, as hopper.io keeps none. The account and all its sessions go in one step; then the grant goes at
// GitHub, so the consent goes too. Sign-out is not deletion: sign-in.test.ts shows it ends the session only.
//
// Feature: a person deletes their hopper.io account
//   Scenario: deleted after a fresh GitHub sign-in as the same account
//     Then the account and every session of it are gone, and another account stays
//     And GitHub's grant of the hosted app is deleted with that sign-in's token, and no token is kept
//   Scenario: only from hopper.io itself, and only signed in
//   Scenario: confirmed as another GitHub account: nothing is deleted, and no account is made
//   Scenario: denied at GitHub: nothing is deleted
//   Scenario: GitHub refuses the grant deletion: the account is gone, and the page says how to remove the app at GitHub
import { afterEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../../cloud/server.ts';
import { PUBLIC, SECRET, account, rawUser, rows, setCookies, setUp, signIn, stopAll, viaGitHub, type Set } from './harness.ts';

afterEach(stopAll);

const form = { 'content-type': 'application/x-www-form-urlencoded' };
const startDeletion = (s: Set, session: string | undefined, origin = PUBLIC) =>
  s.server.inject({ method: 'POST', url: '/account/delete', headers: { ...form, origin, ...(session ? { cookie: `${SESSION_COOKIE}=${session}` } : {}) }, payload: '' });
const grantDeletions = (s: Set) => s.github.requests.filter((r) => r.method === 'DELETE' && r.path === '/api/v3/applications/hosted-app/grant');

describe('delete a hopper.io account', () => {
  it('after a fresh GitHub sign-in as the same account: the account, its sessions and its GitHub grant go', async () => {
    const s = await setUp();
    s.github.webLogin = 'ada';
    const first = await signIn(s);
    const second = await signIn(s);
    s.github.webLogin = 'grace';
    const other = await signIn(s);

    s.github.webLogin = 'ada';
    const start = await startDeletion(s, first.session);
    expect(start.statusCode).toBe(302);
    expect(String(start.headers.location)).toContain(`${s.github.url}/login/oauth/authorize`);
    const done = await viaGitHub(s, start, `${SESSION_COOKIE}=${first.session}; `);
    expect(done.callback.statusCode).toBe(200);
    expect(done.callback.body).toContain('deleted');
    expect(setCookies(done.callback.headers['set-cookie']).get(SESSION_COOKIE)).toBe('');

    expect((await account(s, first.session)).statusCode).toBe(401);
    expect((await account(s, second.session)).statusCode).toBe(401);
    expect(await s.store.account(String((await rawUser(s, 'ada')).id))).toBeUndefined();
    expect((await account(s, other.session)).json()).toMatchObject({ login: 'grace' });

    const [grant] = grantDeletions(s);
    expect(grant?.auth).toBe(`basic ${Buffer.from(`hosted-app:${SECRET}`).toString('base64')}`);
    expect(String(grant?.body.access_token)).toMatch(/^gho_ada_/);
    expect([...s.github.tokens.values()].filter((l) => l === 'ada')).toEqual(['ada']); // only rawUser's own mint, after
    const kept = await rows(s.databaseUrl);
    expect(kept).not.toContain('gho_');
    expect(kept).not.toContain('"ada"');
  });

  it('only from hopper.io itself, and only signed in', async () => {
    const s = await setUp();
    s.github.webLogin = 'ada';
    const run = await signIn(s);
    expect((await startDeletion(s, run.session, 'https://evil.example')).statusCode).toBe(403);
    expect((await startDeletion(s, undefined)).statusCode).toBe(401);
    expect((await account(s, run.session)).statusCode).toBe(200);
  });

  it('confirmed as another GitHub account: nothing is deleted, and no account is made', async () => {
    const s = await setUp();
    s.github.webLogin = 'ada';
    const run = await signIn(s);
    s.github.webLogin = 'grace';
    const done = await viaGitHub(s, await startDeletion(s, run.session), `${SESSION_COOKIE}=${run.session}; `);
    expect(done.callback.statusCode).toBe(403);
    expect((await account(s, run.session)).json()).toMatchObject({ login: 'ada' });
    expect(JSON.parse(await rows(s.databaseUrl))[0]).toHaveLength(1);
    expect(grantDeletions(s)).toEqual([]);
  });

  it('denied at GitHub: nothing is deleted', async () => {
    const s = await setUp();
    s.github.webLogin = 'ada';
    const run = await signIn(s);
    s.github.webLogin = undefined;
    const done = await viaGitHub(s, await startDeletion(s, run.session), `${SESSION_COOKIE}=${run.session}; `);
    expect(done.callback.statusCode).toBe(502);
    expect((await account(s, run.session)).statusCode).toBe(200);
    expect(grantDeletions(s)).toEqual([]);
  });

  it('GitHub refuses the grant deletion: the account is gone, and the page says how to remove the app at GitHub', async () => {
    const s = await setUp();
    s.github.webLogin = 'ada';
    const run = await signIn(s);
    s.github.revokeDown = 503;
    const done = await viaGitHub(s, await startDeletion(s, run.session), `${SESSION_COOKIE}=${run.session}; `);
    expect(done.callback.statusCode).toBe(200);
    expect(done.callback.body).toContain('https://github.com/settings/apps/authorizations');
    expect((await account(s, run.session)).statusCode).toBe(401);
    expect(grantDeletions(s)).toHaveLength(1);
  });
});
