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
