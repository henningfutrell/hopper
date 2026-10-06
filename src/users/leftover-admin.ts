// The leftover default admin account (issue #265, design.md "The leftover default admin account"): on a
// hopper from before issue #238, the user `admin` stays beside the user the first GitHub admin (#239)
// signs in as. It is no longer applicable: at start, before any user's runtime, it is folded into that
// user — the real account — and is gone. Everything it held is theirs, as #220 moved `owner`'s to `admin`.
import type { InstanceStore } from '../domain/ports.ts';
import { ADMIN_ID } from '../domain/types.ts';

type Instance = Pick<InstanceStore, 'users' | 'identities' | 'signInConfig' | 'userStore'>;

/** Fold `admin` into the first GitHub admin's user, when both are there and not the same; what was folded, else undefined. */
export function foldLeftoverAdmin(instance: Instance): { from: string; into: string } | undefined {
  const admin = instance.users.get(ADMIN_ID);
  const first = instance.signInConfig.read().githubAdmin;
  if (!admin || !first) return undefined;
  const into = instance.identities.userOf(first.realm, first.subject);
  const real = into === undefined ? undefined : instance.users.get(into);
  if (!real || real.id === ADMIN_ID) return undefined;
  // Both user schemas on the latest tenant version first, as every start does when it opens them.
  for (const user of [admin, real]) instance.userStore(user).close();
  instance.users.fold(ADMIN_ID, real.id);
  return { from: ADMIN_ID, into: real.id };
}
