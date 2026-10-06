// Sign-in through GitHub and SAML (issue #39), end to end through the daemon's HTTP routes against a
// loopback GitHub fake and a SAML IdP signing with a throwaway key.
import { afterEach, describe, expect, it } from 'vitest';
import { rawRequest } from '../support/http.ts';
import { signIn, startGithubFake, startSamlIdp, type GithubFake, type SamlIdp } from '../support/idp.ts';
import { harness, restartSame, restartWithAuth, session, startWithAuth, stopAll } from '../support/sign-in-app.ts';

const h = harness();
afterEach(() => stopAll(h));
const start = (auth: unknown, env?: Record<string, string>) => startWithAuth(h, auth, env);

describe('GitHub', () => {
  async function github(): Promise<GithubFake> {
    const gh = await startGithubFake();
    h.stops.push(() => gh.stop());
    return gh;
  }
  const ghRealm = (gh: GithubFake, roles: unknown) => ({ name: 'github', label: 'GitHub', type: 'github', clientId: 'gh-id', clientSecret: 'gh-secret', webUrl: gh.url, apiUrl: gh.url, roles });
  /** Someone else signs in with GitHub first (and becomes admin, issue #239); then the fake answers as octo again. */
  async function firstSomeoneElse(gh: GithubFake, url: string, origin: string): Promise<void> {
    const octo = gh.user;
    gh.user = { id: 1, login: 'first', name: 'First' };
    expect((await signIn(url, origin, 'github')).callback?.status).toBe(200);
    gh.user = octo;
  }

  it('signs in by username; asks for no org scope when no rule names groups', async () => {
    const gh = await github();
    const { app, origin } = await start({ version: 1, realms: [ghRealm(gh, { admin: { usernames: ['octo'] } })] });
    const run = await signIn(app.url, origin, 'github');
    expect(await session(app, run.token)).toMatchObject({ user: { role: 'admin', realm: 'github', name: 'octo', identity: 'Octo Cat' } });
    expect(gh.lastScope).toBe('read:user user:email');
  });

  it('teams are groups as org/team; the primary verified email counts', async () => {
    const gh = await github();
    gh.teams.push({ slug: 'ops', organization: { login: 'acme' } });
    const { app, origin } = await start({ version: 1, realms: [ghRealm(gh, { operator: { groups: ['acme/ops'] }, viewer: { emails: ['octo@example.com'] } })] });
    await firstSomeoneElse(gh, app.url, origin);
    const run = await signIn(app.url, origin, 'github');
    expect((await session(app, run.token)).user.role).toBe('operator');
    expect(gh.lastScope).toContain('read:org');
  });

  it('an unverified primary email grants nothing', async () => {
    const gh = await github();
    gh.emails[0]!.verified = false;
    const { app, origin } = await start({ version: 1, realms: [ghRealm(gh, { admin: { emails: ['octo@example.com'] } })] });
    await firstSomeoneElse(gh, app.url, origin);
    expect((await signIn(app.url, origin, 'github')).callback?.status).toBe(403);
  });
});

