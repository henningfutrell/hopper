// Local accounts (issue #1380, design.md "Local accounts"): the hopper's own sign-in, an email and a password, with no
// identity provider and no GitHub. A realm-only hopper gets its first admin from the operator CLI; that admin signs in
// with the email and password, is the instance admin, and manages the other accounts in Settings → Sign-in. An admin
// never sets the password of an account that signs in as another user; an account changes its own password, which ends
// its other sessions. Through the daemon's HTTP routes, the CLI on the same database.
import { afterEach, describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../../src/cli.ts';
import type { TestApp } from '../support/app.ts';
import { databaseUrlFor } from '../support/database.ts';
import { rawRequest } from '../support/http.ts';
import { harness, session, startNewHopper, stopAll } from '../support/sign-in-app.ts';

const h = harness();
afterEach(() => stopAll(h));

const PASSWORD = 'correct horse battery staple';

async function cli(app: TestApp, argv: string[], stdin = '') {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { env: { HOPPER_DATABASE_URL: databaseUrlFor(app.dbPath) }, stdin: () => stdin, out: (t) => out.push(t), err: (t) => err.push(t) };
  return { code: await runCli(argv, io), out: out.join(''), err: err.join('') };
}

type Hopper = { app: TestApp; origin: string; host: string };
const signIn = async (o: Hopper, username: string, password: string) => {
  const res = await rawRequest(o.app.url, {
    path: '/ui/auth/password', method: 'POST', body: JSON.stringify({ username, password }),
    headers: { host: o.host, origin: o.origin, 'content-type': 'application/json' },
  });
  return { status: res.status, body: JSON.parse(res.text) as { token?: string; error?: string } };
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read loose JSON
const accounts = async (o: Hopper, token: string): Promise<any> => (await o.app.api('GET', '/api/local-accounts', undefined, { 'x-hopper-session': token })).body;
const edit = (o: Hopper, token: string, body: Record<string, unknown>) => o.app.ui<{ error?: string }>('/ui/api/local-accounts', body, { token });

/** A realm-only hopper (no GitHub, no identity provider) whose first admin the CLI added; signed in as them. */
async function realmOnly(): Promise<{ o: Hopper; admin: string }> {
  const o = await startNewHopper(h, { version: 1, realms: [] });
  expect((await cli(o.app, ['local-account', 'add', 'Ada@Example.com'], `${PASSWORD}\n`)).code).toBe(0);
  const r = await signIn(o, 'ada@example.com', PASSWORD);
  expect(r.status).toBe(200);
  return { o, admin: r.body.token! };
}

describe('a realm-only hopper: no GitHub, no identity provider (issue #1380)', () => {
  it('offers no password form until the CLI adds the first admin; then the admin signs in with email and password', async () => {
    const o = await startNewHopper(h, { version: 1, realms: [] });
    expect((await session(o.app)).signIn).toMatchObject({ password: false, devices: [] });
    expect((await signIn(o, 'ada@example.com', PASSWORD)).status).toBe(403);
    const added = await cli(o.app, ['local-account', 'add', 'Ada@Example.com'], `${PASSWORD}\n`);
    expect(added).toMatchObject({ code: 0, err: expect.stringMatching(/local account ada@example.com added, role admin/) });
    expect((await cli(o.app, ['local-account', 'list'])).out).toMatch(/^ada@example\.com\tadmin\t/);
    expect((await session(o.app)).signIn).toMatchObject({ password: true });
    expect(await signIn(o, 'ada@example.com', 'not the password at all')).toMatchObject({ status: 403, body: { error: expect.stringMatching(/wrong email, username or password/) } });
    expect((await signIn(o, 'bea@example.com', PASSWORD)).status).toBe(403);
    const r = await signIn(o, 'ADA@example.com', PASSWORD);
    expect(r.status).toBe(200);
    expect(await session(o.app, r.body.token)).toMatchObject({ authenticated: true, user: { role: 'admin', realm: 'local-accounts', instanceAdmin: true } });
    expect(o.app.app.instance.users.list()).toHaveLength(1);
    // Only the hash is kept.
    expect(JSON.stringify(o.app.app.instance.localAccounts.list())).not.toContain(PASSWORD);
  });

  it('the CLI refuses a short password, a second account of one email, and a password as an argument', async () => {
    const o = await startNewHopper(h, { version: 1, realms: [] });
    expect(await cli(o.app, ['local-account', 'add', 'ada@example.com'], 'short\n')).toMatchObject({ code: 2, err: expect.stringMatching(/at least 12 characters/) });
    expect((await cli(o.app, ['local-account', 'add', 'ada@example.com'], PASSWORD)).code).toBe(0);
    expect(await cli(o.app, ['local-account', 'add', 'ada@example.com'], PASSWORD)).toMatchObject({ code: 2, err: expect.stringMatching(/there is a local account ada@example.com/) });
    expect((await cli(o.app, ['local-account', 'add', 'ada@example.com', PASSWORD])).code).toBe(2);
    expect((await cli(o.app, ['local-account', 'password', 'ada@example.com'], 'a brand new password')).code).toBe(0);
    expect((await signIn(o, 'ada@example.com', 'a brand new password')).status).toBe(200);
    expect((await cli(o.app, ['local-account', 'remove', 'ada@example.com'])).code).toBe(0);
    expect((await cli(o.app, ['local-account', 'remove', 'ada@example.com'])).code).toBe(2);
  });

  it('the admin adds an account for someone else, who signs in as a user of their own with the role it names', async () => {
    const { o, admin } = await realmOnly();
    expect((await edit(o, admin, { action: 'save', email: 'bea@example.com', role: 'operator', password: 'bea has a password' })).status).toBe(200);
    expect((await edit(o, admin, { action: 'save', email: 'cy@example.com', role: 'viewer', password: 'short' })).status).toBe(400);
    const bea = await signIn(o, 'bea@example.com', 'bea has a password');
    expect(await session(o.app, bea.body.token)).toMatchObject({ user: { role: 'operator', realm: 'local-accounts', instanceAdmin: false } });
    expect(o.app.app.instance.users.list()).toHaveLength(2);
    const view = await accounts(o, admin);
    expect(view.accounts).toEqual([
      { email: 'ada@example.com', role: 'admin', createdAt: expect.any(String), user: expect.any(String) },
      { email: 'bea@example.com', role: 'operator', createdAt: expect.any(String), user: expect.any(String) },
    ]);
    expect(JSON.stringify(view)).not.toMatch(/scrypt|passwordHash/);
    // Not for a viewer or operator: the instance admin's only.
    expect((await o.app.api('GET', '/api/local-accounts', undefined, { 'x-hopper-session': bea.body.token! })).status).toBe(403);
    expect((await edit(o, bea.body.token!, { action: 'remove', email: 'ada@example.com' })).status).toBe(403);
    // A role change applies to the live session at once.
    expect((await edit(o, admin, { action: 'save', email: 'bea@example.com', role: 'viewer' })).status).toBe(200);
    expect(await session(o.app, bea.body.token)).toMatchObject({ user: { role: 'viewer' } });
  });

  it('an admin never sets the password of an account that signs in as another user; that user changes it, ending their other sessions', async () => {
    const { o, admin } = await realmOnly();
    await edit(o, admin, { action: 'save', email: 'bea@example.com', role: 'operator', password: 'bea has a password' });
    const first = (await signIn(o, 'bea@example.com', 'bea has a password')).body.token!;
    const second = (await signIn(o, 'bea@example.com', 'bea has a password')).body.token!;
    const r = await edit(o, admin, { action: 'save', email: 'bea@example.com', role: 'operator', password: 'the admin knows this' });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/signs in as another user/);
    // Removed and added again under the same email: it would sign in as Bea's user, so it is refused too.
    expect((await edit(o, admin, { action: 'remove', email: 'bea@example.com' })).status).toBe(200);
    expect((await session(o.app, first)).authenticated).toBe(false);
    expect((await edit(o, admin, { action: 'save', email: 'bea@example.com', role: 'operator', password: 'the admin knows this' })).status).toBe(409);
    expect((await signIn(o, 'bea@example.com', 'the admin knows this')).status).toBe(403);
    expect((await session(o.app, second)).authenticated).toBe(false);
  });

  it('an account changes its own password: the current one checked, its other sessions end', async () => {
    const { o, admin } = await realmOnly();
    const other = (await signIn(o, 'ada@example.com', PASSWORD)).body.token!;
    expect((await o.app.ui('/ui/api/local-accounts/password', { current: 'wrong password!', password: 'a whole new password' }, { token: admin })).status).toBe(400);
    expect((await o.app.ui('/ui/api/local-accounts/password', { current: PASSWORD, password: 'a whole new password' }, { token: admin })).status).toBe(200);
    expect((await session(o.app, admin)).authenticated).toBe(true);
    expect((await session(o.app, other)).authenticated).toBe(false);
    expect((await signIn(o, 'ada@example.com', PASSWORD)).status).toBe(403);
    expect((await signIn(o, 'ada@example.com', 'a whole new password')).status).toBe(200);
  });

  it('nobody locks themselves out: the acting account is not removed or lowered from admin', async () => {
    const { o, admin } = await realmOnly();
    expect((await edit(o, admin, { action: 'remove', email: 'ada@example.com' })).status).toBe(409);
    expect((await edit(o, admin, { action: 'save', email: 'ada@example.com', role: 'operator' })).status).toBe(409);
    expect(await session(o.app, admin)).toMatchObject({ user: { role: 'admin' } });
  });

  it('no realm takes the name local accounts sign in through', async () => {
    const { o, admin } = await realmOnly();
    const version = (await o.app.api<{ version: string }>('GET', '/api/realms', undefined, { 'x-hopper-session': admin })).body.version;
    const r = await o.app.ui<{ error?: string }>('/ui/api/realms', { action: 'save', realm: { name: 'local-accounts', type: 'github' }, version }, { token: admin });
    expect(r.status).toBe(400);
  });
});
