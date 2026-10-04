// auth.yaml (design.md "Sign-in: local, OIDC and SAML" — Configuration): absent → local sign-in
// only; every mistake is refused at load, naming the field; secrets may live in their own files.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAuthFile } from '../../src/auth/config.ts';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'jh-auth-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const write = (text: string, name = 'auth.yaml'): string => {
  const p = join(dir, name);
  writeFileSync(p, text, { mode: 0o600 });
  return p;
};

describe('loadAuthFile', () => {
  it('no file: local sign-in only', () => {
    expect(loadAuthFile(join(dir, 'auth.yaml'))).toEqual({ local: { enabled: true }, providers: [] });
  });

  it('reads an OIDC, a GitHub and a SAML provider with their defaults', () => {
    writeFileSync(join(dir, 'secret'), 'from-file\n', { mode: 0o600 });
    writeFileSync(join(dir, 'idp.pem'), '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n', { mode: 0o600 });
    const auth = loadAuthFile(write(`
version: 1
local: { enabled: false }
providers:
  - name: google
    type: oidc
    issuer: https://accounts.google.com
    clientId: id-1
    clientSecretFile: ${join(dir, 'secret')}
    roles: { admin: { emails: [a@example.com] } }
  - name: github
    label: GitHub
    type: github
    clientId: id-2
    clientSecret: inline
    roles: { defaultRole: viewer }
  - name: corp
    type: saml
    entryPoint: https://idp.example.com/sso
    idpCertFile: ${join(dir, 'idp.pem')}
`));
    expect(auth.local.enabled).toBe(false);
    const [g, gh, s] = auth.providers;
    expect(g).toMatchObject({
      name: 'google', label: 'google', type: 'oidc', clientSecret: 'from-file', scopes: ['openid', 'email', 'profile'],
      claims: { email: 'email', username: 'preferred_username', name: 'name', groups: 'groups' }, trustUnverifiedEmail: false,
      roles: { admin: { emails: ['a@example.com'] } },
    });
    expect(gh).toMatchObject({ name: 'github', label: 'GitHub', clientSecret: 'inline', webUrl: 'https://github.com', apiUrl: 'https://api.github.com' });
    expect(s).toMatchObject({ name: 'corp', type: 'saml', idpCert: expect.stringContaining('BEGIN CERTIFICATE'), requireSignedResponse: false, roles: {} });
  });

  it.each([
    ['an unknown type', 'providers: [{ name: x, type: ldap }]', /providers\.0/],
    ['two providers with one name', 'providers: [{ name: x, type: github, clientId: a, clientSecret: b }, { name: x, type: github, clientId: a, clientSecret: b }]', /providers.*twice|unique/i],
    ['a reserved name', 'providers: [{ name: local, type: github, clientId: a, clientSecret: b }]', /providers\.0\.name/],
    ['a name unfit for a URL', 'providers: [{ name: "My IdP", type: github, clientId: a, clientSecret: b }]', /providers\.0\.name/],
    ['both a secret and a secret file', 'providers: [{ name: x, type: github, clientId: a, clientSecret: b, clientSecretFile: /x }]', /clientSecret/],
    ['github without a secret', 'providers: [{ name: x, type: github, clientId: a }]', /clientSecret/],
    ['saml without a certificate', 'providers: [{ name: x, type: saml, entryPoint: "https://idp/sso" }]', /idpCert/],
    ['an unknown field', 'providers: [{ name: x, type: github, clientId: a, clientSecret: b, colour: red }]', /colour|unrecognized/i],
    ['an unknown role', 'providers: [{ name: x, type: github, clientId: a, clientSecret: b, roles: { owner: {} } }]', /owner|unrecognized/i],
    ['a wrong version', 'version: 2', /version/],
  ])('refuses %s, naming the field', (_what, yaml, msg) => {
    expect(() => loadAuthFile(write(`version: 1\n${yaml}`.replace('version: 1\nversion: 2', 'version: 2')))).toThrow(msg);
  });

  it('reads a client secret from an environment variable', () => {
    process.env.JH_TEST_SECRET = 'from-env';
    try {
      const auth = loadAuthFile(write('version: 1\nproviders: [{ name: x, type: github, clientId: a, clientSecretEnv: JH_TEST_SECRET }]'));
      expect(auth.providers[0]).toMatchObject({ clientSecret: 'from-env' });
    } finally {
      delete process.env.JH_TEST_SECRET;
    }
    expect(() => loadAuthFile(write('version: 1\nproviders: [{ name: x, type: github, clientId: a, clientSecretEnv: JH_TEST_UNSET }]'))).toThrow(/JH_TEST_UNSET/);
    expect(() => loadAuthFile(write('version: 1\nproviders: [{ name: x, type: github, clientId: a, clientSecret: b, clientSecretEnv: X }]'))).toThrow(/clientSecret/);
  });

  it('refuses a missing secret file', () => {
    expect(() => loadAuthFile(write('version: 1\nproviders: [{ name: x, type: github, clientId: a, clientSecretFile: /nonexistent/secret }]')))
      .toThrow(/\/nonexistent\/secret/);
  });

  it('an http issuer only on loopback', () => {
    expect(() => loadAuthFile(write('version: 1\nproviders: [{ name: x, type: oidc, issuer: "http://idp.example.com", clientId: a }]'))).toThrow(/https/);
    expect(loadAuthFile(write('version: 1\nproviders: [{ name: x, type: oidc, issuer: "http://127.0.0.1:8080/realms/r", clientId: a }]')).providers).toHaveLength(1);
  });
});
