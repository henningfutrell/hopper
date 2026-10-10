// What the runtime gives the connected accounts: the renewal and token deletion with the app's client secret, the token
// box (issues #358, #441, #597), and the events they record (issues #358, #647).
import type { EventLog } from '../domain/ports.ts';
import { runtimeSecrets } from '../secrets/runtime.ts';
import { tokenBoxOf } from '../secrets/token-box.ts';
import type { HopperApps } from './hopper-app.ts';
import { renewal } from './renewal.ts';
import { tokenDeletion } from './revocation.ts';
import type { ConnectedAccountsOptions } from './service.ts';
import { CLIENT_SECRET_VARIABLE } from './web-flow.ts';

/**
 * What the runtime gives the connected accounts (issues #358, #441, #597): the renewal, with the app's client
 * secret when the runtime gives one — read at each renewal, so a rotated one counts — the token deletion,
 * with the client secret when given, whether the client secret is available, and the box that seals the tokens
 * at rest, under the instance's HOPPER_TOKEN_KEY.
 */
export function fromRuntime(apps: HopperApps, env: Record<string, string | undefined>, logger: { warn(line: string): void }): Pick<ConnectedAccountsOptions, 'refresh' | 'deleteToken' | 'hasClientSecret' | 'box'> {
  const clientSecret = (): string | undefined => { try { return runtimeSecrets(env)(CLIENT_SECRET_VARIABLE); } catch { return undefined; } };
  return {
    refresh: (provider, refresh, grantedBy) => renewal(apps[provider], clientSecret)(refresh, grantedBy),
    deleteToken: (provider, accessToken) => tokenDeletion(apps[provider], clientSecret())(accessToken),
    hasClientSecret: () => clientSecret() !== undefined,
    box: tokenBoxOf(runtimeSecrets(env), logger),
  };
}

/**
 * What the connected accounts record in the user's event log (issues #358, #647): the end of a connection, each
 * renewal (with the new expiry) and each failed renewal (with its error code). Facts only, never a token.
 */
export const accountEvents = (events: Pick<EventLog, 'append'>): Pick<ConnectedAccountsOptions, 'onExpired' | 'onRenewed' | 'onRenewalFailed'> => ({
  onExpired: (provider, account, reason) => { events.append({ type: 'connected_account.expired', data: { provider, account, reason } }); },
  onRenewed: (provider, { account, expiresAt }) => { events.append({ type: 'connected_account.renewed', data: { provider, account, ...(expiresAt ? { expiresAt } : {}) } }); },
  onRenewalFailed: (provider, { account, code }) => { events.append({ type: 'connected_account.renewal_failed', data: { provider, account, code } }); },
});
