// Sign-in from the environment (issue #216, docs/sign-in.md "Sign-in from the environment"): a realm,
// the login code and no sign-in can be set up at launch by HOPPER_SIGN_IN_* variables, the way Grafana
// takes its settings — no config file, no volume. A realm is HOPPER_SIGN_IN_REALM_<NAME>_<SETTING>, the
// setting its field path in upper snake case; every value may come from <variable>_FILE instead. At
// each start what the environment sets is applied to the stored sign-in config: its realms replace the
// stored realms of their names, in place, or are added at the end.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applySignInEnvironment, readSignInEnvironment } from '../../src/auth/environment.ts';
import type { StoredSignIn } from '../../src/domain/ports.ts';

const HASH = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0c2FsdA$9b3MzyRk2xr6m1nZQ1kq4cXf3A2c5o8gV7x0Lr0bq0s';

const CORP = {
  HOPPER_SIGN_IN_REALM_CORP_TYPE: 'oidc',
  HOPPER_SIGN_IN_REALM_CORP_LABEL: 'Corp SSO',
  HOPPER_SIGN_IN_REALM_CORP_ISSUER: 'https://idp.example.com',
  HOPPER_SIGN_IN_REALM_CORP_CLIENT_ID: 'hopper',
  HOPPER_SIGN_IN_REALM_CORP_CLIENT_SECRET: 'shh',
};

