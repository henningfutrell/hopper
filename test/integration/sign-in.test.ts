// Sign-in through identity providers (issue #39, design.md "Sign-in: local, OIDC and SAML"), end to
// end through the daemon's HTTP routes against loopback IdPs: OIDC, GitHub, SAML. Roles, sessions
// and logout are the same whichever provider signed the user in.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { rawRequest } from '../support/http.ts';
import { signIn, startGithubFake, startOidcIdp, startSamlIdp, type GithubFake, type OidcIdp, type SamlIdp } from '../support/idp.ts';

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;
const stops: (() => unknown)[] = [];
afterEach(async () => {
  await t?.stop();
  t = undefined;
  for (const s of stops.splice(0)) await s();
  cleanup?.();
});

async function start(auth: unknown, env: Record<string, string> = {}): Promise<{ app: TestApp; origin: string; host: string }> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  const file = join(db.dbPath, '..', 'auth.yaml');
  if (auth !== undefined) writeFileSync(file, stringify(auth), { mode: 0o600 });
  t = await startTestApp({ dbPath: db.dbPath, env: { JOB_HOPPER_AUTH_FILE: file, ...env } });
  const port = new URL(t.url).port;
  return { app: t, origin: `http://localhost:${port}`, host: `localhost:${port}` };
}

const session = async (app: TestApp, token?: string) => JSON.parse((await rawRequest(app.url, {
  path: '/ui/api/session', headers: token ? { 'x-jobhopper-session': token } : {},
})).text);

async function oidc(o: { claims?: Record<string, unknown>; userinfo?: Record<string, unknown> } = {}): Promise<OidcIdp> {
  const idp = await startOidcIdp();
  stops.push(() => idp.stop());
  Object.assign(idp.claims, o.claims);
  Object.assign(idp.userinfo, o.userinfo);
  return idp;
}
const oidcProvider = (idp: OidcIdp, roles: unknown, extra: Record<string, unknown> = {}) =>
  ({ name: 'corp', label: 'Corp SSO', type: 'oidc', issuer: idp.issuer, clientId: 'hopper', clientSecret: 'shh', roles, ...extra });

describe('no auth.yaml: local sign-in only', () => {
  it('the session view offers the login code and no providers', async () => {
    const { app, origin } = await start(undefined);
    expect(await session(app)).toEqual({ authenticated: false, signIn: { local: true, origin, providers: [] } });
  });

  it('the login code signs in as admin, provider local', async () => {
    const { app } = await start(undefined);
    const token = await app.login();
    expect(await session(app, token)).toMatchObject({ authenticated: true, expiresAt: expect.any(String), user: { role: 'admin', provider: 'local', name: 'login code' } });
  });
});

