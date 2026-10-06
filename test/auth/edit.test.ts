// Changing the sign-in config from the UI (issues #185, #198, #200, design.md "Sign-in: realms"): add or
// replace one realm from its fields, remove one, move one, turn one on or off, set the login code and
// no sign-in. Whether the result loads is the caller's check (loadSignInConfig), so one schema decides.
import { describe, expect, it } from 'vitest';
import { AuthEditError, editSignIn, realmsView } from '../../src/auth/edit.ts';
import type { StoredSignIn } from '../../src/domain/ports.ts';

const SIGN_IN: StoredSignIn = {
  version: 1,
  local: { enabled: true },
  realms: [
    { name: 'dir', type: 'ldap', url: 'ldaps://ldap.example.com', userBase: 'ou=people,dc=example,dc=com' },
    { name: 'google', label: 'Google', type: 'oidc', issuer: 'https://accounts.google.com', clientId: 'id-1', clientSecret: 'oidc-secret' },
    { name: 'staff', type: 'saml', entryPoint: 'https://idp.example.com/sso', idpCert: 'abc' },
  ],
};

const names = (s: StoredSignIn): string[] => s.realms.map((r) => r.name);

function refused(edit: Parameters<typeof editSignIn>[1], status: number, msg: RegExp): void {
  try {
    editSignIn(SIGN_IN, edit);
    expect.unreachable();
  } catch (e) {
    expect(e).toBeInstanceOf(AuthEditError);
    expect((e as AuthEditError).status).toBe(status);
    expect((e as Error).message).toMatch(msg);
  }
}

describe('editSignIn: realms', () => {
  it('adds a realm at the end, from its fields', () => {
    const after = editSignIn(SIGN_IN, { action: 'save', realm: { name: 'corp', type: 'saml', entryPoint: 'https://idp/sso', idpCert: 'abc' } });
    expect(names(after)).toEqual(['dir', 'google', 'staff', 'corp']);
    expect(after.realms[3]).toEqual({ name: 'corp', type: 'saml', entryPoint: 'https://idp/sso', idpCert: 'abc' });
  });

  it('replaces a realm in place, by name; whether it is on stays', () => {
    const off = editSignIn(SIGN_IN, { action: 'enable', name: 'dir', enabled: false });
    const after = editSignIn(off, { action: 'save', name: 'dir', realm: { name: 'dir', type: 'ldap', url: 'ldaps://other.example.com', userBase: 'dc=x' } });
    expect(names(after)).toEqual(['dir', 'google', 'staff']);
    expect(after.realms[0]).toEqual({ name: 'dir', type: 'ldap', enabled: false, url: 'ldaps://other.example.com', userBase: 'dc=x' });
  });

  it.each([
    ['a new realm under a taken name', { action: 'save', realm: { name: 'google', type: 'saml' } }, 400, /google.*already/],
    ['a renamed realm', { action: 'save', name: 'dir', realm: { name: 'dir2', type: 'ldap' } }, 400, /name/],
    ['an unknown realm', { action: 'remove', name: 'nope' }, 404, /nope/],
  ] as const)('refuses %s', (_what, edit, status, msg) => refused(edit, status, msg));

  it('removes a realm', () => {
    expect(names(editSignIn(SIGN_IN, { action: 'remove', name: 'dir' }))).toEqual(['google', 'staff']);
  });

  it('moves a realm; the order is the order sign-in tries them and shows them', () => {
    expect(names(editSignIn(SIGN_IN, { action: 'move', name: 'google', to: 0 }))).toEqual(['google', 'dir', 'staff']);
    expect(names(editSignIn(SIGN_IN, { action: 'move', name: 'dir', to: 9 }))).toEqual(['google', 'staff', 'dir']);
  });

  it('turns a realm off and on: on is the default, so on drops the field', () => {
    const off = editSignIn(SIGN_IN, { action: 'enable', name: 'google', enabled: false });
    expect(off.realms[1]!.enabled).toBe(false);
    expect(editSignIn(off, { action: 'enable', name: 'google', enabled: true }).realms[1]).not.toHaveProperty('enabled');
  });

  it('sets the login code and no sign-in', () => {
    const after = editSignIn(SIGN_IN, { action: 'settings', local: false, none: 'viewer' });
    expect(after.local).toEqual({ enabled: false });
    expect(after.none).toEqual({ role: 'viewer' });
    expect(editSignIn(after, { action: 'settings', none: null })).not.toHaveProperty('none');
  });

  it('changes nothing it was given', () => {
    const before = structuredClone(SIGN_IN);
    editSignIn(SIGN_IN, { action: 'remove', name: 'dir' });
    editSignIn(SIGN_IN, { action: 'enable', name: 'google', enabled: false });
    expect(SIGN_IN).toEqual(before);
  });
});

