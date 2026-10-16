// Passkeys for local accounts (issue #1380, design.md "Passkeys for local accounts"), end to end on a realm-only hopper:
// the CLI's first admin signs in with the password, adds a passkey in Settings, and signs in with it alone; the landing
// page offers the passkey once there is one; an account removes its own passkeys only; removing the account removes
// them; a session that did not sign in with a local account adds none. Through the daemon's HTTP routes, a fake
// authenticator on the browser's side.
import { afterEach, describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../../src/cli.ts';
import { databaseUrlFor } from '../support/database.ts';
import { fakePasskey, type FakePasskey } from '../support/fake-authenticator.ts';
import { rawRequest } from '../support/http.ts';
import { harness, session, startNewHopper, startWithAuth, stopAll } from '../support/sign-in-app.ts';

const h = harness();
afterEach(() => stopAll(h));

const PASSWORD = 'correct horse battery staple';
type Hopper = Awaited<ReturnType<typeof startNewHopper>>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read loose JSON
const post = async (o: Hopper, path: string, body: unknown, token?: string): Promise<{ status: number; body: any }> => {
  const res = await rawRequest(o.app.url, {
    path, method: 'POST', body: JSON.stringify(body),
    headers: { host: o.host, origin: o.origin, 'content-type': 'application/json', ...(token ? { 'x-hopper-session': token } : {}) },
  });
  return { status: res.status, body: res.text ? JSON.parse(res.text) : undefined };
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read loose JSON
const read = async (o: Hopper, path: string, token: string): Promise<{ status: number; body: any }> => {
  const res = await rawRequest(o.app.url, { path, headers: { host: o.host, 'x-hopper-session': token } });
  return { status: res.status, body: res.text ? JSON.parse(res.text) : undefined };
};

async function cliAdd(o: Hopper, email: string, role = 'admin') {
  const io: CliIo = { env: { HOPPER_DATABASE_URL: databaseUrlFor(o.app.dbPath) }, stdin: () => `${PASSWORD}\n`, out: () => {}, err: () => {} };
  expect(await runCli(['local-account', 'add', email, '--role', role], io)).toBe(0);
}
const withPassword = async (o: Hopper, email: string): Promise<string> => {
  const r = await post(o, '/ui/auth/password', { username: email, password: PASSWORD });
  expect(r.status).toBe(200);
  return r.body.token as string;
};
async function addPasskey(o: Hopper, token: string, key: FakePasskey, name = 'Laptop') {
  const options = await post(o, '/ui/api/local-accounts/passkeys/options', {}, token);
  expect(options.status).toBe(200);
  return post(o, '/ui/api/local-accounts/passkeys', { name, response: key.create(options.body, o.origin) }, token);
}
async function withPasskey(o: Hopper, key: FakePasskey) {
  const start = await post(o, '/ui/auth/passkey/options', {});
  expect(start.status).toBe(200);
  return post(o, '/ui/auth/passkey', { flow: start.body.flow, response: key.get(start.body.options, o.origin) });
}

async function realmOnly() {
  const o = await startNewHopper(h, { version: 1, realms: [] });
  await cliAdd(o, 'ada@example.com');
  return { o, admin: await withPassword(o, 'ada@example.com') };
}

describe('passkeys for local accounts (issue #1380)', () => {
  it('a local account adds a passkey and signs in with it alone, as its own user and role', async () => {
    const { o, admin } = await realmOnly();
    expect((await session(o.app)).signIn).toMatchObject({ password: true, passkeys: false });
    const key = fakePasskey();
    const added = await addPasskey(o, admin, key);
    expect(added).toMatchObject({ status: 200, body: { passkeys: [{ id: key.id, name: 'Laptop', rpId: 'localhost', createdAt: expect.any(String) }] } });
    expect((await session(o.app)).signIn).toMatchObject({ passkeys: true });
    expect((await read(o, '/api/local-accounts/passkeys', admin)).body).toEqual(added.body);
    const r = await withPasskey(o, key);
    expect(r.status).toBe(200);
    expect(await session(o.app, r.body.token)).toMatchObject({ authenticated: true, user: { role: 'admin', realm: 'local-accounts', instanceAdmin: true } });
    expect(o.app.app.instance.users.list()).toHaveLength(1);
    // The admin's view counts each account's passkeys; no key material anywhere.
    const view = (await read(o, '/api/local-accounts', admin)).body;
    expect(view.accounts).toEqual([expect.objectContaining({ email: 'ada@example.com', passkeys: 1 })]);
    expect((await read(o, '/api/local-accounts/passkeys', admin)).body.passkeys[0]).not.toHaveProperty('publicKey');
  });

  it('an unknown passkey, or a sign-in from another origin, signs nobody in', async () => {
    const { o, admin } = await realmOnly();
    await addPasskey(o, admin, fakePasskey());
    expect((await withPasskey(o, fakePasskey())).status).toBe(403);
    const start = await post(o, '/ui/auth/passkey/options', {});
    const res = await rawRequest(o.app.url, {
      path: '/ui/auth/passkey/options', method: 'POST', body: '{}', headers: { host: o.host, origin: 'http://evil.example', 'content-type': 'application/json' },
    });
    expect(res.status).toBe(403);
    expect(start.status).toBe(200);
  });

  it('an account removes its own passkeys only; removing the account removes its passkeys', async () => {
    const { o, admin } = await realmOnly();
    const ada = fakePasskey();
    await addPasskey(o, admin, ada);
    expect((await post(o, '/ui/api/local-accounts', { action: 'save', email: 'bea@example.com', role: 'operator', password: 'bea has a password' }, admin)).status).toBe(200);
    const beaToken = (await post(o, '/ui/auth/password', { username: 'bea@example.com', password: 'bea has a password' })).body.token as string;
    const beaKey = fakePasskey();
    expect((await addPasskey(o, beaToken, beaKey, 'Phone')).status).toBe(200);
    // Bea sees her own passkeys only, and cannot remove Ada's.
    expect((await read(o, '/api/local-accounts/passkeys', beaToken)).body.passkeys.map((p: { id: string }) => p.id)).toEqual([beaKey.id]);
    expect((await post(o, '/ui/api/local-accounts/passkeys/remove', { id: ada.id }, beaToken)).status).toBe(404);
    expect((await withPasskey(o, ada)).status).toBe(200);
    // Her own goes.
    expect((await post(o, '/ui/api/local-accounts/passkeys/remove', { id: beaKey.id }, beaToken))).toMatchObject({ status: 200, body: { passkeys: [] } });
    expect((await withPasskey(o, beaKey)).status).toBe(403);
    // A new one, then the admin removes her account: the passkey signs nobody in.
    const again = fakePasskey();
    await addPasskey(o, beaToken, again);
    expect((await post(o, '/ui/api/local-accounts', { action: 'remove', email: 'bea@example.com' }, admin)).status).toBe(200);
    expect((await withPasskey(o, again)).status).toBe(403);
    expect(o.app.app.instance.localAccountPasskeys.list('bea@example.com')).toEqual([]);
  });

  it('a session that did not sign in with a local account adds no passkey', async () => {
    // An install from before issue #238: its admin signs in with a login code.
    const o = await startWithAuth(h, undefined);
    const code = await o.app.login();
    const r = await post(o, '/ui/api/local-accounts/passkeys/options', {}, code);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/not a local account/);
  });

  it('the role of a passkey sign-in is the account\'s role now', async () => {
    const { o, admin } = await realmOnly();
    await post(o, '/ui/api/local-accounts', { action: 'save', email: 'bea@example.com', role: 'operator', password: 'bea has a password' }, admin);
    const bea = (await post(o, '/ui/auth/password', { username: 'bea@example.com', password: 'bea has a password' })).body.token as string;
    const key = fakePasskey();
    await addPasskey(o, bea, key);
    await post(o, '/ui/api/local-accounts', { action: 'save', email: 'bea@example.com', role: 'viewer' }, admin);
    const r = await withPasskey(o, key);
    expect(await session(o.app, r.body.token)).toMatchObject({ user: { role: 'viewer' } });
  });
});
