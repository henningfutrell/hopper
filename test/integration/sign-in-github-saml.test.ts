// Sign-in through SAML (issue #39), end to end through the daemon's HTTP routes against a SAML IdP
// signing with a throwaway key. GitHub sign-in is the device flow through the hopper's app since issue
// #214: sign-in-device.test.ts.
import { afterEach, describe, expect, it } from 'vitest';
import { rawRequest } from '../support/http.ts';
import { signIn, startSamlIdp, type SamlIdp } from '../support/idp.ts';
import { harness, session, startWithAuth, stopAll } from '../support/sign-in-app.ts';

const h = harness();
afterEach(() => stopAll(h));
const start = (auth: unknown, env?: Record<string, string>) => startWithAuth(h, auth, env);

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

