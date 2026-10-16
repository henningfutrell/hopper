// Identity keyed by email (issue #1380, design.md "Identity keyed by email"): a sign-in whose realm vouches for an email
// signs in as the user of that email. A linked identity is its user, and gives that user its email when the user has none
// and no other user has it. An unlinked identity with the email of a user is linked to that user; with none, it gets a
// new user that keeps the email.
import { describe, expect, it } from 'vitest';
import type { Identity, User } from '../../src/domain/types.ts';
import { userForIdentity } from '../../src/users/identities.ts';

function instance(users: User[] = [], links: [string, string, string][] = []) {
  const all = [...users];
  const linked = new Map(links.map(([realm, subject, id]) => [`${realm}\n${subject}`, id]));
  const lower = (e: string) => e.toLowerCase();
  return {
    all,
    linked,
    users: {
      list: () => all,
      get: (id: string) => all.find((u) => u.id === id),
      byEmail: (email: string) => all.find((u) => u.email !== undefined && lower(u.email) === lower(email)),
      setEmail(id: string, email: string) { const u = all.find((x) => x.id === id)!; u.email = email; },
      add(name: string, email?: string) {
        const u: User = { id: name.toLowerCase(), name, createdAt: '2026-10-15T00:00:00.000Z', workDir: '', secretPrefix: '', ...(email ? { email } : {}) };
        all.push(u);
        return u;
      },
    },
    identities: {
      userOf: (realm: string, subject: string) => linked.get(`${realm}\n${subject}`),
      link(realm: string, subject: string, id: string) { if (!linked.has(`${realm}\n${subject}`)) linked.set(`${realm}\n${subject}`, id); },
    },
  };
}

const user = (id: string, email?: string): User => ({ id, name: id, createdAt: '2026-10-15T00:00:00.000Z', workDir: '', secretPrefix: '', ...(email ? { email } : {}) });
const who = (realm: string, subject: string, email?: string): Identity => ({ realm, subject, username: subject, groups: [], ...(email ? { email } : {}) });

describe('a sign-in is keyed by its verified email (issue #1380)', () => {
  it('a linked identity is its user, and gives it its email when it has none', () => {
    const i = instance([user('octo')], [['github', '42', 'octo']]);
    expect(userForIdentity(i as never, who('github', '42', 'Octo@Example.com'))).toEqual({ user: expect.objectContaining({ id: 'octo' }), added: false });
    expect(i.users.get('octo')?.email).toBe('octo@example.com');
  });

  it('a linked identity keeps the email its user has', () => {
    const i = instance([user('octo', 'octo@example.com')], [['github', '42', 'octo']]);
    userForIdentity(i as never, who('github', '42', 'other@example.com'));
    expect(i.users.get('octo')?.email).toBe('octo@example.com');
  });

  it('an email another user has is not given to a second user', () => {
    const i = instance([user('octo', 'octo@example.com'), user('bea')], [['github', '7', 'bea']]);
    expect(userForIdentity(i as never, who('github', '7', 'octo@example.com')).user.id).toBe('bea');
    expect(i.users.get('bea')?.email).toBeUndefined();
  });

  it('an unlinked identity with the email of a user signs in as that user, and is linked to it', () => {
    const i = instance([user('octo', 'octo@example.com')], [['github', '42', 'octo']]);
    expect(userForIdentity(i as never, who('local-accounts', 'octo@example.com', 'OCTO@example.com'))).toEqual({ user: expect.objectContaining({ id: 'octo' }), added: false });
    expect(i.identities.userOf('local-accounts', 'octo@example.com')).toBe('octo');
    expect(i.all).toHaveLength(1);
  });

  it('an unlinked identity with an email no user has gets a new user that keeps the email', () => {
    const i = instance([user('octo', 'octo@example.com')]);
    const r = userForIdentity(i as never, who('corp', 'sub-ada', 'Ada@Example.com'));
    expect(r.added).toBe(true);
    expect(r.user).toMatchObject({ name: 'sub-ada', email: 'ada@example.com' });
    expect(i.identities.userOf('corp', 'sub-ada')).toBe(r.user.id);
  });

  it('an identity with no email gets a new user with none, as before', () => {
    const i = instance([user('octo', 'octo@example.com')]);
    const r = userForIdentity(i as never, who('corp', 'sub-x'));
    expect(r.added).toBe(true);
    expect(r.user.email).toBeUndefined();
  });
});
