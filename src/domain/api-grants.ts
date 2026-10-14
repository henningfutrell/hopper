// Grants as the store keeps them (issue #881, design.md "Grants and refresh tokens"), apart from store.ts for its size
// (re-exported there): a grant's body, its refresh tokens' hashes, and the repository over both.
import type { DelegatePolicy } from './delegates.ts';
import type { Identity, UiRole } from './types.ts';

/**
 * A stored grant (issue #881): never a token. `identity`: the minter's, which a sign-in change reconciles as it does a
 * session's. `endsAt` absent: no fixed end. `lastUsedAt`: its last refresh (its mint, before one); `lastUsedFrom`: who
 * sent it, as the sign-in limit counts callers. `delegate`: a delegate approver's (issue #1138), with its approver policy.
 */
export interface ApiGrantRow {
  id: string; userId: string; identity: Identity; label: string; holder?: string; role: UiRole; scopes: string[]; box?: true;
  createdAt: string; endsAt?: string; tokenMinutes?: number; lastUsedAt: string; lastUsedFrom?: string; delegate?: DelegatePolicy;
}

/** A refresh token as stored: its hash, its grant, and when it was rotated (absent: it is the grant's current one). */
export interface RefreshTokenRow { tokenHash: string; grantId: string; issuedAt: string; rotatedAt?: string }

/** Grants and their refresh tokens (issue #881). Which grants have ended is the caller's to decide. */
export interface ApiGrantRepository {
  /** A new grant, with its first refresh token. */
  create(grant: ApiGrantRow, refreshHash: string): void;
  get(id: string): ApiGrantRow | undefined;
  all(): ApiGrantRow[];
  /** The grant's body, replaced. */
  update(grant: ApiGrantRow): void;
  /** The grant and every refresh token of it, gone. */
  drop(id: string): void;
  refreshToken(tokenHash: string): RefreshTokenRow | undefined;
  /** `oldHash` rotated at `at`, and `newHash` its grant's current refresh token: one transaction. */
  rotate(oldHash: string, newHash: string, at: string): void;
  /** The API-token lifetime in minutes the admin set (an instance setting); undefined: never set, the default applies. */
  tokenMinutes(): number | undefined;
  setTokenMinutes(minutes: number): void;
}

