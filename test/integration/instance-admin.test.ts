// No special admin login (issue #240, docs/sign-in.md "The instance admin"): the hopper's admin is the
// first person to sign in with GitHub (issue #239) — on a hopper with no first GitHub admin recorded,
// the oldest user — and only their sessions do what the hopper does for everyone (issue #241): sign-in
// realms, adding users and their login links, updates, the plugin store, the users and the totals across
// them. A login code is no admin login: a new user's login link signs in as that user, who sets up their
// own environment but never the instance's; a device link signs in as the session's own user, never more.
// The daemon, store and HTTP edge are real; GitHub is a fake on loopback (test/support/fake-forges.ts).
import { afterEach, describe, expect, it } from 'vitest';
import type { TestApp } from '../support/app.ts';
import { createFakeGitHub, type FakeForge } from '../support/fake-forges.ts';
import { rawRequest } from '../support/http.ts';
import { harness, session, startNewHopper, startWithAuth, stopAll } from '../support/sign-in-app.ts';
import { waitFor } from '../support/wait.ts';

const h = harness();
afterEach(() => stopAll(h));

const BINDING = 'b'.repeat(43);
const LAN = { HOPPER_LAN_NAMES: 'server', HOPPER_LAN_PEERS: '192.0.2.0/24' };
const ENV = (github: FakeForge) => ({ HOPPER_GITHUB_URL: github.url, HOPPER_GITHUB_CLIENT_ID: 'gh-app-client', HOPPER_GITHUB_APP_SLUG: 'hopper-test', ...LAN });
const withRoles = (roles: unknown) => ({ version: 1, realms: [{ name: 'github', label: 'GitHub', type: 'github', roles }] });

