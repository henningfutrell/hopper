// The lane pool keys the hopper issues (issue #1454): their repository, a port of the instance store (store.ts).

/**
 * The lane pool keys the hopper issues (issue #1454, design.md "Lane pods of another release"): only each key's SHA-256,
 * with its user and when it was issued. At most one per user: a new one replaces it. Never spent, as the install's key.
 */
export interface LanePoolKeyRepository {
  /** `keyHash` is now `userId`'s key, in place of any key it had. */
  replace(keyHash: string, userId: string, issuedAt: string): void;
  /** The user of the key with this hash; undefined when none is. */
  userOf(keyHash: string): string | undefined;
  /** When `userId`'s key was issued; undefined when it has none. */
  issuedAt(userId: string): string | undefined;
  /** `userId`'s key is gone. False when it had none. */
  remove(userId: string): boolean;
}
