// Editing auth.yaml's realms from the UI (issue #185, design.md "Sign-in: realms"): add or replace one
// realm from its YAML, remove one, move one, turn one on or off, and set local sign-in and no sign-in.
// Comments and everything else in the document are kept; the result is checked by the caller's load.
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { AuthEditError, editAuthDocument, realmsView } from '../../src/auth/edit.ts';

const DOC = `# who signs in
version: 1
local: { enabled: true }
realms:
  # the directory first
  - name: dir
    type: ldap
    url: ldaps://ldap.example.com
    userBase: ou=people,dc=example,dc=com
  - name: google
    label: Google
    type: oidc
    issuer: https://accounts.google.com
    clientId: id-1
`;

const names = (text: string): string[] => (parse(text) as { realms: { name: string }[] }).realms.map((r) => r.name);

describe('editAuthDocument', () => {
  it('adds a realm at the end, from its YAML; comments stay', () => {
    const after = editAuthDocument(DOC, { action: 'save', entry: 'name: corp\ntype: saml\nentryPoint: https://idp/sso\nidpCert: abc\n' });
    expect(names(after)).toEqual(['dir', 'google', 'corp']);
    expect(after).toContain('# who signs in');
    expect(after).toContain('# the directory first');
  });

  it('adds the first realm to a document with none, or to no document', () => {
    expect(names(editAuthDocument('version: 1\n', { action: 'save', entry: 'name: a\ntype: password\nusers: []\n' }))).toEqual(['a']);
    const fresh = editAuthDocument(undefined, { action: 'save', entry: 'name: a\ntype: password\nusers: []\n' });
    expect(parse(fresh)).toEqual({ version: 1, realms: [{ name: 'a', type: 'password', users: [] }] });
  });

  it('replaces a realm in place, by name', () => {
    const after = editAuthDocument(DOC, { action: 'save', name: 'dir', entry: 'name: dir\ntype: ldap\nurl: ldaps://other.example.com\nuserBase: dc=x\n' });
    expect(names(after)).toEqual(['dir', 'google']);
    expect((parse(after) as { realms: { url?: string }[] }).realms[0]!.url).toBe('ldaps://other.example.com');
  });

  it.each([
    ['a new realm under a taken name', { action: 'save', entry: 'name: google\ntype: password\nusers: []\n' }, 400, /google.*already/],
    ['a renamed realm', { action: 'save', name: 'dir', entry: 'name: dir2\ntype: ldap\n' }, 400, /name/],
    ['an entry that is not a mapping', { action: 'save', entry: '- a\n- b\n' }, 400, /mapping|realm/],
    ['an entry that does not parse', { action: 'save', entry: 'name: [\n' }, 400, /YAML|parse|flow/i],
    ['an unknown realm', { action: 'remove', name: 'nope' }, 404, /nope/],
  ] as const)('refuses %s', (_what, edit, status, msg) => {
    try {
      editAuthDocument(DOC, edit);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AuthEditError);
      expect((e as AuthEditError).status).toBe(status);
      expect((e as Error).message).toMatch(msg);
    }
  });

  it('removes a realm', () => {
    expect(names(editAuthDocument(DOC, { action: 'remove', name: 'dir' }))).toEqual(['google']);
  });

  it('moves a realm; the order is the order sign-in tries them and shows them', () => {
    expect(names(editAuthDocument(DOC, { action: 'move', name: 'google', to: 0 }))).toEqual(['google', 'dir']);
    expect(names(editAuthDocument(DOC, { action: 'move', name: 'dir', to: 9 }))).toEqual(['google', 'dir']);
  });

  it('turns a realm off and on: on is the default, so on drops the field', () => {
    const off = editAuthDocument(DOC, { action: 'enable', name: 'google', enabled: false });
    expect((parse(off) as { realms: { enabled?: boolean }[] }).realms[1]!.enabled).toBe(false);
    const on = editAuthDocument(off, { action: 'enable', name: 'google', enabled: true });
    expect((parse(on) as { realms: object[] }).realms[1]).not.toHaveProperty('enabled');
  });

  it('sets local sign-in and no sign-in', () => {
    const after = parse(editAuthDocument(DOC, { action: 'settings', local: false, none: 'viewer' })) as Record<string, unknown>;
    expect(after.local).toEqual({ enabled: false });
    expect(after.none).toEqual({ role: 'viewer' });
    expect(parse(editAuthDocument(DOC, { action: 'settings', none: null }))).not.toHaveProperty('none');
  });
});

describe('realmsView', () => {
  it('each realm as its YAML, in order, with its type and whether it is on', () => {
    const v = realmsView(editAuthDocument(DOC, { action: 'enable', name: 'google', enabled: false }));
    expect(v.realms.map(({ name, label, type, enabled }) => ({ name, label, type, enabled }))).toEqual([
      { name: 'dir', label: 'dir', type: 'ldap', enabled: true },
      { name: 'google', label: 'Google', type: 'oidc', enabled: false },
    ]);
    expect(parse(v.realms[0]!.entry)).toEqual({ name: 'dir', type: 'ldap', url: 'ldaps://ldap.example.com', userBase: 'ou=people,dc=example,dc=com' });
    expect(v).toMatchObject({ local: true, none: null });
  });

  it('no document: no realms, local sign-in on', () => {
    expect(realmsView(undefined)).toEqual({ local: true, none: null, realms: [] });
  });
});
