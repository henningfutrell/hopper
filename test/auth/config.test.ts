// The sign-in config (design.md "Sign-in: realms", issue #185): absent → local sign-in only; `realms` is
// the ordered list of realms, each of a realm type, on unless `enabled: false`; every mistake is refused
// at load, naming the field. A realm's secrets (client secret, bind password) are its own settings,
// stored with it (issue #216), needed only while the realm is on.
import { describe, expect, it } from 'vitest';
import { loadSignInConfig } from '../../src/auth/config.ts';

/** An argon2id PHC string (of "correct horse"). */
const HASH = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0c2FsdA$9b3MzyRk2xr6m1nZQ1kq4cXf3A2c5o8gV7x0Lr0bq0s';

const load = (value: unknown) => loadSignInConfig(value);
/** A sign-in config of version 1 with these realms. */
const realms = (...rs: Record<string, unknown>[]) => ({ version: 1, realms: rs });

const LDAP = { name: 'dir', type: 'ldap', url: 'ldaps://ldap.example.com', userBase: 'ou=people,dc=example,dc=com' };
const GH = { type: 'github', clientId: 'a', clientSecret: 'gh-secret' };
const PW = (users: unknown[], more: Record<string, unknown> = {}) => realms({ name: 'p', type: 'password', users, ...more });