describe('local sign-in turned off', () => {
  it('no login code file, POST /ui/login refused, no device link', async () => {
    const { app } = await start({ version: 1, local: { enabled: false } });
    expect((await session(app)).signIn.local).toBe(false);
    await expect(app.login()).rejects.toThrow();
    const res = await rawRequest(app.url, { method: 'POST', path: '/ui/login', body: 'code=x', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(res.status).toBe(403);
  });
});

describe('OIDC', () => {
  it('signs in with a verified email granted a role; the session names the user', async () => {
    const idp = await oidc({ claims: { email: 'ada@example.com', email_verified: true, name: 'Ada' } });
    const { app, origin } = await start({ version: 1, providers: [oidcProvider(idp, { operator: { emails: ['ada@example.com'] } })] });
    expect((await session(app)).signIn.providers).toEqual([{ name: 'corp', label: 'Corp SSO', type: 'oidc' }]);
    const run = await signIn(app.url, origin, 'corp');
    expect(run.start.status).toBe(302);
    expect(run.callback?.status).toBe(200);
    expect(run.complete?.status).toBe(200);
    expect(await session(app, run.token)).toMatchObject({ authenticated: true, user: { role: 'operator', provider: 'corp', name: 'Ada' } });
  });

  it('groups from userinfo grant a role', async () => {
    const idp = await oidc({ userinfo: { groups: ['hopper-admins'] } });
    const { app, origin } = await start({ version: 1, providers: [oidcProvider(idp, { admin: { groups: ['hopper-admins'] } })] });
    const run = await signIn(app.url, origin, 'corp');
    expect((await session(app, run.token)).user.role).toBe('admin');
  });

  it('an unverified email grants nothing unless the provider trusts it', async () => {
    const idp = await oidc({ claims: { email: 'ada@example.com' } });
    const { app, origin } = await start({ version: 1, providers: [oidcProvider(idp, { admin: { emails: ['ada@example.com'] } })] });
    const run = await signIn(app.url, origin, 'corp');
    expect(run.callback?.status).toBe(403);
    expect(run.callback?.text).toMatch(/no role/);
    expect(run.token).toBeUndefined();
  });

  it('trustUnverifiedEmail counts the email', async () => {
    const idp = await oidc({ claims: { email: 'ada@example.com' } });
    const { app, origin } = await start({ version: 1, providers: [oidcProvider(idp, { admin: { emails: ['ada@example.com'] } }, { trustUnverifiedEmail: true })] });
    expect((await session(app, (await signIn(app.url, origin, 'corp')).token)).user.role).toBe('admin');
  });

  it('no matching rule and no default role: signed in at the provider, but no session', async () => {
    const idp = await oidc();
    const { app, origin } = await start({ version: 1, providers: [oidcProvider(idp, {})] });
    const run = await signIn(app.url, origin, 'corp');
    expect(run.callback?.status).toBe(403);
    expect(run.complete).toBeUndefined();
  });

  it('the default role lets every signed-in account in', async () => {
    const idp = await oidc();
    const { app, origin } = await start({ version: 1, providers: [oidcProvider(idp, { defaultRole: 'viewer' })] });
    expect((await session(app, (await signIn(app.url, origin, 'corp')).token)).user).toMatchObject({ role: 'viewer', name: 'johndoe' });
  });

  it('a callback completed by another browser (other binding) signs nobody in', async () => {
    const idp = await oidc();
    const { app, origin } = await start({ version: 1, providers: [oidcProvider(idp, { defaultRole: 'admin' })] });
    const run = await signIn(app.url, origin, 'corp', { completeBinding: 'b'.repeat(40) });
    expect(run.callback?.status).toBe(200);
    expect(run.complete?.status).toBe(403);
    expect(run.token).toBeUndefined();
  });

  it('a callback with an unknown state is refused', async () => {
    const idp = await oidc();
    const { app, host } = await start({ version: 1, providers: [oidcProvider(idp, { defaultRole: 'admin' })] });
    const res = await rawRequest(app.url, { path: '/ui/auth/corp/callback?code=x&state=nope', headers: { host } });
    expect(res.status).toBe(400);
  });

  it('a ticket works once', async () => {
    const idp = await oidc();
    const { app, origin, host } = await start({ version: 1, providers: [oidcProvider(idp, { defaultRole: 'admin' })] });
    const binding = 'a'.repeat(40);
    const run = await signIn(app.url, origin, 'corp', { binding });
    expect(run.token).toBeDefined();
    const again = await rawRequest(app.url, { method: 'POST', path: '/ui/auth/complete', body: run.complete ? JSON.stringify({ ticket: /'([0-9a-f]{64})'/.exec(run.callback!.text)![1], binding }) : '{}',
      headers: { host, origin, 'content-type': 'application/json' } });
    expect(again.status).toBe(403);
  });

  it('completing from another origin is refused', async () => {
    const idp = await oidc();
    const { app, origin, host } = await start({ version: 1, providers: [oidcProvider(idp, { defaultRole: 'admin' })] });
    const binding = 'c'.repeat(40);
    const run = await signIn(app.url, origin, 'corp', { binding, completeBinding: 'd'.repeat(40) });
    const ticket = /'([0-9a-f]{64})'/.exec(run.callback!.text)![1];
    const res = await rawRequest(app.url, { method: 'POST', path: '/ui/auth/complete', body: JSON.stringify({ ticket, binding }),
      headers: { host, origin: 'http://evil.example', 'content-type': 'application/json' } });
    expect(res.status).toBe(403);
  });

  it('start without a binding, or for an unknown provider, is refused', async () => {
    const idp = await oidc();
    const { app, host } = await start({ version: 1, providers: [oidcProvider(idp, { defaultRole: 'admin' })] });
    expect((await rawRequest(app.url, { path: '/ui/auth/corp/start', headers: { host } })).status).toBe(400);
    expect((await rawRequest(app.url, { path: `/ui/auth/nope/start?binding=${'a'.repeat(40)}`, headers: { host } })).status).toBe(404);
  });

  it('start on another origin than the sign-in origin is refused (the binding would not come back)', async () => {
    const idp = await oidc();
    const { app } = await start({ version: 1, providers: [oidcProvider(idp, { defaultRole: 'admin' })] });
    const res = await rawRequest(app.url, { path: `/ui/auth/corp/start?binding=${'a'.repeat(40)}` });
    expect(res.status).toBe(409);
    expect(res.text).toMatch(/localhost/);
  });
});

describe('GitHub', () => {
  async function github(): Promise<GithubFake> {
    const gh = await startGithubFake();
    stops.push(() => gh.stop());
    return gh;
  }
  const ghProvider = (gh: GithubFake, roles: unknown) => ({ name: 'github', label: 'GitHub', type: 'github', clientId: 'gh-id', clientSecret: 'gh-secret', webUrl: gh.url, apiUrl: gh.url, roles });

  it('signs in by username; asks for no org scope when no rule names groups', async () => {
    const gh = await github();
    const { app, origin } = await start({ version: 1, providers: [ghProvider(gh, { admin: { usernames: ['octo'] } })] });
    const run = await signIn(app.url, origin, 'github');
    expect(await session(app, run.token)).toMatchObject({ user: { role: 'admin', provider: 'github', name: 'Octo Cat' } });
    expect(gh.lastScope).toBe('read:user user:email');
  });

  it('teams are groups as org/team; the primary verified email counts', async () => {
    const gh = await github();
    gh.teams.push({ slug: 'ops', organization: { login: 'acme' } });
    const { app, origin } = await start({ version: 1, providers: [ghProvider(gh, { operator: { groups: ['acme/ops'] }, viewer: { emails: ['octo@example.com'] } })] });
    const run = await signIn(app.url, origin, 'github');
    expect((await session(app, run.token)).user.role).toBe('operator');
    expect(gh.lastScope).toContain('read:org');
  });

  it('an unverified primary email grants nothing', async () => {
    const gh = await github();
    gh.emails[0]!.verified = false;
    const { app, origin } = await start({ version: 1, providers: [ghProvider(gh, { admin: { emails: ['octo@example.com'] } })] });
    expect((await signIn(app.url, origin, 'github')).callback?.status).toBe(403);
  });
});

describe('SAML', () => {
  function samlIdp(): SamlIdp {
    const idp = startSamlIdp();
    stops.push(() => idp.stop());
    return idp;
  }
  const samlProvider = (idp: SamlIdp, roles: unknown) => ({ name: 'corp-saml', label: 'Corp SAML', type: 'saml', entryPoint: idp.entryPoint, idpCert: idp.cert, idpIssuer: idp.issuer, roles });

  it('signs in with a signed assertion; attributes give email, name and groups', async () => {
    const idp = samlIdp();
    const { app, origin } = await start({ version: 1, providers: [samlProvider(idp, { operator: { groups: ['ops'] } })] });
    const run = await signIn(app.url, origin, 'corp-saml', {
      saml: (url) => idp.respond(url, { nameID: 'ada@example.com', attributes: { email: 'ada@example.com', displayName: 'Ada', groups: ['ops', 'dev'] } }),
    });
    expect(run.callback?.status).toBe(200);
    expect(await session(app, run.token)).toMatchObject({ user: { role: 'operator', provider: 'corp-saml', name: 'Ada' } });
  });

  it('an assertion signed by another key is refused', async () => {
    const idp = samlIdp();
    const { app, origin } = await start({ version: 1, providers: [samlProvider(idp, { defaultRole: 'admin' })] });
    const run = await signIn(app.url, origin, 'corp-saml', { saml: (url) => idp.respond(url, { nameID: 'ada', signedWith: 'other' }) });
    expect(run.callback?.status).toBe(502);
    expect(run.token).toBeUndefined();
  });

  it('a tampered assertion is refused', async () => {
    const idp = samlIdp();
    const { app, origin } = await start({ version: 1, providers: [samlProvider(idp, { admin: { subjects: ['root'] } })] });
    const run = await signIn(app.url, origin, 'corp-saml', {
      saml: (url) => idp.respond(url, { nameID: 'ada', tamper: (x) => x.replace('>ada</saml:NameID>', '>root</saml:NameID>') }),
    });
    expect(run.callback?.status).toBe(502);
  });

  it('serves the service provider metadata with the callback as assertion consumer service', async () => {
    const idp = samlIdp();
    const { app, origin, host } = await start({ version: 1, providers: [samlProvider(idp, { defaultRole: 'viewer' })] });
    const res = await rawRequest(app.url, { path: '/ui/auth/corp-saml/metadata', headers: { host } });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/xml/);
    expect(res.text).toContain(`entityID="${origin}/ui/auth/corp-saml/metadata"`);
    expect(res.text).toContain(`Location="${origin}/ui/auth/corp-saml/callback"`);
  });
});

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
    const file = app.app.config.authFile;
    await app.stop();
    t = await startTestApp({ dbPath: app.dbPath, env: { JOB_HOPPER_AUTH_FILE: file } });
    expect((await session(t, token)).authenticated).toBe(true);
    await t.stop();
    writeFileSync(file, stringify({ version: 1, providers: [] }), { mode: 0o600 });
    t = await startTestApp({ dbPath: app.dbPath, env: { JOB_HOPPER_AUTH_FILE: file } });
    expect((await session(t, token)).authenticated).toBe(false);
  });

  it('a role changed in auth.yaml applies to live sessions at the next start', async () => {
    const { app, token } = await as('admin');
    const file = app.app.config.authFile;
    const doc = { version: 1, providers: [{ ...oidcProvider({ issuer: 'http://127.0.0.1:1/' } as OidcIdp, { defaultRole: 'viewer' }) }] };
    await app.stop();
    writeFileSync(file, stringify(doc), { mode: 0o600 });
    t = await startTestApp({ dbPath: app.dbPath, env: { JOB_HOPPER_AUTH_FILE: file } });
    expect((await session(t, token)).user.role).toBe('viewer');
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
