// No sign-in (issue #53, design.md "Sign-in"), and no password sign-in without a directory (issue #237):
// through the daemon's HTTP routes, with the sign-in config in the database; and the sign-in routes'
// rate limit. Password sign-in against a directory: realms-ldap.test.ts.
import { afterEach, describe, expect, it } from 'vitest';
import { rawRequest } from '../support/http.ts';
import { harness, restartWithAuth, session, startWithAuth, stopAll } from '../support/sign-in-app.ts';

const h = harness();
afterEach(() => stopAll(h));
const start = (auth: unknown) => startWithAuth(h, auth);

const json = (host: string, origin: string, body: unknown) => ({
  method: 'POST', body: JSON.stringify(body), headers: { host, origin, 'content-type': 'application/json' },
});
const tokenOf = (text: string): string => (JSON.parse(text) as { token: string }).token;

describe('no sign-in (the sign-in config\'s none)', () => {
  it('off by default: the offer says so, POST /ui/auth/none is refused', async () => {
    const { app, origin, host } = await start(undefined);
    expect((await session(app)).signIn).toEqual({ local: true, none: null, password: false, gateway: false, origin, realms: [], required: false });
    expect((await rawRequest(app.url, { path: '/ui/auth/none', ...json(host, origin, {}) })).status).toBe(403);
  });

  it('on: anyone gets a session with the configured role, no credential', async () => {
    const { app, origin, host } = await start({ version: 1, local: { enabled: false }, none: { role: 'operator' } });
    expect((await session(app)).signIn.none).toBe('operator');
    const res = await rawRequest(app.url, { path: '/ui/auth/none', ...json(host, origin, {}) });
    expect(res.status).toBe(200);
    expect(await session(app, tokenOf(res.text))).toMatchObject({ authenticated: true, user: { id: 'admin', name: 'admin', role: 'operator', realm: 'none', identity: 'no sign-in' } });
  });

  it('the session acts within its role: an operator may not set the queue gate', async () => {
    const { app, origin, host } = await start({ version: 1, none: { role: 'operator' } });
    const token = tokenOf((await rawRequest(app.url, { path: '/ui/auth/none', ...json(host, origin, {}) })).text);
    const r = await app.ui('/ui/api/queue-gate', { mode: 'review', autoAcceptPerHour: null }, { token });
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ needs: 'admin' });
  });

  it('from another origin it is refused', async () => {
    const { app, host } = await start({ version: 1, none: { role: 'viewer' } });
    expect((await rawRequest(app.url, { path: '/ui/auth/none', ...json(host, 'http://evil.example', {}) })).status).toBe(403);
  });

  it('turned off, its sessions end at the next start; a changed role applies to them', async () => {
    const { app, origin, host } = await start({ version: 1, none: { role: 'viewer' } });
    const token = tokenOf((await rawRequest(app.url, { path: '/ui/auth/none', ...json(host, origin, {}) })).text);
    const raised = await restartWithAuth(h, app, { version: 1, none: { role: 'admin' } });
    expect((await session(raised, token)).user.role).toBe('admin');
    const off = await restartWithAuth(h, raised, { version: 1 });
    expect((await session(off, token)).authenticated).toBe(false);
  });
});

describe('password sign-in without an LDAP realm (no password user realm, issue #237)', () => {
  it('the offer says password sign-in is off, and POST /ui/auth/password is refused', async () => {
    const { app, origin, host } = await start(undefined);
    expect((await session(app)).signIn.password).toBe(false);
    const res = await rawRequest(app.url, { path: '/ui/auth/password', ...json(host, origin, { username: 'admin', password: 'correct horse' }) });
    expect(res.status).toBe(403);
    expect(res.text).not.toMatch(/token/);
  });
});

describe('sign-in routes are rate limited', () => {
  it('past 20 attempts a minute from one address: 429', async () => {
    const { app, origin, host } = await start(undefined);
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) {
      statuses.push((await rawRequest(app.url, { path: '/ui/auth/password', ...json(host, origin, { username: 'ada', password: 'wrong' }) })).status);
    }
    expect(statuses.slice(0, 20).every((s) => s === 403)).toBe(true);
    expect(statuses[20]).toBe(429);
    // The limit is per route family, not the whole daemon: reads still answer.
    expect((await rawRequest(app.url, { path: '/ui/api/session' })).status).toBe(200);
  });
});