async function forge(): Promise<FakeForge> {
  const github = await createFakeGitHub({ clientId: 'gh-app-client' });
  h.stops.push(() => github.close());
  return github;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read loose JSON
const post = async (url: string, origin: string, path: string, body: unknown): Promise<{ status: number; body: any }> => {
  const r = await rawRequest(url, { method: 'POST', path, body: JSON.stringify(body), headers: { 'content-type': 'application/json', origin } });
  return { status: r.status, body: r.text ? JSON.parse(r.text) : undefined };
};

/** Sign in with GitHub as `login`; the session token. */
async function signInAs(url: string, origin: string, github: FakeForge, login: string): Promise<string> {
  const started = await post(url, origin, '/ui/auth/github/device', { binding: BINDING });
  expect(started.status).toBe(200);
  github.approve(login);
  const done = await waitFor(async () => {
    const r = await post(url, origin, '/ui/auth/device/poll', { flow: started.body.flow, binding: BINDING });
    return r.body?.state === 'waiting' ? undefined : r;
  }, { what: `${login}'s sign-in to end` });
  expect(done.status).toBe(200);
  return done.body.token as string;
}

const codeOf = (link: string): string => /#login=([0-9a-f]{64})$/.exec(link)![1]!;

/** Every instance-level action and read, each as `token`: its status. */
async function instanceLevel(app: TestApp, token: string): Promise<Record<string, number>> {
  const s = { 'x-hopper-session': token };
  // Loopback without a session reads the realms (an instance read): the version to change them against.
  const version = (await app.api<{ version: string }>('GET', '/api/realms')).body.version;
  return {
    'GET /api/realms': (await app.api('GET', '/api/realms', undefined, s)).status,
    'GET /api/users': (await app.api('GET', '/api/users', undefined, s)).status,
    'GET /api/instance': (await app.api('GET', '/api/instance', undefined, s)).status,
    'POST /ui/api/realms': (await app.ui('/ui/api/realms', { action: 'settings', local: true, version }, { token })).status,
    'POST /ui/api/users': (await app.ui('/ui/api/users', { action: 'add', name: `Someone ${Math.random().toString(36).slice(2, 8)}` }, { token })).status,
    'POST /ui/api/update': (await app.ui('/ui/api/update', { action: 'settings' }, { token })).status,
    'POST /ui/api/plugin-store': (await app.ui('/ui/api/plugin-store', { action: 'refresh' }, { token })).status,
  };
}

const allRefused = (r: Record<string, number>) => expect(r).toEqual(Object.fromEntries(Object.keys(r).map((k) => [k, 403])));
const noneRefused = (r: Record<string, number>) => { for (const [k, status] of Object.entries(r)) expect(status, k).not.toBe(403); };

describe('the instance admin is the first GitHub user; a login code is no admin login (issue #240)', () => {
  it('the first GitHub admin does what is the instance\'s; a user they add, by its login link, does not', async () => {
    const github = await forge();
    const { app, origin } = await startNewHopper(h, undefined, ENV(github));
    const first = await signInAs(app.url, origin, github, 'octo-user');
    expect((await session(app, first)).user).toMatchObject({ name: 'octo-user', role: 'admin', instanceAdmin: true });

    const added = await app.ui<{ user: { id: string }; links: string[] }>('/ui/api/users', { action: 'add', name: 'Bea' }, { token: first });
    expect(added.status).toBe(200);
    const bea = await app.loginWith(codeOf(added.body.links[0]!));
    // Bea sets up her own environment (role admin inside her own user), but is not the instance's admin.
    expect((await session(app, bea)).user).toMatchObject({ id: 'bea', role: 'admin', realm: 'local', instanceAdmin: false });
    allRefused(await instanceLevel(app, bea));
    const plugins = (await app.api('GET', '/api/plugins', undefined, { 'x-hopper-session': bea })).body;
    const own = await app.ui('/ui/api/plugins', { action: 'select', role: 'queue-sorter', plugin: 'oldest-first', version: plugins.config.version }, { token: bea });
    expect(own.status).toBe(200);

    noneRefused(await instanceLevel(app, first));
  });

  it('a device link minted by a user who is not the instance admin signs in as that user, and no more', async () => {
    const github = await forge();
    const { app, origin } = await startNewHopper(h, undefined, ENV(github));
    const first = await signInAs(app.url, origin, github, 'octo-user');
    const added = await app.ui<{ links: string[] }>('/ui/api/users', { action: 'add', name: 'Bea' }, { token: first });
    const bea = await app.loginWith(codeOf(added.body.links[0]!));

    const link = await app.ui<{ links: string[] }>('/ui/api/device-link', {}, { token: bea });
    expect(link.status).toBe(200);
    const device = await app.loginWith(codeOf(link.body.links[0]!));
    expect((await session(app, device)).user).toMatchObject({ id: 'bea', instanceAdmin: false });
    allRefused(await instanceLevel(app, device));
  });

  it('a device link of the first GitHub admin keeps what they had', async () => {
    const github = await forge();
    const { app, origin } = await startNewHopper(h, undefined, ENV(github));
    const first = await signInAs(app.url, origin, github, 'octo-user');
    const link = await app.ui<{ links: string[] }>('/ui/api/device-link', {}, { token: first });
    const device = await app.loginWith(codeOf(link.body.links[0]!));
    expect((await session(app, device)).user).toMatchObject({ name: 'octo-user', instanceAdmin: true });
    noneRefused(await instanceLevel(app, device));
  });

  it('another GitHub user a rule makes admin is admin of their own user only', async () => {
    const github = await forge();
    const { app, origin } = await startNewHopper(h, withRoles({ admin: { usernames: ['second'] } }), ENV(github));
    await signInAs(app.url, origin, github, 'octo-user');
    const second = await signInAs(app.url, origin, github, 'second');
    expect((await session(app, second)).user).toMatchObject({ name: 'second', role: 'admin', instanceAdmin: false });
    allRefused(await instanceLevel(app, second));
  });

  it('a hopper with no first GitHub admin recorded: the oldest user is the instance admin, a user added later is not', async () => {
    const { app } = await startWithAuth(h, undefined, LAN);
    const admin = await app.login();
    expect((await session(app, admin)).user).toMatchObject({ id: 'admin', instanceAdmin: true });
    const added = await app.ui<{ links: string[] }>('/ui/api/users', { action: 'add', name: 'Bea' }, { token: admin });
    const bea = await app.loginWith(codeOf(added.body.links[0]!));
    expect((await session(app, bea)).user).toMatchObject({ id: 'bea', instanceAdmin: false });
    allRefused(await instanceLevel(app, bea));
    noneRefused(await instanceLevel(app, admin));
  });
});
