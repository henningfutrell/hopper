// Sign-in through GitHub and SAML (issue #39), end to end through the daemon's HTTP routes against a
// loopback GitHub fake and a SAML IdP signing with a throwaway key.
import { afterEach, describe, expect, it } from 'vitest';
import { rawRequest } from '../support/http.ts';
import { signIn, startGithubFake, startSamlIdp, type GithubFake, type SamlIdp } from '../support/idp.ts';
import { harness, session, startWithAuth, stopAll } from '../support/sign-in-app.ts';

const h = harness();
afterEach(() => stopAll(h));
const start = (auth: unknown, env?: Record<string, string>) => startWithAuth(h, auth, env);

describe('GitHub', () => {
  async function github(): Promise<GithubFake> {
    const gh = await startGithubFake();
    h.stops.push(() => gh.stop());
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
    h.stops.push(() => idp.stop());
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

