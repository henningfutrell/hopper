// What an admin sees of the users' work (issue #221, design.md "What an admin sees"), through the real
// HTTP server and the real store: the totals across users, never one user's work; sign-in changes that
// would hand an admin a way into another user's work are refused; a user changes their own password.
import { afterEach, describe, expect, it } from 'vitest';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;

async function start(): Promise<TestApp> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  t = await startTestApp({ dbPath: db.dbPath });
  return t;
}

afterEach(async () => {
  await t?.stop();
  t = undefined;
  cleanup?.();
});

const hard = { op: 'ask', message: 'This one is hard and risky' };
const sleep = { op: 'sleep', ms: 60_000 };
const session = (token: string) => ({ 'x-hopper-session': token });

/** Owner signed in; the user `bea` added from the UI, signed in with the link the answer carried. */
async function twoUsers(a: TestApp): Promise<{ admin: string; bea: string }> {
  const admin = await a.login();
  const added = await a.ui<{ links: string[] }>('/ui/api/users', { action: 'add', name: 'Bea' }, { token: admin });
  expect(added.status).toBe(200);
  const code = /#login=([0-9a-f]{64})$/.exec(added.body.links[0]!)![1]!;
  return { admin, bea: await a.loginWith(code) };
}

describe('an admin reads the totals, never a user\'s work', () => {
  /** A password realm `pw` with the account `cy`, added by admin's admin session; cy signed in once (so a user of its own). */
  async function cyByPassword(a: TestApp, admin: string): Promise<string> {
    const realms = async () => (await a.api('GET', '/api/realms', undefined, session(admin))).body as { version: string };
    expect((await a.ui('/ui/api/realms', { action: 'save', realm: { name: 'pw', type: 'password' }, version: (await realms()).version }, { token: admin })).status).toBe(200);
    expect((await a.ui('/ui/api/realms', { action: 'account', realm: 'pw', username: 'cy', role: 'admin', password: 'first-password', version: (await realms()).version }, { token: admin })).status).toBe(200);
    return passwordSignIn(a, 'cy', 'first-password');
  }
  async function passwordSignIn(a: TestApp, username: string, password: string): Promise<string> {
    const r = await a.ui<{ token: string }>('/ui/auth/password', { username, password });
    expect(r.status, `${username} signs in`).toBe(200);
    return r.body.token;
  }
  const version = async (a: TestApp, token: string): Promise<string> => (await a.api('GET', '/api/realms', undefined, session(token))).body.version;

  it('GET /api/instance: the totals across users, no job, question or user of anyone; only an admin', async () => {
    const a = await start();
    const { admin, bea } = await twoUsers(a);
    const adminJob = await a.pull(hard);
    await a.waitForQuestion(adminJob.id, (q) => q.tier === 'human');
    const beaJob = await a.pull(sleep, {}, 'bea');
    await a.waitForStatusOf(beaJob.id, 'running', 'bea');
    const r = await a.api('GET', '/api/instance', undefined, session(admin));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      users: 2,
      jobs: { queued: 0, held: 0, claimed: 0, running: 1, waiting_answer: 1 },
      questions: { open: 1 },
      lanes: { busy: 1, total: expect.any(Number) },
    });
    expect(JSON.stringify(r.body)).not.toMatch(new RegExp(`${adminJob.id}|${beaJob.id}|bea|Bea`));
    expect((await a.api('GET', '/api/instance', undefined, session(bea))).status).toBe(200);
  });

  it('an admin may not set the password of, link, or re-add an account that signs in as another user', async () => {
    const a = await start();
    const admin = await a.login();
    const cy = await cyByPassword(a, admin);
    expect((await a.api('GET', '/ui/api/session', undefined, session(cy))).body.user).toMatchObject({ id: 'cy' });
    await a.addUser('Bea');
    const account = { action: 'account', realm: 'pw', role: 'admin' };
    const reset = await a.ui<{ error: string }>('/ui/api/realms', { ...account, username: 'cy', password: 'admin-knows-it', version: await version(a, admin) }, { token: admin });
    expect(reset.status).toBe(409);
    expect(reset.body.error).toContain('signs in as another user');
    expect((await a.ui('/ui/api/realms', { ...account, username: 'dee', password: 'admin-knows-it', user: 'bea', version: await version(a, admin) }, { token: admin })).status).toBe(409);
    expect((await a.ui('/ui/api/realms', { action: 'account-remove', realm: 'pw', username: 'cy', version: await version(a, admin) }, { token: admin })).status).toBe(200);
    expect((await a.ui('/ui/api/realms', { ...account, username: 'cy', password: 'admin-knows-it', version: await version(a, admin) }, { token: admin })).status).toBe(409);
    expect((await a.ui('/ui/auth/password', { username: 'cy', password: 'admin-knows-it' })).status).not.toBe(200);
    expect((await a.ui('/ui/api/realms', { ...account, username: 'eve', password: 'own-account', user: 'admin', version: await version(a, admin) }, { token: admin })).status).toBe(200);
  });

  it('an admin may change the role of an account that signs in as another user; the totals need admin', async () => {
    const a = await start();
    const admin = await a.login();
    const cy = await cyByPassword(a, admin);
    expect((await a.ui('/ui/api/realms', { action: 'account', realm: 'pw', username: 'cy', role: 'viewer', version: await version(a, admin) }, { token: admin })).status).toBe(200);
    expect((await a.api('GET', '/api/instance', undefined, session(cy))).status).toBe(403);
  });

  it('a user changes their own password; their other sessions end; the old password no longer signs in', async () => {
    const a = await start();
    const admin = await a.login();
    const cy = await cyByPassword(a, admin);
    const other = await passwordSignIn(a, 'cy', 'first-password');
    expect((await a.ui('/ui/api/password', { current: 'wrong-password', password: 'only-cy-knows' }, { token: cy })).status).toBe(400);
    expect((await a.ui('/ui/api/password', { current: 'first-password', password: 'only-cy-knows' }, { token: cy })).status).toBe(200);
    expect((await a.api('GET', '/ui/api/session', undefined, session(cy))).body.authenticated).toBe(true);
    expect((await a.api('GET', '/ui/api/session', undefined, session(other))).body.authenticated).toBe(false);
    expect((await a.ui('/ui/auth/password', { username: 'cy', password: 'first-password' })).status).not.toBe(200);
    const again = await passwordSignIn(a, 'cy', 'only-cy-knows');
    expect((await a.api('GET', '/ui/api/session', undefined, session(again))).body.user).toMatchObject({ id: 'cy' });
    expect((await a.ui('/ui/api/password', { current: 'x', password: 'not-a-password-account' }, { token: admin })).status).toBe(409);
  });

  it('no sign-in stays off while the hopper has more than one user, and a user is not added while it is on', async () => {
    const a = await start();
    const admin = await a.login();
    expect((await a.ui('/ui/api/realms', { action: 'settings', none: 'viewer', version: await version(a, admin) }, { token: admin })).status).toBe(200);
    expect((await a.ui('/ui/api/users', { action: 'add', name: 'Bea' }, { token: admin })).status).toBe(409);
    expect((await a.ui('/ui/api/realms', { action: 'settings', none: null, version: await version(a, admin) }, { token: admin })).status).toBe(200);
    expect((await a.ui('/ui/api/users', { action: 'add', name: 'Bea' }, { token: admin })).status).toBe(200);
    const on = await a.ui<{ error: string }>('/ui/api/realms', { action: 'settings', none: 'viewer', version: await version(a, admin) }, { token: admin });
    expect(on.status).toBe(409);
    expect(on.body.error).toContain('more than one user');
  });

  it('with several users, /api/health without a session answers the instance\'s health only: install and self-update probe it', async () => {
    const a = await start();
    await a.addUser('Bea');
    const r = await a.api('GET', '/api/health');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, version: expect.any(String), uptimeS: expect.any(Number) });
    const full = await a.api('GET', '/api/health', undefined, session(await a.login()));
    expect(full.body).toMatchObject({ ok: true, routerMode: 'shadow', executors: expect.any(Array) });
  });
});
