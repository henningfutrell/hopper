// A connected account at rest (issue #441, design.md "Keeping the connection"): its access and refresh
// tokens sealed under the runtime's HOPPER_TOKEN_KEY (the token box) when it gives one, so a dump or backup
// of the database holds no usable GitHub token. A row kept in clear — before #441, or before the runtime
// gave a key — still reads, and is sealed by the renewer's next look; so is a row an older key sealed
// (HOPPER_TOKEN_KEY_PREVIOUS, issue #514). A sealed row the runtime cannot open (no key, or another one)
// reads as unreadable, never as connected nor ended, and says to give the key back: connecting again would
// mint another GitHub grant toward GitHub's ten per user and app, and leave this one alive.
import type { ConnectedAccount, UserStore } from '../domain/ports.ts';
import type { ConnectedAccountProvider } from '../domain/types.ts';
import { isSealed, PREVIOUS_KEYS_VARIABLE, TOKEN_KEY_VARIABLE, type TokenBox } from '../secrets/token-box.ts';
import type { Grant } from './device-flow.ts';
import type { AccountIdentity } from './identity.ts';

export const PROVIDER_NAME: Record<ConnectedAccountProvider, string> = { github: 'GitHub' };

/** The stored row, and the account with its tokens opened — or why they cannot be. */
export type Read = { stored: ConnectedAccount; account: ConnectedAccount } | { stored: ConnectedAccount; unreadable: string };

/** What to do about tokens the runtime cannot open: the key back, never a new sign-in. */
export const GIVE_THE_KEY = `give the hopper the key it was sealed under — as ${TOKEN_KEY_VARIABLE}, or as ${PREVIOUS_KEYS_VARIABLE} beside a new one — and restart`;

export interface AtRest {
  read(provider: ConnectedAccountProvider): Read | undefined;
  /** The account as it is stored: its tokens sealed when there is a key. */
  sealed(a: ConnectedAccount): ConnectedAccount;
  /** True when there is a key and the row holds a token in clear, or sealed under an older key: the renewer seals it now. */
  stale(stored: ConnectedAccount): boolean;
}

export function createAtRest(store: Pick<UserStore, 'connectedAccounts'>, box: TokenBox | undefined): AtRest {
  const open = (value: string): string => {
    if (!isSealed(value)) return value;
    if (!box) throw new Error(`the stored token is sealed and the runtime gives no ${TOKEN_KEY_VARIABLE}`);
    return box.open(value);
  };
  return {
    read(provider) {
      const stored = store.connectedAccounts.get(provider);
      if (!stored) return undefined;
      try {
        return { stored, account: { ...stored, accessToken: open(stored.accessToken), ...(stored.refreshToken ? { refreshToken: open(stored.refreshToken) } : {}) } };
      } catch (e) {
        return { stored, unreadable: `${PROVIDER_NAME[provider]}: ${(e as Error).message}; ${GIVE_THE_KEY}` };
      }
    },
    sealed: (a) => (box ? { ...a, accessToken: box.seal(a.accessToken), ...(a.refreshToken ? { refreshToken: box.seal(a.refreshToken) } : {}) } : a),
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
