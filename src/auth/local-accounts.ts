// Local accounts (issue #1380, design.md "Local accounts"): the hopper's own sign-in, an email and a password, for a
// hopper with no identity provider and for its first admin. The accounts (`local_accounts`) hold scrypt hashes made by
// Node's crypto (OpenSSL's scrypt), never the password. Their realm is `local-accounts`, a reserved realm name: the
// subject of its identities is the account's email, lowercase. An unknown email is checked against a fixed hash, so it
// costs the same time as a wrong password. The account's own role is the role it signs in with.
import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { z } from 'zod';
import type { LocalAccount, LocalAccountRepository } from '../domain/ports.ts';
import type { Identity, UiRole } from '../domain/types.ts';
import type { FormRealm } from './realm.ts';

/** The local accounts sign-in reads: the role of each is its own. */
export type LocalAccounts = Pick<LocalAccountRepository, 'get' | 'list'>;

/** The realm local accounts sign in through; no realm of the sign-in config may take its name. */
export const LOCAL_ACCOUNTS_REALM = 'local-accounts';
export const LOCAL_ACCOUNTS_LABEL = 'Local accounts';

/** A password: long enough to resist guessing, short enough that hashing it costs nothing extra. */
export const passwordSchema = z.string().min(12, 'must be at least 12 characters').max(1024);
/** An account's email, lowercase. */
export const accountEmail = z.email().max(320).transform((e) => e.toLowerCase());

// OWASP's scrypt floor is N=2^17, r=8, p=1 at 128 MiB; N=2^16 keeps each check at 64 MiB on a small box.
const N = 2 ** 16, R = 8, P = 1, KEY = 32;
const options = (n: number, r: number, p: number): ScryptOptions => ({ N: n, r, p, maxmem: 256 * n * r });

const derive = (password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> =>
  new Promise((resolve, reject) => scrypt(password.normalize('NFC'), salt, KEY, options(n, r, p), (e, key) => (e ? reject(e) : resolve(key))));

/** `scrypt$<N>$<r>$<p>$<salt>$<key>`, salt and key base64url. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${(await derive(password, salt, N, R, P)).toString('base64url')}`;
}

/** Whether `password` is the one `hash` was made from; a hash that does not parse is no match. */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  const parts = hash.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt' || password === '') return false;
  const [n, r, p] = parts.slice(1, 4).map(Number) as [number, number, number];
  if (![n, r, p].every((x) => Number.isInteger(x) && x > 0) || n > 2 ** 20) return false;
  const want = Buffer.from(parts[5]!, 'base64url');
  try {
    const got = await derive(password, Buffer.from(parts[4]!, 'base64url'), n, r, p);
    return got.length === want.length && timingSafeEqual(got, want);
  } catch {
    return false;
  }
}

/** The hash an unknown email is checked against: of a random password nobody holds, made once. */
let nobody: Promise<string> | undefined;

/** The identity a local account signs in as. */
export const accountIdentity = (a: Pick<LocalAccount, 'email'>): Identity =>
  ({ realm: LOCAL_ACCOUNTS_REALM, subject: a.email, email: a.email, username: a.email, groups: [] });

/** The form realm of the local accounts: tried first, and only while there is an account. */
export function createLocalAccountsRealm(accounts: Pick<LocalAccountRepository, 'get'>): FormRealm {
  return {
    name: LOCAL_ACCOUNTS_REALM, label: LOCAL_ACCOUNTS_LABEL,
    async check(username, password) {
      const account = accountEmail.safeParse(username.trim()).success ? accounts.get(username.trim()) : undefined;
      const ok = await verifyPassword(account?.passwordHash ?? await (nobody ??= hashPassword(randomBytes(32).toString('hex'))), password);
      if (!account || !ok) return { ok: false };
      return { ok: true, who: accountIdentity(account), role: account.role };
    },
  };
}

/** The role a local account's identity signs in with now; null when the account is gone. */
export const localAccountRole = (accounts: Pick<LocalAccountRepository, 'get'>, who: Pick<Identity, 'realm' | 'subject'>): UiRole | null =>
  (who.realm === LOCAL_ACCOUNTS_REALM ? accounts.get(who.subject)?.role ?? null : null);
