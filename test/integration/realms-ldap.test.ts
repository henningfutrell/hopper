// Realms (issue #185, design.md "Sign-in: realms"): an LDAP realm signs people in against a real
// directory (OpenLDAP in a throwaway container, the planetexpress test directory), and the username
// and password form tries every enabled password and LDAP realm in order — the first that accepts the
// credentials signs in. Through the daemon's HTTP routes, with the sign-in config in the database.
import argon2 from 'argon2';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { rawRequest } from '../support/http.ts';
import { harness, session, startWithAuth, stopAll } from '../support/sign-in-app.ts';

const IMAGE = 'ghcr.io/ldapjs/docker-test-openldap/openldap:2023-10-30';
const BASE = 'dc=planetexpress,dc=com';
const PEOPLE = `ou=people,${BASE}`;
const ADMIN_STAFF = `cn=admin_staff,${PEOPLE}`;

let ldap: StartedTestContainer;
let url = '';
let hermesHash = '';
/** The professor's directory password, also held by a password realm account: both realms accept it. */
let professorHash = '';
beforeAll(async () => {
  ldap = await new GenericContainer(IMAGE).withExposedPorts(389).withWaitStrategy(Wait.forLogMessage('slapd starting')).start();
  url = `ldap://127.0.0.1:${ldap.getMappedPort(389)}`;
  hermesHash = await argon2.hash('local pass', { type: argon2.argon2id });
  professorHash = await argon2.hash('professor', { type: argon2.argon2id });
}, 120_000);
afterAll(async () => { await ldap?.stop(); });

const h = harness();
afterEach(() => stopAll(h));

const dir = (extra: Record<string, unknown> = {}) => ({
  name: 'dir', label: 'Planet Express', type: 'ldap', url,
  bindDn: `cn=admin,${BASE}`, bindPasswordEnv: 'LDAP_BIND_PASSWORD', userBase: PEOPLE,
  attributes: { subject: 'entryUUID', name: 'displayName' },
  roles: { admin: { groups: [ADMIN_STAFF] }, defaultRole: 'viewer' },
  ...extra,
});

const signIn = async (o: { app: { url: string }; origin: string; host: string }, username: string, password: string) => {
  const res = await rawRequest(o.app.url, {
    path: '/ui/auth/password', method: 'POST', body: JSON.stringify({ username, password }),
    headers: { host: o.host, origin: o.origin, 'content-type': 'application/json' },
  });
  return { status: res.status, body: JSON.parse(res.text) as { token?: string; error?: string } };
};

describe('an LDAP realm', () => {
  it('signs in with the directory password; the role comes from the directory groups', async () => {
    const o = await startWithAuth(h, { version: 1, local: { enabled: false }, realms: [dir()] });
    expect((await session(o.app)).signIn).toMatchObject({ password: true, realms: [] });
    const prof = await signIn(o, 'professor', 'professor');
    expect(prof.status).toBe(200);
    expect(await session(o.app, prof.body.token)).toMatchObject({ authenticated: true, user: { role: 'admin', realm: 'dir', identity: 'Professor Farnsworth' } });
    const fry = await signIn(o, 'fry', 'fry');
    expect(await session(o.app, fry.body.token)).toMatchObject({ user: { role: 'viewer', realm: 'dir', identity: 'Fry' } });
  });

  it.each([
    ['a wrong password', 'fry', 'leela'],
    ['an unknown user', 'zoidberg2', 'x'],
    ['an empty password (an unauthenticated bind)', 'fry', ''],
    ['a filter injection', 'fry)(uid=*', 'fry'],
  ])('refuses %s', async (_what, username, password) => {
    const o = await startWithAuth(h, { version: 1, realms: [dir()] });
    expect((await signIn(o, username, password)).status).toBe(403);
  });

  it('a group search finds the groups when the directory has no memberOf', async () => {
    const o = await startWithAuth(h, {
      version: 1, realms: [dir({ attributes: { groups: 'nonexistent' }, groupSearch: { base: PEOPLE }, roles: { admin: { groups: ['admin_staff'] } } })],
    });
    const prof = await signIn(o, 'professor', 'professor');
    expect(await session(o.app, prof.body.token)).toMatchObject({ user: { role: 'admin' } });
    expect((await signIn(o, 'fry', 'fry')).status).toBe(403);
  });

  it('a directory that cannot be reached is a 502 that says so, not a wrong password', async () => {
    const o = await startWithAuth(h, { version: 1, realms: [dir({ url: 'ldap://127.0.0.1:1' })] });
    const r = await signIn(o, 'fry', 'fry');
    expect(r.status).toBe(502);
    expect(r.body.error).toMatch(/Planet Express/);
  });
});

describe('the username and password form tries the realms in order', () => {
  const local = (users: unknown[]) => ({ name: 'staff', type: 'password', users });

  it('a password realm and an LDAP realm: each signs in its own people', async () => {
    const o = await startWithAuth(h, { version: 1, realms: [local([{ username: 'hermes', passwordHash: hermesHash, role: 'operator' }]), dir()] });
    const hermes = await signIn(o, 'hermes', 'local pass');
    expect(await session(o.app, hermes.body.token)).toMatchObject({ user: { role: 'operator', realm: 'staff' } });
    const fry = await signIn(o, 'fry', 'fry');
    expect(await session(o.app, fry.body.token)).toMatchObject({ user: { realm: 'dir' } });
  });

  it('the same username in both: a realm that refuses the password passes it on to the next', async () => {
    const realms = [local([{ username: 'professor', passwordHash: hermesHash, role: 'viewer' }]), dir()];
    const o = await startWithAuth(h, { version: 1, realms });
    expect(await session(o.app, (await signIn(o, 'professor', 'local pass')).body.token)).toMatchObject({ user: { realm: 'staff', role: 'viewer' } });
    expect(await session(o.app, (await signIn(o, 'professor', 'professor')).body.token)).toMatchObject({ user: { realm: 'dir', role: 'admin' } });
  });

  it.each([
    ['the password realm first', ['staff', 'dir'], { realm: 'staff', role: 'viewer' }],
    ['the LDAP realm first', ['dir', 'staff'], { realm: 'dir', role: 'admin' }],
  ])('both accept the password: the realm first in order signs in (%s)', async (_what, order, user) => {
    const by: Record<string, unknown> = { staff: local([{ username: 'professor', passwordHash: professorHash, role: 'viewer' }]), dir: dir() };
    const o = await startWithAuth(h, { version: 1, realms: order.map((n) => by[n]) });
    expect(await session(o.app, (await signIn(o, 'professor', 'professor')).body.token)).toMatchObject({ user });
  });

  it('a realm that is off is skipped', async () => {
    const o = await startWithAuth(h, { version: 1, realms: [dir({ enabled: false })] });
    expect((await session(o.app)).signIn.password).toBe(false);
    expect((await signIn(o, 'fry', 'fry')).status).toBe(403);
  });
});
