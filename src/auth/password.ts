// Password sign-in (design.md "Sign-in" — Password sign-in): auth.yaml holds argon2id hashes, made
// by `hopper password-hash`, checked here through the argon2 library. An unknown username is
// checked against a fixed hash of a random password, so it costs the same time as a wrong password.
import argon2 from 'argon2';
import type { Identity, UiRole } from '../domain/types.ts';
import type { PasswordUser } from './config.ts';

/** argon2id of a random password nobody holds, at the library's default cost (as `hashPassword`). */
const NOBODY = '$argon2id$v=19$m=65536,p=4,t=3$XyDvRoNLpnCNFbBfJvBvkQ$nOVuQgcCGCw60wGMxisLLKwXNgVB/sbEXJWKXxW9ZkY';

export const hashPassword = (password: string): Promise<string> => argon2.hash(password, { type: argon2.argon2id });

const findUser = (users: PasswordUser[], username: string): PasswordUser | undefined =>
  users.find((u) => u.username.toLowerCase() === username.toLowerCase());

/** The identity and role of the account `username` / `password` names, or undefined. */
export async function checkPassword(users: PasswordUser[], username: string, password: string): Promise<{ who: Identity; role: UiRole } | undefined> {
  const user = findUser(users, username);
  let ok: boolean;
  try {
    ok = await argon2.verify(user?.passwordHash ?? NOBODY, password);
  } catch {
    ok = false;
  }
  if (!user || !ok || password === '') return undefined;
  return { who: { provider: 'password', subject: user.username, username: user.username, groups: [] }, role: user.role };
}

/** The role auth.yaml grants this account now; null when it is gone. */
export const passwordRoleOf = (users: PasswordUser[], subject: string): UiRole | null => findUser(users, subject)?.role ?? null;
