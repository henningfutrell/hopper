// A gateway realm's identity (issue #2996): the username claim falls back when an access token leaves it out, and a
// refusal names the values the role rules match on, with the claim the username came from.
import { describe, expect, it } from 'vitest';
import { gatewayIdentity, type ClaimNames } from '../../src/auth/realm.ts';
import { matchedOn } from '../../src/auth/roles.ts';

const NAMES: ClaimNames = { email: 'email', username: 'preferred_username', name: 'name', groups: 'groups' };
const of = (claims: Record<string, unknown>, names = NAMES, trust = false) => gatewayIdentity('edge', 'ada-1', claims, names, trust);

describe('the username of a gateway identity', () => {
  it('is the configured claim when the token has it', () => {
    expect(of({ preferred_username: 'ada', username: 'other', email: 'x@example.com', email_verified: true }))
      .toEqual({ who: expect.objectContaining({ username: 'ada' }), usernameClaim: 'preferred_username' });
  });

  it('falls back to the username claim when the configured one is missing', () => {
    expect(of({ username: 'ada', email: 'x@example.com', email_verified: true })).toEqual({ who: expect.objectContaining({ username: 'ada' }), usernameClaim: 'username' });
  });

  it('then to the local part of the email the realm vouches for', () => {
    expect(of({ email: 'ada.l@example.com', email_verified: true })).toEqual({ who: expect.objectContaining({ username: 'ada.l' }), usernameClaim: 'email (local part)' });
    expect(of({ email: 'ada.l@example.com' }, NAMES, true)).toMatchObject({ who: { username: 'ada.l' }, usernameClaim: 'email (local part)' });
  });

  it('never from an email the realm does not vouch for, nor from none', () => {
    expect(of({ email: 'ada@example.com' })).toEqual({ who: { realm: 'edge', subject: 'ada-1', groups: [] } });
    expect(of({})).toEqual({ who: { realm: 'edge', subject: 'ada-1', groups: [] } });
  });

  it('follows a configured claim of another name, and its fallbacks after it', () => {
    const names = { ...NAMES, username: 'upn' };
    expect(of({ upn: 'ada@corp' }, names)).toMatchObject({ who: { username: 'ada@corp' }, usernameClaim: 'upn' });
    expect(of({ username: 'ada' }, names)).toMatchObject({ who: { username: 'ada' }, usernameClaim: 'username' });
  });
});

describe('what a refusal names', () => {
  it('the subject, the username with its claim, the email and the groups', () => {
    const { who, usernameClaim } = of({ username: 'ada', email: 'ada@example.com', email_verified: true, groups: ['devs', 'ops'] });
    expect(matchedOn(who, usernameClaim)).toBe('subject "ada-1", username "ada" (from username), email "ada@example.com", groups "devs", "ops"');
  });

  it('none for each value the identity lacks', () => {
    expect(matchedOn({ realm: 'edge', subject: 'ada-1', groups: [] })).toBe('subject "ada-1", username none, email none, groups none');
  });
});
