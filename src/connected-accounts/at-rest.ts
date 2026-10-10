// A connected account at rest (issue #441, design.md "Keeping the connection"): its access and refresh
// tokens sealed under the master key HOPPER_MASTER_KEY (the token box), so a dump or backup of the database holds no
// usable GitHub token. Without the key (the hopper is limited, issue #659) no token is kept: none is ever kept in
// clear. A row kept in clear before #441 still reads, and is sealed by the renewer's next look; so is a row an older key sealed
// (HOPPER_MASTER_KEY_PREVIOUS, issue #514). A sealed row the runtime cannot open (no key, or another one)
// reads as unreadable, never as connected nor ended, and says to give the key back: connecting again would
// mint another GitHub grant toward GitHub's ten per user and app, and leave this one alive.
import type { ConnectedAccount, UserStore } from '../domain/ports.ts';
import type { ConnectedAccountProvider } from '../domain/types.ts';
import { isSealed, PREVIOUS_KEYS_VARIABLE, MASTER_KEY_VARIABLE, type TokenBox } from '../secrets/token-box.ts';
import type { Grant } from './device-flow.ts';
import type { AccountIdentity } from './identity.ts';

export const PROVIDER_NAME: Record<ConnectedAccountProvider, string> = { github: 'GitHub' };

/** The stored row, and the account with its tokens opened — or why they cannot be. */
export type Read = { stored: ConnectedAccount; account: ConnectedAccount } | { stored: ConnectedAccount; unreadable: string };

/** What to do about tokens the runtime cannot open: the key back, never a new sign-in. */
export const GIVE_THE_KEY = `give the hopper the key it was sealed under — as ${MASTER_KEY_VARIABLE}, or as ${PREVIOUS_KEYS_VARIABLE} beside a new one — and restart`;

/** Why no token is kept: the master key is missing (issue #659). Nothing stored is changed. */
export const NO_KEY = `the master key is missing, so the hopper keeps no new token: give it as ${MASTER_KEY_VARIABLE} at launch and restart (docs/deploy.md "The master key")`;

export interface AtRest {
  read(provider: ConnectedAccountProvider): Read | undefined;
  /** Whether a token can be kept: false while the master key is missing. */
  keeps: boolean;
  /** The account as it is stored: its tokens sealed. Throws NO_KEY when the master key is missing. */
  sealed(a: ConnectedAccount): ConnectedAccount;
  /** True when there is a key and the row holds a token in clear, or sealed under an older key: the renewer seals it now. */
  stale(stored: ConnectedAccount): boolean;
}

export function createAtRest(store: Pick<UserStore, 'connectedAccounts'>, box: TokenBox | undefined): AtRest {
  const open = (value: string): string => {
    if (!isSealed(value)) return value;
    if (!box) throw new Error(`the stored token is sealed and ${MASTER_KEY_VARIABLE} is missing: the runtime gives none`);
    try {
      return box.open(value);
    } catch {
      throw new Error(`the key it was sealed under is missing: neither ${MASTER_KEY_VARIABLE} nor ${PREVIOUS_KEYS_VARIABLE} opens the stored token (or it was altered)`);
    }
  };
  return {
    keeps: box !== undefined,
    read(provider) {
      const stored = store.connectedAccounts.get(provider);
      if (!stored) return undefined;
      try {
        return { stored, account: { ...stored, accessToken: open(stored.accessToken), ...(stored.refreshToken ? { refreshToken: open(stored.refreshToken) } : {}) } };
      } catch (e) {
        return { stored, unreadable: `${PROVIDER_NAME[provider]}: ${(e as Error).message}; ${GIVE_THE_KEY}` };
      }
    },
    sealed(a) {
      if (!box) throw new Error(NO_KEY);
      return { ...a, accessToken: box.seal(a.accessToken), ...(a.refreshToken ? { refreshToken: box.seal(a.refreshToken) } : {}) };
    },
    stale: (stored) => box !== undefined && [stored.accessToken, stored.refreshToken].some((t) => t !== undefined && (!isSealed(t) || !box.current(t))),
  };
}

/** The account a grant makes, as kept (before sealing). */
export const recordOf = (provider: ConnectedAccountProvider, who: Pick<AccountIdentity, 'subject' | 'account'>, g: Grant, connectedAt: string): ConnectedAccount => ({
  provider, account: who.account, subject: who.subject, accessToken: g.accessToken, connectedAt,
  ...(g.grantedBy ? { grantedBy: g.grantedBy } : {}),
  ...(g.expiresAt ? { expiresAt: g.expiresAt.toISOString() } : {}),
  ...(g.refreshToken ? { refreshToken: g.refreshToken } : {}),
  ...(g.refreshTokenExpiresAt ? { refreshTokenExpiresAt: g.refreshTokenExpiresAt.toISOString() } : {}),
});
