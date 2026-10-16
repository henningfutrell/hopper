// Which user an identity signs in as (issue #158, design.md "Users: one hopper, separate users"): a
// linked identity is its user; an unlinked one — already granted a role by the sign-in config — gets a new
// user of its own, linked. No sign-in is one identity like the others: its first visitor makes its user,
// everyone after signs in as that user (issue #238); a login code names its user itself.
//
// Identity keyed by email (issue #1380, design.md "Identity keyed by email"): a user keeps the verified email it is known
// by. An unlinked identity whose realm vouches for that email signs in as that user, from any realm, and is linked to it:
// so a person who signed in with GitHub keeps their user, and GitHub as its source, when they sign in with a local
// account or single sign-on of the same email. A linked identity gives its user its email when the user has none and no
// other user has it.
import type { InstanceStore } from '../domain/ports.ts';
import type { Identity, User } from '../domain/types.ts';

/** The name a new user takes from its identity: username, else name, else email, else subject. */
const nameOf = (who: Identity): string => (who.username ?? who.name ?? who.email ?? who.subject).trim() || who.subject;

/** `base`, else `base 2`, `base 3`, … — the first name no user has. */
export function uniqueName(taken: readonly string[], base: string): string {
  const lower = new Set(taken.map((n) => n.toLowerCase()));
  if (!lower.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) if (!lower.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`;
}

type Users = Pick<InstanceStore['users'], 'list' | 'get' | 'add' | 'byEmail' | 'setEmail'>;

/** The user `who` signs in as: its linked user, else the user of its email, else a new user, linked. */
export function userForIdentity(instance: { users: Users; identities: Pick<InstanceStore['identities'], 'userOf' | 'link'> }, who: Identity): { user: User; added: boolean } {
  const email = who.email?.trim().toLowerCase() || undefined;
  const linked = instance.identities.userOf(who.realm, who.subject);
  const user = linked === undefined ? undefined : instance.users.get(linked);
  if (user) {
    if (email && user.email === undefined && !instance.users.byEmail(email)) {
      instance.users.setEmail(user.id, email);
      return { user: { ...user, email }, added: false };
    }
    return { user, added: false };
  }
  const known = email === undefined ? undefined : instance.users.byEmail(email);
  if (known) {
    instance.identities.link(who.realm, who.subject, known.id);
    return { user: known, added: false };
  }
  const added = instance.users.add(uniqueName(instance.users.list().map((u) => u.name), nameOf(who)), email);
  instance.identities.link(who.realm, who.subject, added.id);
  return { user: added, added: true };
}
