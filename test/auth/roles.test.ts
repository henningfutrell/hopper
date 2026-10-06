// The role a signed-in identity gets (design.md "Sign-in: none, password, local, OIDC and SAML" — Roles): the same
// rules for every identity provider; the highest matching role wins; no match is no session.
import { describe, expect, it } from 'vitest';
import { roleFor } from '../../src/auth/roles.ts';
import type { Identity } from '../../src/domain/types.ts';

const who = (o: Partial<Identity> = {}): Identity => ({ realm: 'corp', subject: 's-1', groups: [], ...o });

describe('roleFor', () => {
  it('no rules and no default role: no role', () => {
    expect(roleFor(who(), {})).toBeNull();
  });

  it('the default role when nothing matches', () => {
    expect(roleFor(who(), { defaultRole: 'viewer' })).toBe('viewer');
  });

  it('matches by subject, username, email, email domain and group', () => {
    expect(roleFor(who({ subject: 'abc' }), { operator: { subjects: ['abc'] } })).toBe('operator');
    expect(roleFor(who({ username: 'Octo' }), { admin: { usernames: ['octo'] } })).toBe('admin');
    expect(roleFor(who({ email: 'A@Example.com' }), { admin: { emails: ['a@example.com'] } })).toBe('admin');
    expect(roleFor(who({ email: 'b@example.com' }), { viewer: { emailDomains: ['EXAMPLE.com'] } })).toBe('viewer');
    expect(roleFor(who({ groups: ['ops', 'dev'] }), { operator: { groups: ['dev'] } })).toBe('operator');
  });

  it('groups and subjects compare exactly', () => {
    expect(roleFor(who({ groups: ['Dev'] }), { operator: { groups: ['dev'] } })).toBeNull();
    expect(roleFor(who({ subject: 'ABC' }), { operator: { subjects: ['abc'] } })).toBeNull();
  });

  it('an email domain matches the whole domain after @, not a suffix', () => {
    expect(roleFor(who({ email: 'x@evilexample.com' }), { viewer: { emailDomains: ['example.com'] } })).toBeNull();
    expect(roleFor(who({ email: 'x@sub.example.com' }), { viewer: { emailDomains: ['example.com'] } })).toBeNull();
  });

  it('the highest matching role wins, over the default too', () => {
    const rules = { viewer: { emailDomains: ['example.com'] }, admin: { groups: ['admins'] }, defaultRole: 'viewer' as const };
    expect(roleFor(who({ email: 'a@example.com', groups: ['admins'] }), rules)).toBe('admin');
    expect(roleFor(who({ email: 'a@example.com' }), { ...rules, operator: { emailDomains: ['example.com'] } })).toBe('operator');
  });

  it('an identity without an email never matches an email rule', () => {
    expect(roleFor(who(), { admin: { emails: [''], emailDomains: [''] } })).toBeNull();
  });
});
