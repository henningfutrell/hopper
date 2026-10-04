// Roles, sessions and logout are the same whichever provider signed the user in (issue #39); a public
// URL behind a reverse proxy; an invalid auth.yaml stops the daemon.
import { afterEach, describe, expect, it } from 'vitest';
import type { TestApp } from '../support/app.ts';
import { rawRequest } from '../support/http.ts';
import { signIn } from '../support/idp.ts';
import { harness, oidcIdp, oidcProvider, restartWithAuth, session, startWithAuth, stopAll } from '../support/sign-in-app.ts';

const h = harness();
afterEach(() => stopAll(h));
const start = (auth: unknown, env?: Record<string, string>) => startWithAuth(h, auth, env);
const oidc = (o?: Parameters<typeof oidcIdp>[1]) => oidcIdp(h, o);

describe('roles, sessions and logout: the same for every provider', () => {
  async function as(role: 'viewer' | 'operator' | 'admin', env: Record<string, string> = {}) {
    const idp = await oidc();
    const s = await start({ version: 1, providers: [oidcProvider(idp, { defaultRole: role })] }, env);
    const token = (await signIn(s.app.url, s.origin, 'corp')).token!;
    return { ...s, token };
  }
  const job = async (app: TestApp) => app.pull({ op: 'sleep', ms: 60_000 });

  it('a viewer reads but changes nothing (403 naming the role needed); the session stays', async () => {
    const { app, token } = await as('viewer');
    const j = await job(app);
    const res = await app.ui(`/ui/api/jobs/${j.id}/cancel`, {}, { token });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ needs: 'operator' });
    expect((await session(app, token)).authenticated).toBe(true);
    for (const path of ['/ui/api/questions/q/answer', '/ui/api/questions/q/close', '/ui/api/questions/q/dismiss', '/ui/api/questions/q/seen', '/ui/api/jobs/j/approve']) {
      expect((await app.ui(path, { answer: 'x' }, { token })).body, path).toMatchObject({ needs: 'operator' });
    }
  });

  it('an operator cancels jobs but may not change configuration', async () => {
    const { app, token } = await as('operator');
    const j = await job(app);
    expect((await app.ui(`/ui/api/jobs/${j.id}/cancel`, {}, { token })).status).toBe(200);
    const res = await app.ui('/ui/api/router-mode', { mode: 'active' }, { token });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ needs: 'admin' });
  });

  it('an admin changes configuration', async () => {
    const { app, token } = await as('admin');
    expect((await app.ui('/ui/api/router-mode', { mode: 'active' }, { token })).status).toBe(200);
  });

  it('logout ends a provider session like a local one', async () => {
    const { app, token } = await as('viewer');
    expect((await app.ui('/ui/api/logout', {}, { token })).status).toBe(200);
    expect((await session(app, token)).authenticated).toBe(false);
  });

  it('a session outlives a restart; a provider removed from auth.yaml ends its sessions', async () => {
    const { app, token } = await as('viewer');
    const same = await restartWithAuth(h, app, { version: 1, providers: [oidcProvider({ issuer: 'http://127.0.0.1:1/' }, { defaultRole: 'viewer' })] });
    expect((await session(same, token)).authenticated).toBe(true);
    const gone = await restartWithAuth(h, same, { version: 1, providers: [] });
    expect((await session(gone, token)).authenticated).toBe(false);
  });

  it('a role changed in auth.yaml applies to live sessions at the next start', async () => {
    const { app, token } = await as('admin');
    const again = await restartWithAuth(h, app, { version: 1, providers: [oidcProvider({ issuer: 'http://127.0.0.1:1/' }, { defaultRole: 'viewer' })] });
    expect((await session(again, token)).user.role).toBe('viewer');
  });
});

describe('a public URL (behind a reverse proxy)', () => {
  const env = { JOB_HOPPER_PUBLIC_URL: 'https://hopper.example.com' };

  it('the sign-in origin is the public URL; its Host is served; /api/ needs a session there', async () => {
    const idp = await oidc();
    const { app } = await start({ version: 1, providers: [oidcProvider(idp, { defaultRole: 'viewer' })] }, env);
    expect((await session(app)).signIn.origin).toBe('https://hopper.example.com');
    const host = 'hopper.example.com';
    expect((await rawRequest(app.url, { path: '/ui/api/session', headers: { host } })).status).toBe(200);
    expect((await rawRequest(app.url, { path: '/api/health', headers: { host } })).status).toBe(401);
    const run = await signIn(app.url, 'https://hopper.example.com', 'corp');
    expect(String(run.start.headers.location)).toContain(encodeURIComponent('https://hopper.example.com/ui/auth/corp/callback'));
    expect((await rawRequest(app.url, { path: '/api/health', headers: { host, 'x-jobhopper-session': run.token! } })).status).toBe(200);
  });

  it('mutations accept the public origin', async () => {
    const idp = await oidc();
    const { app } = await start({ version: 1, providers: [oidcProvider(idp, { defaultRole: 'admin' })] }, env);
    const run = await signIn(app.url, 'https://hopper.example.com', 'corp');
    const res = await app.ui('/ui/api/router-mode', { mode: 'active' }, { token: run.token!, headers: { host: 'hopper.example.com', origin: 'https://hopper.example.com' } });
    expect(res.status).toBe(200);
  });
});

describe('an invalid auth.yaml', () => {
  it('stops the daemon at start, naming the field', async () => {
    await expect(start({ version: 1, providers: [{ name: 'x', type: 'ldap' }] })).rejects.toThrow(/invalid auth\.yaml: providers\.0/);
  });
});
