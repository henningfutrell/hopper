// auth.yaml (design.md "Sign-in: local, OIDC and SAML" — Configuration): absent → local sign-in
// only; every mistake is refused at load, naming the field; secrets may live in their own files.
import { describe, expect, it } from 'vitest';
import { loadAuthDocument } from '../../src/auth/config.ts';

const ENV: Record<string, string> = { OIDC_SECRET: 'from-env', GH_SECRET: 'gh-env' };
const load = (text: string | undefined, env: Record<string, string> = ENV) => loadAuthDocument(text, (n) => env[n]);

describe('loadAuthDocument', () => {
  it('no document: local sign-in only', () => {
    expect(load(undefined)).toEqual({ local: { enabled: true }, providers: [] });
  });

  it('reads an OIDC, a GitHub and a SAML provider with their defaults', () => {
    const auth = load(`
version: 1
local: { enabled: false }
providers:
  - name: google
    type: oidc
    issuer: https://accounts.google.com
    clientId: id-1
    clientSecretEnv: OIDC_SECRET
    roles: { admin: { emails: [a@example.com] } }
  - name: github
    label: GitHub
    type: github
    clientId: id-2
    clientSecretEnv: GH_SECRET
    roles: { defaultRole: viewer }
  - name: corp
    type: saml
    entryPoint: https://idp.example.com/sso
    idpCert: |
      -----BEGIN CERTIFICATE-----
      MIIB
      -----END CERTIFICATE-----
`);
    expect(auth.local.enabled).toBe(false);
    const [g, gh, s] = auth.providers;
    expect(g).toMatchObject({
      name: 'google', label: 'google', type: 'oidc', clientSecret: 'from-env', scopes: ['openid', 'email', 'profile'],
      claims: { email: 'email', username: 'preferred_username', name: 'name', groups: 'groups' }, trustUnverifiedEmail: false,
      roles: { admin: { emails: ['a@example.com'] } },
    });
    expect(gh).toMatchObject({ name: 'github', label: 'GitHub', clientSecret: 'gh-env', webUrl: 'https://github.com', apiUrl: 'https://api.github.com' });
    expect(s).toMatchObject({ name: 'corp', type: 'saml', idpCert: expect.stringContaining('BEGIN CERTIFICATE'), requireSignedResponse: false, roles: {} });
  });

  it.each([
    ['an unknown type', 'providers: [{ name: x, type: ldap }]', /providers\.0/],
    ['two providers with one name', 'providers: [{ name: x, type: github, clientId: a, clientSecretEnv: GH_SECRET }, { name: x, type: github, clientId: a, clientSecretEnv: GH_SECRET }]', /providers.*twice|unique/i],
    ['a reserved name', 'providers: [{ name: local, type: github, clientId: a, clientSecretEnv: GH_SECRET }]', /providers\.0\.name/],
    ['a name unfit for a URL', 'providers: [{ name: "My IdP", type: github, clientId: a, clientSecretEnv: GH_SECRET }]', /providers\.0\.name/],
    ['an inline secret', 'providers: [{ name: x, type: github, clientId: a, clientSecretEnv: X, clientSecretEnv: GH_SECRET }]', /clientSecret/],
    ['github without a secret', 'providers: [{ name: x, type: github, clientId: a }]', /clientSecretEnv/],
    ['a secret file', 'providers: [{ name: x, type: oidc, issuer: "https://idp", clientId: a, clientSecretFile: /x }]', /clientSecretFile|unrecognized/i],
    ['an IdP certificate file', 'providers: [{ name: x, type: saml, entryPoint: "https://idp/sso", idpCertFile: /x }]', /idpCert/],
    ['saml without a certificate', 'providers: [{ name: x, type: saml, entryPoint: "https://idp/sso" }]', /idpCert/],
    ['an unknown field', 'providers: [{ name: x, type: github, clientId: a, clientSecretEnv: GH_SECRET, colour: red }]', /colour|unrecognized/i],
    ['an unknown role', 'providers: [{ name: x, type: github, clientId: a, clientSecretEnv: GH_SECRET, roles: { owner: {} } }]', /owner|unrecognized/i],
    ['a wrong version', 'version: 2', /version/],
  ])('refuses %s, naming the field', (_what, yaml, msg) => {
    expect(() => load(`version: 1\n${yaml}`.replace('version: 1\nversion: 2', 'version: 2'))).toThrow(msg);
  });

  it('reads a client secret from an environment variable; an unset variable is refused by name', () => {
    expect(load('version: 1\nproviders: [{ name: x, type: github, clientId: a, clientSecretEnv: JH_TEST_SECRET }]', { JH_TEST_SECRET: 'from-env' }).providers[0])
      .toMatchObject({ clientSecret: 'from-env' });
    expect(() => load('version: 1\nproviders: [{ name: x, type: github, clientId: a, clientSecretEnv: JH_TEST_UNSET }]')).toThrow(/JH_TEST_UNSET/);
  });

  it('a public OIDC client needs no secret', () => {
    expect(load('version: 1\nproviders: [{ name: x, type: oidc, issuer: "https://idp", clientId: a }]').providers[0]).not.toHaveProperty('clientSecret');
  });

  it.each(['clientSecret: s', 'clientSecretFile: /x'])('refuses %s in the document', (field) => {
    expect(() => load(`version: 1\nproviders: [{ name: x, type: oidc, issuer: "https://idp", clientId: a, ${field} }]`)).toThrow(/unrecognized|clientSecret/i);
  });

  it('an http issuer only on loopback', () => {
    expect(() => load(('version: 1\nproviders: [{ name: x, type: oidc, issuer: "http://idp.example.com", clientId: a }]'))).toThrow(/https/);
    expect(load(('version: 1\nproviders: [{ name: x, type: oidc, issuer: "http://127.0.0.1:8080/realms/r", clientId: a }]')).providers).toHaveLength(1);
  });
});