describe('editSignIn: a realm\'s secrets (issue #216)', () => {
  const google = (s: StoredSignIn) => s.realms.find((r) => r.name === 'google')!;
  const save = (realm: Record<string, unknown>) => editSignIn(SIGN_IN, { action: 'save', name: 'google', realm: { name: 'google', type: 'oidc', issuer: 'https://accounts.google.com', clientId: 'id-2', ...realm } });

  it('a save without the secret keeps the stored one: the form never holds it', () => {
    expect(google(save({}))).toEqual({ name: 'google', type: 'oidc', issuer: 'https://accounts.google.com', clientId: 'id-2', clientSecret: 'oidc-secret' });
  });

  it('a save with a secret replaces it; null removes it', () => {
    expect(google(save({ clientSecret: 'new' })).clientSecret).toBe('new');
    expect(google(save({ clientSecret: null }))).not.toHaveProperty('clientSecret');
  });

  it('a new realm stores the secret it is given', () => {
    const after = editSignIn(SIGN_IN, { action: 'save', realm: { name: 'corp2', type: 'oidc', issuer: 'https://idp', clientId: 'g', clientSecret: 'oidc-secret' } });
    expect(after.realms[3]).toEqual({ name: 'corp2', type: 'oidc', issuer: 'https://idp', clientId: 'g', clientSecret: 'oidc-secret' });
  });

  it('an ldap realm keeps its bind password only while it has a bind DN', () => {
    const withDn = editSignIn(SIGN_IN, { action: 'save', name: 'dir', realm: { name: 'dir', type: 'ldap', url: 'ldaps://l', userBase: 'b', bindDn: 'cn=x', bindPassword: 'pw' } });
    const kept = editSignIn(withDn, { action: 'save', name: 'dir', realm: { name: 'dir', type: 'ldap', url: 'ldaps://l', userBase: 'b', bindDn: 'cn=y' } });
    expect(kept.realms[0]).toMatchObject({ bindDn: 'cn=y', bindPassword: 'pw' });
    const anonymous = editSignIn(withDn, { action: 'save', name: 'dir', realm: { name: 'dir', type: 'ldap', url: 'ldaps://l', userBase: 'b' } });
    expect(anonymous.realms[0]).not.toHaveProperty('bindPassword');
  });
});

describe('realmsView', () => {
  it('never shows a secret: it names the ones that are set', () => {
    const v = realmsView(SIGN_IN);
    expect(v.realms[1]).toEqual({ name: 'google', label: 'Google', type: 'oidc', enabled: true, settings: { issuer: 'https://accounts.google.com', clientId: 'id-1' }, secrets: ['clientSecret'] });
    expect(v.realms[0]).toMatchObject({ secrets: [] });
    expect(JSON.stringify(v)).not.toContain('oidc-secret');
  });

  it('each realm with its settings, in order, its type and whether it is on', () => {
    const v = realmsView(editSignIn(SIGN_IN, { action: 'enable', name: 'google', enabled: false }));
    expect(v.realms).toEqual([
      { name: 'dir', label: 'dir', type: 'ldap', enabled: true, settings: { url: 'ldaps://ldap.example.com', userBase: 'ou=people,dc=example,dc=com' }, secrets: [] },
      { name: 'google', label: 'Google', type: 'oidc', enabled: false, settings: { issuer: 'https://accounts.google.com', clientId: 'id-1' }, secrets: ['clientSecret'] },
      { name: 'staff', label: 'staff', type: 'saml', enabled: true, settings: { entryPoint: 'https://idp.example.com/sso', idpCert: 'abc' }, secrets: [] },
    ]);
    expect(v).toMatchObject({ local: true, none: null });
  });
});
