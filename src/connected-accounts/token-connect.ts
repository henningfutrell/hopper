// Connecting GitHub with a personal access token (issue #1380, design.md "A personal access token"): the person gives a token
// of their own, with no GitHub App. GitHub must take it (who it belongs to), and the source email match applies as for a
// device code. It is kept as the connection's access token, with no refresh token, marked `grantedBy: 'token'`. A refusal
// keeps nothing, deletes nothing at GitHub — the token is the person's —, and leaves a connection there was as it was.
import { CONNECTED_VIA, type ConnectedAccountKey, type ConnectedAccountProvider, type ConnectedAccountStatus } from '../domain/types.ts';
import { NO_KEY, PROVIDER_NAME } from './at-rest.ts';
import type { Grant } from './device-flow.ts';
import type { createEmailMatch } from './email-match.ts';
import type { HeldGrants } from './held.ts';
import type { AccountIdentity } from './identity.ts';
import type { InstallationReads } from './installations.ts';

export interface TokenConnectOptions {
  whoIs(provider: ConnectedAccountProvider, token: string): Promise<AccountIdentity>;
  emailMatch: Pick<ReturnType<typeof createEmailMatch>, 'atConnect'>;
  held: Pick<HeldGrants, 'release'>;
  installations: Pick<InstallationReads, 'refresh'>;
  /** Whether a token can be kept: false without the master key (issue #659). */
  keeps(): boolean;
  keep(provider: ConnectedAccountProvider, who: AccountIdentity, g: Grant, connectedAt: string, connectedBy: 'sources', matchEmail?: string): Promise<void>;
  /** Ends a waiting device code and forgets a failure said before. */
  reset(provider: ConnectedAccountProvider): void;
  /** Keeps why the connect failed, for the status while nothing is connected. */
  fail(provider: ConnectedAccountProvider, why: string): void;
  status(provider: ConnectedAccountProvider): ConnectedAccountStatus;
  link?(provider: ConnectedAccountProvider, subject: string): void;
  onChange?(provider: ConnectedAccountProvider): void;
  clock: { now(): Date };
  /** The account's key (issue #1448); absent: its provider. */
  accountKey?: ConnectedAccountKey;
  logger: { info(line: string): void; warn(line: string): void };
}

export function createTokenConnect(o: TokenConnectOptions) {
  return async (provider: ConnectedAccountProvider, accessToken: string, by?: { email?: string }): Promise<ConnectedAccountStatus> => {
    const email = by?.email;
    o.reset(provider);
    const refuse = (why: string): ConnectedAccountStatus => {
      o.fail(provider, why);
      o.logger.warn(`hopper: connecting ${PROVIDER_NAME[provider]} with a token refused: ${why}`);
      return { provider, key: o.accountKey ?? provider, via: CONNECTED_VIA, state: 'failed', error: why }; // said even over a connection there is: it stays as it was
    };
    if (!o.keeps()) return refuse(NO_KEY);
    let who: AccountIdentity;
    try {
      who = await o.whoIs(provider, accessToken);
    } catch (err) {
      return refuse(`${PROVIDER_NAME[provider]} refused the token: ${(err as Error).message}`);
    }
    const { matchEmail, refused } = o.emailMatch.atConnect(provider, email, who);
    if (refused) return refuse(refused);
    await o.keep(provider, who, { accessToken, grantedBy: 'token' }, o.clock.now().toISOString(), 'sources', matchEmail);
    await o.held.release(provider, false);
    await o.installations.refresh(provider);
    o.link?.(provider, who.subject);
    o.logger.info(`hopper: ${PROVIDER_NAME[provider]} connected as ${who.account} with a personal access token`);
    o.onChange?.(provider);
    return o.status(provider);
  };
}
