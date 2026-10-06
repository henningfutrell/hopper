// Password sign-in is the fallback (issue #219, design.md "Sign-in: realms"): the sign-in config always
// holds a password realm that is on with an admin account, so the username and password form is always
// offered and nobody depends on a login code or another signed-in browser to get in. A start that finds
// none adds one (`withPasswordFallback`): the account `admin` with a random password, the way Nexus,
// Jenkins and Argo bootstrap their first admin; a change from Settings that would leave none is refused.
import type { StoredAccount, StoredRealm, StoredSignIn } from '../domain/store.ts';

const isFallback = (r: StoredRealm): boolean => r.type === 'password' && r.enabled !== false && (r.users ?? []).some((u) => u.role === 'admin');

/** A password realm that is on has an admin account. */
export const hasPasswordFallback = (s: StoredSignIn): boolean => s.realms.some(isFallback);

/** `base`, else `base-2`, `base-3`, … — the first not in `taken` (any case). */
function free(taken: readonly string[], base: string): string {
  const lower = new Set(taken.map((n) => n.toLowerCase()));
  if (!lower.has(base)) return base;
  for (let n = 2; ; n++) if (!lower.has(`${base}-${n}`)) return `${base}-${n}`;
}

/**
 * The sign-in config with the password fallback added, and the realm and username of the account added;
 * undefined when it has one. The first password realm, turned on, takes the account; with none, a realm
 * `password` is added after the others.
 */
export function withPasswordFallback(current: StoredSignIn, passwordHash: string): { next: StoredSignIn; realm: string; username: string } | undefined {
  if (hasPasswordFallback(current)) return undefined;
  const next = structuredClone(current);
  let realm = next.realms.find((r) => r.type === 'password');
  if (!realm) {
    realm = { name: free(next.realms.map((r) => r.name), 'password'), label: 'Password', type: 'password', users: [] };
    next.realms.push(realm);
  }
  delete realm.enabled;
  const users: StoredAccount[] = realm.users ??= [];
  const username = free(users.map((u) => u.username), 'admin');
  users.push({ username, passwordHash, role: 'admin' });
  return { next, realm: realm.name, username };
}