describe('readSignInEnvironment', () => {
  it('nothing set: nothing to apply', () => {
    expect(readSignInEnvironment({ HOPPER_PORT: '4790', PATH: '/bin' })).toEqual({ realms: [] });
  });

  it('a realm from its variables: every setting its field path in upper snake case, lists split, switches true or false', () => {
    const e = readSignInEnvironment({
      ...CORP,
      HOPPER_SIGN_IN_REALM_CORP_SCOPES: 'openid email groups',
      HOPPER_SIGN_IN_REALM_CORP_CLAIMS_GROUPS: 'roles',
      HOPPER_SIGN_IN_REALM_CORP_TRUST_UNVERIFIED_EMAIL: 'true',
      HOPPER_SIGN_IN_REALM_CORP_ROLES_ADMIN_GROUPS: 'hopper-admins, ops',
      HOPPER_SIGN_IN_REALM_CORP_ROLES_OPERATOR_EMAIL_DOMAINS: 'example.com',
      HOPPER_SIGN_IN_REALM_CORP_ROLES_DEFAULT_ROLE: 'viewer',
    });
    expect(e.realms).toEqual([{
      name: 'corp', label: 'Corp SSO', type: 'oidc', issuer: 'https://idp.example.com', clientId: 'hopper', clientSecret: 'shh',
      scopes: ['openid', 'email', 'groups'], claims: { groups: 'roles' }, trustUnverifiedEmail: true,
      roles: { admin: { groups: ['hopper-admins', 'ops'] }, operator: { emailDomains: ['example.com'] }, defaultRole: 'viewer' },
    }]);
  });

  it('a realm name\'s underscores are dashes; realms come in name order', () => {
    const e = readSignInEnvironment({
      ...CORP,
      HOPPER_SIGN_IN_REALM_ACME_GH_TYPE: 'github', HOPPER_SIGN_IN_REALM_ACME_GH_CLIENT_ID: 'g', HOPPER_SIGN_IN_REALM_ACME_GH_CLIENT_SECRET: 's',
      HOPPER_SIGN_IN_REALM_ACME_GH_ENABLED: 'false',
    });
    expect(e.realms.map((r) => [r.name, r.enabled])).toEqual([['acme-gh', false], ['corp', undefined]]);
  });

  it('every value may come from a mounted file: <variable>_FILE', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sign-in-env-'));
    writeFileSync(join(dir, 'secret'), 'from-file\n');
    writeFileSync(join(dir, 'admin'), 'a long password\n');
    const { HOPPER_SIGN_IN_REALM_CORP_CLIENT_SECRET: _s, ...rest } = CORP;
    const e = readSignInEnvironment({ ...rest, HOPPER_SIGN_IN_REALM_CORP_CLIENT_SECRET_FILE: join(dir, 'secret'), HOPPER_SIGN_IN_ADMIN_PASSWORD_FILE: join(dir, 'admin') });
    expect(e.realms[0]).toMatchObject({ clientSecret: 'from-file' });
    expect(e.adminPassword).toBe('a long password');
  });

  it('an ldap realm with its bind password and nested settings', () => {
    const e = readSignInEnvironment({
      HOPPER_SIGN_IN_REALM_DIR_TYPE: 'ldap', HOPPER_SIGN_IN_REALM_DIR_URL: 'ldaps://ldap.example.com', HOPPER_SIGN_IN_REALM_DIR_START_TLS: 'false',
      HOPPER_SIGN_IN_REALM_DIR_BIND_DN: 'cn=hopper,dc=example,dc=com', HOPPER_SIGN_IN_REALM_DIR_BIND_PASSWORD: 'pw',
      HOPPER_SIGN_IN_REALM_DIR_USER_BASE: 'ou=people,dc=example,dc=com', HOPPER_SIGN_IN_REALM_DIR_ATTRIBUTES_SUBJECT: 'entryUUID',
      HOPPER_SIGN_IN_REALM_DIR_GROUP_SEARCH_BASE: 'ou=groups,dc=example,dc=com',
    });
    expect(e.realms[0]).toEqual({
      name: 'dir', type: 'ldap', url: 'ldaps://ldap.example.com', startTls: false, bindDn: 'cn=hopper,dc=example,dc=com', bindPassword: 'pw',
      userBase: 'ou=people,dc=example,dc=com', attributes: { subject: 'entryUUID' }, groupSearch: { base: 'ou=groups,dc=example,dc=com' },
    });
  });

  it('a role rule\'s values may be a JSON array, for values that hold commas (LDAP group DNs)', () => {
    const e = readSignInEnvironment({
      HOPPER_SIGN_IN_REALM_DIR_TYPE: 'ldap', HOPPER_SIGN_IN_REALM_DIR_URL: 'ldaps://ldap.example.com', HOPPER_SIGN_IN_REALM_DIR_USER_BASE: 'dc=example,dc=com',
      HOPPER_SIGN_IN_REALM_DIR_ROLES_ADMIN_GROUPS: '["cn=admins,dc=example,dc=com", "cn=ops,dc=example,dc=com"]',
    });
    expect(e.realms[0]!.roles).toEqual({ admin: { groups: ['cn=admins,dc=example,dc=com', 'cn=ops,dc=example,dc=com'] } });
    expect(() => readSignInEnvironment({ HOPPER_SIGN_IN_REALM_DIR_TYPE: 'ldap', HOPPER_SIGN_IN_REALM_DIR_ROLES_ADMIN_GROUPS: '[1]' })).toThrow(/ROLES_ADMIN_GROUPS.*JSON array/);
  });

  it('the login code, no sign-in and the first admin\'s password', () => {
    expect(readSignInEnvironment({ HOPPER_SIGN_IN_LOCAL_ENABLED: 'false', HOPPER_SIGN_IN_NONE_ROLE: 'viewer', HOPPER_SIGN_IN_ADMIN_PASSWORD: 'correct horse' }))
      .toEqual({ realms: [], local: false, none: 'viewer', adminPassword: 'correct horse' });
    expect(readSignInEnvironment({ HOPPER_SIGN_IN_NONE_ROLE: 'off' })).toEqual({ realms: [], none: null });
  });

  it.each([
    ['a setting the realm type does not have', { ...CORP, HOPPER_SIGN_IN_REALM_CORP_COLOUR: 'red' }, /HOPPER_SIGN_IN_REALM_CORP_COLOUR/],
    ['a setting of another realm type', { ...CORP, HOPPER_SIGN_IN_REALM_CORP_BIND_DN: 'cn=x' }, /HOPPER_SIGN_IN_REALM_CORP_BIND_DN/],
    ['a realm without its type', { HOPPER_SIGN_IN_REALM_X_ISSUER: 'https://idp' }, /HOPPER_SIGN_IN_REALM_X_ISSUER.*HOPPER_SIGN_IN_REALM_<NAME>_TYPE/],
    ['an unknown type', { HOPPER_SIGN_IN_REALM_X_TYPE: 'kerberos' }, /HOPPER_SIGN_IN_REALM_X_TYPE/],
    ['a value the realm refuses', { ...CORP, HOPPER_SIGN_IN_REALM_CORP_ISSUER: 'http://idp.example.com' }, /HOPPER_SIGN_IN_REALM_CORP_ISSUER.*https/],
    ['a missing setting', { HOPPER_SIGN_IN_REALM_GH_TYPE: 'github', HOPPER_SIGN_IN_REALM_GH_CLIENT_SECRET: 's' }, /HOPPER_SIGN_IN_REALM_GH_CLIENT_ID/],
    ['a switch that is not true or false', { ...CORP, HOPPER_SIGN_IN_REALM_CORP_ENABLED: 'yes' }, /HOPPER_SIGN_IN_REALM_CORP_ENABLED.*true or false/],
    ['an unknown role', { HOPPER_SIGN_IN_NONE_ROLE: 'owner' }, /HOPPER_SIGN_IN_NONE_ROLE/],
    ['a short admin password', { HOPPER_SIGN_IN_ADMIN_PASSWORD: 'short' }, /HOPPER_SIGN_IN_ADMIN_PASSWORD.*8/],
    ['an unknown variable', { HOPPER_SIGN_IN_PROVIDERS: 'x' }, /HOPPER_SIGN_IN_PROVIDERS/],
    ['a value and its file both', { ...CORP, HOPPER_SIGN_IN_REALM_CORP_CLIENT_SECRET_FILE: '/x' }, /HOPPER_SIGN_IN_REALM_CORP_CLIENT_SECRET.*both/],
  ])('refuses %s, naming the variable', (_what, env, msg) => {
    expect(() => readSignInEnvironment(env)).toThrow(msg);
  });
});

