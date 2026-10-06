// Which user an identity signs in as (issue #158, design.md "Users: one hopper, separate users"): a
// linked identity is its user; an unlinked one — already granted a role by the sign-in config — gets a new
// user of its own, linked. No sign-in is the default admin account; a login code names its user itself.
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

/** The user `who` signs in as: its linked user, admin for no sign-in, else a new user, linked. */
export function userForIdentity(instance: Pick<InstanceStore, 'users' | 'identities'>, who: Identity): { user: User; added: boolean } {
  if (who.realm === 'none') return { user: instance.users.admin(), added: false };
  const linked = instance.identities.userOf(who.realm, who.subject);
  const user = linked === undefined ? undefined : instance.users.get(linked);
  if (user) return { user, added: false };
  const added = instance.users.add(uniqueName(instance.users.list().map((u) => u.name), nameOf(who)));
  instance.identities.link(who.realm, who.subject, added.id);
  return { user: added, added: true };
}
