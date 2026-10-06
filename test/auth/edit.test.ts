// Editing the sign-in config's realms from the UI (issue #185, design.md "Sign-in: realms"): add or
// replace one realm from its JSON, remove one, move one, turn one on or off, and set local sign-in and no
// sign-in. Everything else in the config is kept; the result is checked by the caller's load.
import { describe, expect, it } from 'vitest';
import { AuthEditError, editSignInConfig, realmsView } from '../../src/auth/edit.ts';

const DOC = { version: 1, local: { enabled: true }, realms: [{ name: 'dir', type: 'ldap', url: 'ldaps://ldap.example.com', userBase: 'ou=people,dc=example,dc=com' }, { name: 'google', label: 'Google', type: 'oidc', issuer: 'https://accounts.google.com', clientId: 'id-1' }] };

type Config = { realms: Record<string, unknown>[] } & Record<string, unknown>;
const names = (value: unknown): string[] => (value as Config).realms.map((r) => r.name as string);
const json = (x: unknown): string => JSON.stringify(x);

describe('editSignInConfig', () => {
  it('adds a realm at the end, from its JSON; everything else stays', () => {
    const after = editSignInConfig(DOC, { action: 'save', entry: json({ name: 'corp', type: 'saml', entryPoint: 'https://idp/sso', idpCert: 'abc' }) });
    expect(names(after)).toEqual(['dir', 'google', 'corp']);
    expect(after).toMatchObject({ version: 1, local: { enabled: true }, realms: [DOC.realms[0], DOC.realms[1], { name: 'corp' }] });
  });

  it('leaves the config it was given as it was', () => {
    const before = structuredClone(DOC);
    editSignInConfig(DOC, { action: 'remove', name: 'dir' });
    expect(DOC).toEqual(before);
  });

  it('adds the first realm to a config with none, or to no config', () => {
    expect(names(editSignInConfig({ version: 1 }, { action: 'save', entry: json({ name: 'a', type: 'password', users: [] }) }))).toEqual(['a']);
    const fresh = editSignInConfig(undefined, { action: 'save', entry: json({ name: 'a', type: 'password', users: [] }) });
    expect(fresh).toEqual({ version: 1, realms: [{ name: 'a', type: 'password', users: [] }] });
  });

  it('replaces a realm in place, by name', () => {
    const after = editSignInConfig(DOC, { action: 'save', name: 'dir', entry: json({ name: 'dir', type: 'ldap', url: 'ldaps://other.example.com', userBase: 'dc=x' }) });
    expect(names(after)).toEqual(['dir', 'google']);
    expect((after as Config).realms[0]!.url).toBe('ldaps://other.example.com');
  });

  it.each([
    ['a new realm under a taken name', { action: 'save', entry: json({ name: 'google', type: 'password', users: [] }) }, 400, /google.*already/],
    ['a renamed realm', { action: 'save', name: 'dir', entry: json({ name: 'dir2', type: 'ldap' }) }, 400, /name/],
    ['an entry that is not an object', { action: 'save', entry: '["a", "b"]' }, 400, /a realm is an object: name, type and its settings/],
    ['an entry that is not JSON', { action: 'save', entry: '{ "name": [' }, 400, /^the realm is not valid JSON: /],
    ['an entry in YAML', { action: 'save', entry: 'name: corp\ntype: saml\n' }, 400, /^the realm is not valid JSON: /],
    ['an unknown realm', { action: 'remove', name: 'nope' }, 404, /nope/],
  ] as const)('refuses %s', (_what, edit, status, msg) => {
    try {
      editSignInConfig(DOC, edit);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AuthEditError);
      expect((e as AuthEditError).status).toBe(status);
      expect((e as Error).message).toMatch(msg);
    }
  });

  it('removes a realm', () => {
    expect(names(editSignInConfig(DOC, { action: 'remove', name: 'dir' }))).toEqual(['google']);
  });

  it('moves a realm; the order is the order sign-in tries them and shows them', () => {
    expect(names(editSignInConfig(DOC, { action: 'move', name: 'google', to: 0 }))).toEqual(['google', 'dir']);
    expect(names(editSignInConfig(DOC, { action: 'move', name: 'dir', to: 9 }))).toEqual(['google', 'dir']);
  });

  it('turns a realm off and on: on is the default, so on drops the field', () => {
    const off = editSignInConfig(DOC, { action: 'enable', name: 'google', enabled: false });
    expect((off as Config).realms[1]!.enabled).toBe(false);
    const on = editSignInConfig(off, { action: 'enable', name: 'google', enabled: true });
    expect((on as Config).realms[1]).not.toHaveProperty('enabled');
  });

  it('sets local sign-in and no sign-in', () => {
    const after = editSignInConfig(DOC, { action: 'settings', local: false, none: 'viewer' });
    expect(after.local).toEqual({ enabled: false });
    expect(after.none).toEqual({ role: 'viewer' });
    expect(editSignInConfig(DOC, { action: 'settings', none: null })).not.toHaveProperty('none');
  });
});

describe('realmsView', () => {
  it('each realm as its JSON, in order, with its type and whether it is on', () => {
    const v = realmsView(editSignInConfig(DOC, { action: 'enable', name: 'google', enabled: false }));
    expect(v.realms.map(({ name, label, type, enabled }) => ({ name, label, type, enabled }))).toEqual([
      { name: 'dir', label: 'dir', type: 'ldap', enabled: true },
      { name: 'google', label: 'Google', type: 'oidc', enabled: false },
    ]);
    expect(v.realms[0]!.entry).toBe(JSON.stringify(DOC.realms[0], null, 2));
    expect(v).toMatchObject({ local: true, none: null });
  });

  it('no config: no realms, local sign-in on', () => {
    expect(realmsView(undefined)).toEqual({ local: true, none: null, realms: [] });
  });
});
