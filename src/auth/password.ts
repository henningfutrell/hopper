// The password realm (design.md "Sign-in: realms"): its accounts (`password_accounts`) hold argon2id
// hashes, made by `hashPassword` when an admin sets a password in Settings → Sign-in, checked here
// through the argon2 library. An unknown username is checked
// against a fixed hash of a random password, so it costs the same time as a wrong password.
import argon2 from 'argon2';
import type { UiRole } from '../domain/types.ts';
import type { PasswordRealmConfig, PasswordUser } from './config.ts';
import type { FormRealm } from './realm.ts';

/** argon2id of a random password nobody holds, at the library's default cost (as `hashPassword`). */
const NOBODY = '$argon2id$v=19$m=65536,p=4,t=3$XyDvRoNLpnCNFbBfJvBvkQ$nOVuQgcCGCw60wGMxisLLKwXNgVB/sbEXJWKXxW9ZkY';

export const hashPassword = (password: string): Promise<string> => argon2.hash(password, { type: argon2.argon2id });

const findUser = (users: PasswordUser[], username: string): PasswordUser | undefined =>
  users.find((u) => u.username.toLowerCase() === username.toLowerCase());

export function createPasswordRealm(c: PasswordRealmConfig): FormRealm {
  return {
    name: c.name, label: c.label, type: 'password',
    async check(username, password) {
      const user = findUser(c.users, username);
      let ok: boolean;
      try {
        ok = await argon2.verify(user?.passwordHash ?? NOBODY, password);
      } catch {
        ok = false;
      }
      if (!user || !ok || password === '') return { ok: false };
      return { ok: true, who: { realm: c.name, subject: user.username, username: user.username, groups: [] }, role: user.role };
    },
  };
}

/** The role the realm grants this account now; null when it is gone. */
export const passwordRoleOf = (c: PasswordRealmConfig, subject: string): UiRole | null => findUser(c.users, subject)?.role ?? null;
