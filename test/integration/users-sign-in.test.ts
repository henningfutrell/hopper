// Sign-in maps an identity to a user (issue #158, design.md "Users: one hopper, separate users"): a
// linked identity signs in as its user; an unlinked one a role rule grants a role gets a new user of its
// own; no sign-in is owner.
import argon2 from 'argon2';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { rawRequest } from '../support/http.ts';
import { signIn } from '../support/idp.ts';
import { harness, oidcIdp, oidcRealm, session, startWithAuth, stopAll } from '../support/sign-in-app.ts';

const h = harness();
afterEach(() => stopAll(h));

let adaHash = '';
beforeAll(async () => { adaHash = await argon2.hash('correct horse', { type: argon2.argon2id }); });

const json = (host: string, origin: string, body: unknown) => ({
  method: 'POST', body: JSON.stringify(body), headers: { host, origin, 'content-type': 'application/json' },
});
const tokenOf = (text: string): string => (JSON.parse(text) as { token: string }).token;

describe('an identity signs in as its user', () => {
  it('a new identity a role rule grants gets a user of its own; signing in again is the same user', async () => {
    const idp = await oidcIdp(h, { claims: { sub: 'sub-ada', preferred_username: 'ada', name: 'Ada Lovelace', email: 'ada@example.com', email_verified: true }, userinfo: { sub: 'sub-ada' } });
    const { app, origin } = await startWithAuth(h, { version: 1, realms: [oidcRealm(idp, { defaultRole: 'operator' })] });
    const first = (await signIn(app.url, origin, 'corp')).token!;
    expect((await session(app, first)).user).toEqual({ id: 'ada', name: 'ada', role: 'operator', realm: 'corp', identity: 'Ada Lovelace' });
    const again = (await signIn(app.url, origin, 'corp')).token!;
    expect((await session(app, again)).user.id).toBe('ada');
    expect(app.app.users().map((u) => u.id)).toEqual(['owner', 'ada']);
    // Another identity with the same username gets a user of its own, under a name made unique.
    Object.assign(idp.claims, { sub: 'sub-other' });
    Object.assign(idp.userinfo, { sub: 'sub-other' });
    const other = (await signIn(app.url, origin, 'corp')).token!;
    expect((await session(app, other)).user).toMatchObject({ id: 'ada_2', name: 'ada 2' });
    // The new user's reads are its own: owner's job is not there.
    const job = await app.pull({ op: 'sleep', ms: 60_000 });
    expect((await app.api('GET', '/api/jobs', undefined, { 'x-hopper-session': first })).body.jobs).toEqual([]);
    expect((await app.api('GET', '/api/jobs', undefined, { 'x-hopper-session': await app.login() })).body.jobs.map((j: { id: string }) => j.id)).toEqual([job.id]);
  });

  it('an identity no rule grants gets no session and no user', async () => {
    const idp = await oidcIdp(h, { claims: { sub: 'sub-x', preferred_username: 'x' }, userinfo: { sub: 'sub-x' } });
    const { app, origin } = await startWithAuth(h, { version: 1, realms: [oidcRealm(idp, { admin: { usernames: ['someone-else'] } })] });
    expect((await signIn(app.url, origin, 'corp')).token).toBeUndefined();
    expect(app.app.users().map((u) => u.id)).toEqual(['owner']);
  });

  it('a password account gets a user named after it', async () => {
    const { app, origin, host } = await startWithAuth(h, { version: 1, realms: [{ name: 'password', type: 'password', users: [{ username: 'ada', passwordHash: adaHash, role: 'admin' }] }] });
    const res = await rawRequest(app.url, { path: '/ui/auth/password', ...json(host, origin, { username: 'ada', password: 'correct horse' }) });
    expect((await session(app, tokenOf(res.text))).user).toEqual({ id: 'ada', name: 'ada', role: 'admin', realm: 'password', identity: 'ada' });
  });

  it('no sign-in is owner', async () => {
    const { app, origin, host } = await startWithAuth(h, { version: 1, none: { role: 'viewer' } });
    const res = await rawRequest(app.url, { path: '/ui/auth/none', ...json(host, origin, {}) });
    expect((await session(app, tokenOf(res.text))).user).toEqual({ id: 'owner', name: 'owner', role: 'viewer', realm: 'none', identity: 'no sign-in' });
  });

  it('a session outside admin may not add users: users are an instance mutation', async () => {
    const { app, origin, host } = await startWithAuth(h, { version: 1, none: { role: 'operator' } });
    const token = tokenOf((await rawRequest(app.url, { path: '/ui/auth/none', ...json(host, origin, {}) })).text);
    const r = await app.ui('/ui/api/users', { action: 'add', name: 'cy' }, { token });
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ needs: 'admin' });
  });
});