describe('loadSignInConfig', () => {
  it('no config: local sign-in only', () => {
    expect(load(undefined)).toEqual({ local: { enabled: true }, none: null, realms: [] });
  });

  it('reads every realm type, in order, with their defaults', () => {
    const auth = load({
      version: 1,
      local: { enabled: false },
      realms: [
        { name: 'staff', type: 'password', users: [{ username: 'ada', passwordHash: HASH, role: 'operator' }] },
        {
          name: 'dir', type: 'ldap', url: 'ldaps://ldap.example.com', bindDn: 'cn=hopper,dc=example,dc=com', bindPassword: 'bind-pw',
          userBase: 'ou=people,dc=example,dc=com', roles: { admin: { groups: ['cn=admins,dc=example,dc=com'] } },
        },
        {
          name: 'google', type: 'oidc', issuer: 'https://accounts.google.com', clientId: 'id-1', clientSecret: 'oidc-secret',
          roles: { admin: { emails: ['a@example.com'] } },
        },
        { name: 'github', label: 'GitHub', type: 'github', clientId: 'id-2', clientSecret: 'gh-secret', enabled: false, roles: { defaultRole: 'viewer' } },
        {
          name: 'corp', type: 'saml', entryPoint: 'https://idp.example.com/sso',
          idpCert: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n',
        },
      ],
    });
    expect(auth.local.enabled).toBe(false);
    expect(auth.realms.map((r) => [r.name, r.type, r.enabled])).toEqual([
      ['staff', 'password', true], ['dir', 'ldap', true], ['google', 'oidc', true], ['github', 'github', false], ['corp', 'saml', true],
    ]);
    const [pw, dir, g, gh, s] = auth.realms;
    expect(pw).toMatchObject({ label: 'staff', users: [{ username: 'ada', passwordHash: HASH, role: 'operator' }] });
    expect(dir).toMatchObject({
      label: 'dir', url: 'ldaps://ldap.example.com', startTls: false, bindDn: 'cn=hopper,dc=example,dc=com', bindPassword: 'bind-pw',
      userBase: 'ou=people,dc=example,dc=com', userFilter: '(uid={username})',
      attributes: { username: 'uid', email: 'mail', name: 'cn', groups: 'memberOf' },
      roles: { admin: { groups: ['cn=admins,dc=example,dc=com'] } },
    });
    expect(g).toMatchObject({
      label: 'google', clientSecret: 'oidc-secret', scopes: ['openid', 'email', 'profile'],
      claims: { email: 'email', username: 'preferred_username', name: 'name', groups: 'groups' }, trustUnverifiedEmail: false,
    });
    expect(gh).toMatchObject({ label: 'GitHub', clientSecret: 'gh-secret', webUrl: 'https://github.com', apiUrl: 'https://api.github.com' });
    expect(s).toMatchObject({ idpCert: expect.stringContaining('BEGIN CERTIFICATE'), requireSignedResponse: false, roles: {} });
  });

  it.each([
    ['an unknown type', realms({ name: 'x', type: 'kerberos' }), /realms\.0/],
    ['two realms with one name', realms({ name: 'x', ...GH }, { name: 'x', ...GH }), /realms.*twice|unique/i],
    ['a reserved name', realms({ name: 'local', ...GH }), /realms\.0\.name/],
    ['a realm named none', realms({ name: 'none', ...GH }), /realms\.0\.name/],
    ['a name unfit for a URL', realms({ name: 'My IdP', ...GH }), /realms\.0\.name/],
    ['github without a secret', realms({ name: 'x', type: 'github', clientId: 'a' }), /realms\.0\.clientSecret/],
    ['an empty client secret', realms({ name: 'x', type: 'github', clientId: 'a', clientSecret: '' }), /clientSecret/],
    ['a secret file', realms({ name: 'x', type: 'oidc', issuer: 'https://idp', clientId: 'a', clientSecretFile: '/x' }), /clientSecretFile|unrecognized/i],
    ['an IdP certificate file', realms({ name: 'x', type: 'saml', entryPoint: 'https://idp/sso', idpCertFile: '/x' }), /idpCert/],
    ['saml without a certificate', realms({ name: 'x', type: 'saml', entryPoint: 'https://idp/sso' }), /idpCert/],
    ['an unknown field', realms({ name: 'x', ...GH, colour: 'red' }), /colour|unrecognized/i],
    ['an unknown role', realms({ name: 'x', ...GH, roles: { owner: {} } }), /owner|unrecognized/i],
    ['the old providers list', { version: 1, providers: [] }, /providers|unrecognized/i],
    ['the old password section', { version: 1, password: { users: [] } }, /password|unrecognized/i],
    ['a gateway realm checking JWTs with no audience', realms({ name: 'x', type: 'gateway', issuer: 'https://idp' }), /realms\.0\.audience/],
    ['a gateway realm introspecting with no client', realms({ name: 'x', type: 'gateway', issuer: 'https://idp', check: 'introspection', clientSecret: 'oidc-secret' }), /realms\.0\.clientId/],
    ['a gateway realm introspecting with no client secret', realms({ name: 'x', type: 'gateway', issuer: 'https://idp', check: 'introspection', clientId: 'a' }), /realms\.0\.clientSecret/],
    ['a gateway realm with a plain-http issuer', realms({ name: 'x', type: 'gateway', issuer: 'http://idp.example.com', audience: ['h'] }), /realms\.0\.issuer/],
    ['a wrong version', { version: 2 }, /version/],
  ])('refuses %s, naming the field', (_what, value, msg) => {
    expect(() => load(value)).toThrow(msg);
  });

  it('a gateway realm (issue #215): checks JWTs by default, the token in authorization; the header named lowercase', () => {
    expect(load(realms({ name: 'edge', type: 'gateway', issuer: 'https://idp.example.com', audience: ['hopper'] })).realms[0]).toMatchObject({
      type: 'gateway', check: 'jwt', header: 'authorization', audience: ['hopper'], trustUnverifiedEmail: false,
      claims: { email: 'email', username: 'preferred_username', name: 'name', groups: 'groups' },
    });
    expect(load(realms({
      name: 'edge', type: 'gateway', issuer: 'https://idp.example.com', check: 'introspection', clientId: 'hopper', clientSecret: 'oidc-secret', header: 'X-Forwarded-Access-Token',
    })).realms[0]).toMatchObject({ check: 'introspection', clientId: 'hopper', clientSecret: 'oidc-secret', header: 'x-forwarded-access-token' });
  });

  it('names the field in an error that starts "invalid sign-in config: "', () => {
    expect(() => load({ version: 2 })).toThrow(/^invalid sign-in config: version/);
  });

  it('a client secret is the realm\'s own setting, as stored', () => {
    expect(load(realms({ name: 'x', type: 'github', clientId: 'a', clientSecret: 'stored' })).realms[0]).toMatchObject({ clientSecret: 'stored' });
  });

  it('a public OIDC client needs no secret', () => {
    expect(load(realms({ name: 'x', type: 'oidc', issuer: 'https://idp', clientId: 'a' })).realms[0]).not.toHaveProperty('clientSecret');
  });

  it.each(['clientSecretEnv', 'clientSecretFile'])('refuses %s: a secret is no longer named, it is stored', (field) => {
    expect(() => load(realms({ name: 'x', type: 'oidc', issuer: 'https://idp', clientId: 'a', [field]: 's' }))).toThrow(/unrecognized|clientSecret/i);
  });

  it('no sign-in: absent is off; `none.role` is the role everyone gets', () => {
    expect(load({ version: 1 }).none).toBeNull();
    expect(load({ version: 1, none: { role: 'viewer' } }).none).toEqual({ role: 'viewer' });
    expect(() => load({ version: 1, none: { role: 'owner' } })).toThrow(/none\.role/);
    expect(() => load({ version: 1, none: {} })).toThrow(/none\.role/);
  });

  it.each([
    ['a plaintext password', PW([{ username: 'ada', passwordHash: 'hunter2', role: 'admin' }]), /realms\.0\.users\.0\.passwordHash/],
    ['a bcrypt hash', PW([{ username: 'ada', passwordHash: '$2b$10$abcdefghijklmnopqrstuv', role: 'admin' }]), /passwordHash/],
    ['a user named twice', PW([{ username: 'ada', passwordHash: HASH, role: 'admin' }, { username: 'ADA', passwordHash: HASH, role: 'viewer' }]), /ada.*twice|unique/i],
    ['a user without a role', PW([{ username: 'ada', passwordHash: HASH }]), /role/],
    ['role rules on a password realm', PW([], { roles: { defaultRole: 'admin' } }), /roles|unrecognized/i],
  ])('a password realm refuses %s', (_what, value, msg) => {
    expect(() => load(value)).toThrow(msg);
  });

  it.each([
    ['plain ldap to another host', realms({ ...LDAP, url: 'ldap://ldap.example.com' }), /realms\.0\.url/],
    ['an http URL', realms({ ...LDAP, url: 'https://ldap.example.com' }), /realms\.0\.url/],
    ['a bind password variable', realms({ ...LDAP, bindDn: 'cn=x', bindPasswordEnv: 'S' }), /bindPasswordEnv|unrecognized/i],
    ['a bind DN without its password', realms({ ...LDAP, bindDn: 'cn=x' }), /realms\.0\.bindPassword/],
    ['a user filter without {username}', realms({ ...LDAP, userFilter: '(uid=ada)' }), /userFilter/],
    ['no user base', realms({ name: 'dir', type: 'ldap', url: 'ldaps://ldap.example.com' }), /userBase/],
  ])('an ldap realm refuses %s', (_what, value, msg) => {
    expect(() => load(value)).toThrow(msg);
  });

  it('an ldap realm: plain ldap with StartTLS, or to loopback; a group search', () => {
    const r = load(realms({ ...LDAP, url: 'ldap://ldap.example.com', startTls: true, groupSearch: { base: 'ou=groups,dc=example,dc=com' } })).realms[0];
    expect(r).toMatchObject({ startTls: true, groupSearch: { base: 'ou=groups,dc=example,dc=com', filter: '(member={dn})', name: 'cn' } });
    expect(load(realms({ ...LDAP, url: 'ldap://127.0.0.1:3389' })).realms).toHaveLength(1);
  });

  it('an http issuer only on loopback', () => {
    expect(() => load({ version: 1, realms: [{ name: 'x', type: 'oidc', issuer: 'http://idp.example.com', clientId: 'a' }] })).toThrow(/https/);
    expect(load({ version: 1, realms: [{ name: 'x', type: 'oidc', issuer: 'http://127.0.0.1:8080/realms/r', clientId: 'a' }] }).realms).toHaveLength(1);
  });

  it('a realm that is off still has to be valid, but its secret need not be set yet', () => {
    expect(load({ version: 1, realms: [{ name: 'x', type: 'github', clientId: 'a', enabled: false }] }).realms[0]).toMatchObject({ enabled: false });
    expect(load(realms({ ...LDAP, bindDn: 'cn=x', enabled: false })).realms[0]).toMatchObject({ enabled: false });
    expect(() => load({ version: 1, realms: [{ name: 'x', type: 'github', enabled: false }] })).toThrow(/clientId/);
  });
});
