// A connected account at rest (issues #441, #658, design.md "Keeping the connection"): its row keeps who and when;
// its access and refresh tokens are system secrets in the user's vault (`connected-account.<provider>.access-token`,
// `….refresh-token`, src/vault/system.ts), sealed under the master key HOPPER_MASTER_KEY, so a dump or backup of the
// database holds no usable GitHub token. Without the key (the hopper is limited, issue #659) no token is kept: none is
// ever kept in clear. A renewal writes the new pair through the vault with the row locked, and only while the refresh token it
// used is still the stored one, so no refresh token is lost or kept twice. A token the runtime cannot open (no key, or
// another one) reads as unreadable, never as connected nor ended, and says to give the key back: connecting again would
// mint another GitHub grant toward GitHub's ten per user and app, and leave this one alive.
import type { ConnectedAccount, StoredAccount, UserStore } from '../domain/ports.ts';
import type { ConnectedAccountProvider } from '../domain/types.ts';
import type { SystemSecretName } from '../domain/vault.ts';
import { PREVIOUS_KEYS_VARIABLE, MASTER_KEY_VARIABLE } from '../secrets/token-box.ts';
import type { SystemSecrets } from '../vault/system.ts';
import type { Grant } from './device-flow.ts';
import type { AccountIdentity } from './identity.ts';

export const PROVIDER_NAME: Record<ConnectedAccountProvider, string> = { github: 'GitHub' };

/** The system secrets a connected account's tokens are kept as. */
export const accessTokenName = (p: ConnectedAccountProvider): SystemSecretName => `connected-account.${p}.access-token`;
export const refreshTokenName = (p: ConnectedAccountProvider): SystemSecretName => `connected-account.${p}.refresh-token`;

/**
 * The stored row with its tokens as stored (sealed: what a renewal compares, never opened), and the account with its
 * tokens opened — or why they cannot be.
 */
export type Read = { stored: ConnectedAccount; account: ConnectedAccount } | { stored: ConnectedAccount; unreadable: string };

/** What to do about tokens the runtime cannot open: the key back, never a new sign-in. */
export const GIVE_THE_KEY = `give the hopper the key it was sealed under — as ${MASTER_KEY_VARIABLE}, or as ${PREVIOUS_KEYS_VARIABLE} beside a new one — and restart`;

/** Why no token is kept: the master key is missing (issue #659). Nothing stored is changed. */
export const NO_KEY = `the master key is missing, so the hopper keeps no new token: give it as ${MASTER_KEY_VARIABLE} at launch and restart (docs/deploy.md "The master key")`;

export interface AtRest {
  read(provider: ConnectedAccountProvider): Read | undefined;
  /** Whether a token can be kept: false while the master key is missing (issue #659). */
  readonly keeps: boolean;
  /** The refresh token as stored now: what a renewal compares; undefined when none is. */
  storedRefresh(provider: ConnectedAccountProvider): string | undefined;
  /** Keeps the account: its row and its tokens, in one transaction. `rotated`: a renewal. Throws NO_KEY without the master key. */
  put(a: ConnectedAccount, rotated?: boolean): void;
  /**
   * Keeps the renewed account only while its stored refresh token is still `refreshToken` (as stored): one transaction,
   * the row locked (issue #441). False, nothing written, when another process rotated it first or it is gone.
   */
  swap(provider: ConnectedAccountProvider, refreshToken: string, next: ConnectedAccount): boolean;
  /** Removes the account and its tokens; true when there was one. */
  remove(provider: ConnectedAccountProvider): boolean;
}

/** Which key a token that cannot be opened needs (issue #647): the runtime's, or the one it was sealed under. */
function missing(e: Error): string {
  if (/master key is missing/.test(e.message)) return `the stored token is sealed and ${MASTER_KEY_VARIABLE} is missing: the runtime gives none`;
  if (/sealed under key/.test(e.message)) return `the key it was sealed under is missing: neither ${MASTER_KEY_VARIABLE} nor ${PREVIOUS_KEYS_VARIABLE} opens the stored token (or it was altered)`;
  return e.message;
}

/** The row without its tokens: what `connected_accounts` keeps since issue #658. */
export const rowOf = ({ accessToken: _a, refreshToken: _r, ...row }: ConnectedAccount | (StoredAccount & { accessToken?: string; refreshToken?: string })): StoredAccount => row;

export function createAtRest(store: Pick<UserStore, 'connectedAccounts' | 'tx'>, system: SystemSecrets): AtRest {
  const by = 'hopper';
  function keepTokens(a: ConnectedAccount, rotated: boolean): void {
    if (system.problem()) throw new Error(NO_KEY);
    const how = rotated ? { rotated } : {};
    const kept = system.keep(accessTokenName(a.provider), a.accessToken, by, how);
    if (!kept.ok) throw new Error(`${PROVIDER_NAME[a.provider]}: the token cannot be kept: ${kept.error}`);
    if (a.refreshToken) {
      const r = system.keep(refreshTokenName(a.provider), a.refreshToken, by, how);
      if (!r.ok) throw new Error(`${PROVIDER_NAME[a.provider]}: the refresh token cannot be kept: ${r.error}`);
    } else {
      system.drop(refreshTokenName(a.provider), by);
    }
    store.connectedAccounts.put(rowOf(a));
  }
  return {
    get keeps() { return system.problem() === undefined; },
    read(provider) {
      const row = store.connectedAccounts.get(provider);
      if (!row) return undefined;
      const access = system.stored(accessTokenName(provider));
      const refresh = system.stored(refreshTokenName(provider));
      const stored: ConnectedAccount = { ...row, accessToken: access ?? '', ...(refresh !== undefined ? { refreshToken: refresh } : {}) };
      try {
        const accessToken = system.open(accessTokenName(provider), PROVIDER_NAME[provider]);
        // Tokens from before issue #658 still in the row: moved at the first start with the master key.
        if (accessToken === undefined) throw new Error(store.connectedAccounts.legacyTokens(provider) ? 'the master key is missing: its tokens are not moved into the vault yet' : 'its token is not in the vault');
        const refreshToken = refresh === undefined ? undefined : system.open(refreshTokenName(provider), PROVIDER_NAME[provider]);
        return { stored, account: { ...row, accessToken, ...(refreshToken !== undefined ? { refreshToken } : {}) } };
      } catch (e) {
        return { stored, unreadable: `${PROVIDER_NAME[provider]}: ${missing(e as Error)}; ${GIVE_THE_KEY}` };
      }
    },
    storedRefresh: (provider) => system.stored(refreshTokenName(provider)),
    put: (a, rotated = false) => store.tx(() => keepTokens(a, rotated)),
    swap(provider, refreshToken, next) {
      return store.tx(() => {
        if (!store.connectedAccounts.lockRow(provider)) return false;
        if (system.stored(refreshTokenName(provider)) !== refreshToken) return false;
        keepTokens(next, true);
        return true;
      });
    },
    remove(provider) {
      return store.tx(() => {
        system.drop(accessTokenName(provider), by);
        system.drop(refreshTokenName(provider), by);
        return store.connectedAccounts.delete(provider);
      });
    },
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