describe('applySignInEnvironment', () => {
  const STORED: StoredSignIn = {
    version: 1,
    realms: [
      { name: 'password', label: 'Password', type: 'password', users: [{ username: 'admin', passwordHash: HASH, role: 'admin' }] },
      { name: 'corp', type: 'oidc', issuer: 'https://old.example.com', clientId: 'old', clientSecret: 'old', enabled: false },
      { name: 'dir', type: 'ldap', url: 'ldaps://l', userBase: 'b' },
    ],
  };

  it('an environment realm replaces the stored realm of its name, in its place; a new one is added at the end; the rest stay', () => {
    const env = readSignInEnvironment({ ...CORP, HOPPER_SIGN_IN_REALM_GH_TYPE: 'github', HOPPER_SIGN_IN_REALM_GH_CLIENT_ID: 'g', HOPPER_SIGN_IN_REALM_GH_CLIENT_SECRET: 's' });
    const after = applySignInEnvironment(STORED, env);
    expect(after.realms).toEqual([
      STORED.realms[0],
      { name: 'corp', label: 'Corp SSO', type: 'oidc', issuer: 'https://idp.example.com', clientId: 'hopper', clientSecret: 'shh' },
      STORED.realms[2],
      { name: 'gh', type: 'github', clientId: 'g', clientSecret: 's' },
    ]);
  });

  it('a password realm from the environment keeps its accounts', () => {
    const after = applySignInEnvironment(STORED, readSignInEnvironment({ HOPPER_SIGN_IN_REALM_PASSWORD_TYPE: 'password', HOPPER_SIGN_IN_REALM_PASSWORD_LABEL: 'Accounts' }));
    expect(after.realms[0]).toEqual({ name: 'password', label: 'Accounts', type: 'password', users: STORED.realms[0]!.users });
  });

  it('sets the login code and no sign-in; leaves them when the environment does not say', () => {
    expect(applySignInEnvironment({ ...STORED, none: { role: 'viewer' } }, { realms: [], local: false, none: null })).toEqual({ ...STORED, local: { enabled: false } });
    expect(applySignInEnvironment(STORED, { realms: [], none: 'operator' })).toEqual({ ...STORED, none: { role: 'operator' } });
    expect(applySignInEnvironment(STORED, { realms: [] })).toEqual(STORED);
  });

  it('leaves what it is given as it was', () => {
    const before = structuredClone(STORED);
    applySignInEnvironment(STORED, readSignInEnvironment(CORP));
    expect(STORED).toEqual(before);
  });
});