describe('the first person to sign in with GitHub becomes admin (issue #239)', () => {
  async function github(): Promise<GithubFake> {
    const gh = await startGithubFake();
    h.stops.push(() => gh.stop());
    return gh;
  }
  const ghRealm = (gh: GithubFake, roles: unknown) => ({ name: 'github', label: 'GitHub', type: 'github', clientId: 'gh-id', clientSecret: 'gh-secret', webUrl: gh.url, apiUrl: gh.url, roles });
  const originOf = (app: { url: string }): string => `http://localhost:${new URL(app.url).port}`;

  it('the first is admin though no role rule names them; the next gets what the rules grant', async () => {
    const gh = await github();
    const { app, origin } = await start({ version: 1, realms: [ghRealm(gh, {})] });
    const first = await signIn(app.url, origin, 'github');
    expect(await session(app, first.token)).toMatchObject({ user: { role: 'admin', realm: 'github', name: 'octo' } });
    expect(app.app.auth().githubAdmin).toEqual({ realm: 'github', subject: '4242' });
    gh.user = { id: 7, login: 'second', name: 'Second' };
    expect((await signIn(app.url, origin, 'github')).callback?.status).toBe(403);
  });

  it('stays admin after a restart, and signing in again keeps it', async () => {
    const gh = await github();
    const { app, origin } = await start({ version: 1, realms: [ghRealm(gh, { defaultRole: 'viewer' })] });
    await signIn(app.url, origin, 'github');
    gh.user = { id: 7, login: 'second', name: 'Second' };
    expect((await session(app, (await signIn(app.url, origin, 'github')).token)).user.role).toBe('viewer');
    const again = await restartSame(h, app);
    gh.user = { id: 4242, login: 'octo', name: 'Octo Cat' };
    expect((await session(again, (await signIn(again.url, originOf(again), 'github')).token)).user.role).toBe('admin');
  });

  it('a hopper where someone signed in with GitHub before makes nobody admin', async () => {
    const gh = await github();
    const auth = { version: 1, realms: [ghRealm(gh, { defaultRole: 'viewer' })] };
    const { app, origin } = await start(auth);
    await signIn(app.url, origin, 'github');
    // As a hopper from before the rule: the GitHub sign-in is linked, no first GitHub admin recorded.
    const again = await restartWithAuth(h, app, auth);
    gh.user = { id: 7, login: 'second', name: 'Second' };
    expect((await session(again, (await signIn(again.url, originOf(again), 'github')).token)).user.role).toBe('viewer');
    expect(again.app.auth().githubAdmin).toBeNull();
  });
});

describe('SAML', () => {
  function samlIdp(): SamlIdp {
    const idp = startSamlIdp();
    h.stops.push(() => idp.stop());
    return idp;
  }
  const samlRealm = (idp: SamlIdp, roles: unknown) => ({ name: 'corp-saml', label: 'Corp SAML', type: 'saml', entryPoint: idp.entryPoint, idpCert: idp.cert, idpIssuer: idp.issuer, roles });

  it('signs in with a signed assertion; attributes give email, name and groups', async () => {
    const idp = samlIdp();
    const { app, origin } = await start({ version: 1, realms: [samlRealm(idp, { operator: { groups: ['ops'] } })] });
    const run = await signIn(app.url, origin, 'corp-saml', {
      saml: (url) => idp.respond(url, { nameID: 'ada@example.com', attributes: { email: 'ada@example.com', displayName: 'Ada', groups: ['ops', 'dev'] } }),
    });
    expect(run.callback?.status).toBe(200);
    expect(await session(app, run.token)).toMatchObject({ user: { role: 'operator', realm: 'corp-saml', name: 'ada@example.com', identity: 'Ada' } });
  });

  it('an assertion signed by another key is refused', async () => {
    const idp = samlIdp();
    const { app, origin } = await start({ version: 1, realms: [samlRealm(idp, { defaultRole: 'admin' })] });
    const run = await signIn(app.url, origin, 'corp-saml', { saml: (url) => idp.respond(url, { nameID: 'ada', signedWith: 'other' }) });
    expect(run.callback?.status).toBe(502);
    expect(run.token).toBeUndefined();
  });

  it('a tampered assertion is refused', async () => {
    const idp = samlIdp();
    const { app, origin } = await start({ version: 1, realms: [samlRealm(idp, { admin: { subjects: ['root'] } })] });
    const run = await signIn(app.url, origin, 'corp-saml', {
      saml: (url) => idp.respond(url, { nameID: 'ada', tamper: (x) => x.replace('>ada</saml:NameID>', '>root</saml:NameID>') }),
    });
    expect(run.callback?.status).toBe(502);
  });

  it('serves the service provider metadata with the callback as assertion consumer service', async () => {
    const idp = samlIdp();
    const { app, origin, host } = await start({ version: 1, realms: [samlRealm(idp, { defaultRole: 'viewer' })] });
    const res = await rawRequest(app.url, { path: '/ui/auth/corp-saml/metadata', headers: { host } });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/xml/);
    expect(res.text).toContain(`entityID="${origin}/ui/auth/corp-saml/metadata"`);
    expect(res.text).toContain(`Location="${origin}/ui/auth/corp-saml/callback"`);
  });
});

