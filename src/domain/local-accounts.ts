// Local accounts (issue #1380, design.md "Local accounts"): the hopper's own email and password sign-in. Re-exported from ports.ts.
import type { UiRole } from './sign-in.ts';

/**
 * A local account (issue #1380, design.md "Local accounts"): the hopper's own sign-in, keyed by its email (lowercase); a
 * scrypt hash of its password, never the password; the role it signs in with.
 */
export interface LocalAccount { email: string; passwordHash: string; role: UiRole; createdAt: string }

/** The local accounts (`local_accounts`, issue #1380). */
export interface LocalAccountRepository {
  list(): LocalAccount[];
  get(email: string): LocalAccount | undefined;
  /** Add the account, or replace the one of its email. */
  put(account: LocalAccount): void;
  /** False when there was none. */
  remove(email: string): boolean;
}

/**
 * A local account's passkey (issue #1380, design.md "Passkeys for local accounts"): a WebAuthn credential the account
 * added, which signs it in in place of its password. Its id is the credential id (base64url); `publicKey` the COSE
 * public key (base64url), never a secret; `rpId` the host name it was added at, the only one it signs in at;
 * `counter` the authenticator's signature counter as last seen.
 */
export interface LocalAccountPasskey {
  id: string; email: string; rpId: string; publicKey: string; counter: number; transports: string[]; name: string;
  createdAt: string; lastUsedAt?: string;
}

/** The local accounts' passkeys (`local_account_passkeys`, issue #1380); an account's removal removes its passkeys. */
export interface LocalAccountPasskeyRepository {
  /** The account's passkeys, oldest first. */
  list(email: string): LocalAccountPasskey[];
  get(id: string): LocalAccountPasskey | undefined;
  /** Add the passkey, or replace the one of its id (its counter and last use). */
  put(passkey: LocalAccountPasskey): void;
  /** False when the account has no passkey of that id. */
  remove(email: string, id: string): boolean;
  /** Whether any account has a passkey: the landing page offers passkey sign-in then. */
  any(): boolean;
}
