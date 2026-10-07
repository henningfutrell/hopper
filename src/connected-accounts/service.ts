// A user's connected account (issue #214, design.md "Sign in with GitHub, and work through that
// connection"): the GitHub account their work comes through. Signing in with GitHub hands its connection
// over (`adopt`); connecting from Sources (for someone signed in at the edge: SSO, SAML, a gateway) runs
// GitHub's device flow with the hopper's app — the UI shows the device code until the person approves it
// at GitHub — then asks GitHub who the token belongs to, keeps the account in the user's store and links
// it, so a later sign-in with it lands here. One device code at a time. The account's job source, and the
// jobs it gives, ask here for the token; one that expired (an app that did not opt out of expiration)
// asks the person to sign in again. Which repositories its jobs may use is the user's choice (issue #321),
// a setting that outlives a disconnect; none chosen, no job.
import type { ConnectedAccount, ConnectedAccounts, ConnectedAccountTokens, Connection, UserStore } from '../domain/ports.ts';
import { CONNECTED_ACCOUNT_PROVIDERS, CONNECTED_VIA, type AppInstallation, type ConnectedAccountProvider, type ConnectedAccountStatus } from '../domain/types.ts';
import { deviceFlow, deviceFlowFailure, type DeviceFlow, type Grant } from './device-flow.ts';
import type { AccountIdentity } from './identity.ts';
import { CLIENT_ID_VARIABLE, configUrl, installUrl, type HopperApps } from './hopper-app.ts';

export const PROVIDER_NAME: Record<ConnectedAccountProvider, string> = { github: 'GitHub' };
export const notConnected = (provider: ConnectedAccountProvider) => `${PROVIDER_NAME[provider]} is not connected: Sources → Connect ${PROVIDER_NAME[provider]}`;
/** A token that expired (issue #359): nothing falls back to another credential; the person signs in again. */
export const expired = (provider: ConnectedAccountProvider) =>
  `${PROVIDER_NAME[provider]}'s sign-in expired: sign in with ${PROVIDER_NAME[provider]} again, or Sources → Connect ${PROVIDER_NAME[provider]}`;

interface Waiting { userCode: string; verificationUri: string; expiresAt: string; abort: AbortController }

export interface ConnectedAccountsOptions {
  store: Pick<UserStore, 'connectedAccounts' | 'settings'>;
  apps: HopperApps;
  /** Who a token belongs to. */
  whoIs(provider: ConnectedAccountProvider, token: string): Promise<AccountIdentity>;
  /** GitHub: the installations of the hopper's GitHub App that the token's user sees, with the repositories each reaches. */
  installations(token: string): Promise<AppInstallation[]>;
  /** Called once an account is connected from Sources: a later sign-in with it lands in this user. */
  link?(provider: ConnectedAccountProvider, subject: string): void;
  clock: { now(): Date };
  logger: { info(line: string): void; warn(line: string): void };
  /** The device flows (tests may pass their own); default: deviceFlow(app). */
  flows?: Partial<Record<ConnectedAccountProvider, DeviceFlow>>;
  /** Called once an account is connected or disconnected: its job source syncs now rather than at its next poll. */
  onChange?(provider: ConnectedAccountProvider): void;
}

export type ConnectedAccountsService = ConnectedAccounts & ConnectedAccountTokens & { stop(): void };

export function createConnectedAccounts(o: ConnectedAccountsOptions): ConnectedAccountsService {
  const flow = (p: ConnectedAccountProvider) => o.flows?.[p] ?? deviceFlow(o.apps[p]);
  const waiting = new Map<ConnectedAccountProvider, Waiting>();
  const failed = new Map<ConnectedAccountProvider, string>();
  const starting = new Map<ConnectedAccountProvider, Promise<ConnectedAccountStatus>>();

  // GitHub renews a GitHub App's user token only with the app's client secret, which no hopper holds.
  const isExpired = (a: ConnectedAccount) => a.expiresAt !== undefined && Date.parse(a.expiresAt) <= o.clock.now().getTime();

  const status = (provider: ConnectedAccountProvider): ConnectedAccountStatus => {
    const base = { provider, via: CONNECTED_VIA } as const;
    const w = waiting.get(provider);
    if (w) return { ...base, state: 'waiting', userCode: w.userCode, verificationUri: w.verificationUri, expiresAt: w.expiresAt };
    const a = o.store.connectedAccounts.get(provider);
    if (a && isExpired(a)) return { ...base, state: 'expired', account: a.account, error: expired(provider) };
    if (a) {
      const install = installUrl(o.apps[provider]);
      return {
        ...base, state: 'connected', account: a.account, connectedAt: a.connectedAt, jobRepositories: o.store.settings.getJobRepositories(provider),
        configUrl: configUrl(o.apps[provider]),
        ...(install ? { installUrl: install } : {}),
      };
    }
    const error = failed.get(provider);
    return error ? { ...base, state: 'failed', error } : { ...base, state: 'not-connected' };
  };

  /** With where the app is installed; GitHub not answering says why instead (never that it is not installed). */
  const withInstallations = async (s: ConnectedAccountStatus): Promise<ConnectedAccountStatus> => {
    if (s.state !== 'connected') return s;
    try {
      return { ...s, installations: await o.installations(await token(s.provider)) };
    } catch (e) {
      const error = `${PROVIDER_NAME[s.provider]} could not say where the app is installed: ${(e as Error).message}`;
      o.logger.warn(`hopper: ${error}`);
      return { ...s, installationsError: error };
    }
  };

  const keep = (provider: ConnectedAccountProvider, who: Pick<AccountIdentity, 'subject' | 'account'>, g: Grant, connectedAt: string): ConnectedAccount => {
    const record: ConnectedAccount = {
      provider, account: who.account, subject: who.subject, accessToken: g.accessToken, connectedAt,
      ...(g.expiresAt ? { expiresAt: g.expiresAt.toISOString() } : {}),
    };
    o.store.connectedAccounts.put(record);
    return record;
  };

  /** Wait for the user in the background; the UI reads the outcome. */
  function follow(provider: ConnectedAccountProvider, w: Waiting, grant: (s: AbortSignal) => Promise<Grant>): void {
    void (async () => {
      try {
        const g = await grant(w.abort.signal);
        const who = await o.whoIs(provider, g.accessToken);
        if (waiting.get(provider) !== w) return;
        keep(provider, who, g, o.clock.now().toISOString());
        failed.delete(provider);
        o.link?.(provider, who.subject);
        o.logger.info(`hopper: ${PROVIDER_NAME[provider]} connected as ${who.account}`);
        o.onChange?.(provider);
      } catch (err) {
        if (w.abort.signal.aborted || waiting.get(provider) !== w) return;
        failed.set(provider, deviceFlowFailure(err));
        o.logger.warn(`hopper: connecting ${PROVIDER_NAME[provider]} failed: ${deviceFlowFailure(err)}`);
      } finally {
        if (waiting.get(provider) === w) waiting.delete(provider);
      }
    })();
  }

  async function begin(provider: ConnectedAccountProvider): Promise<ConnectedAccountStatus> {
    failed.delete(provider);
    if (!o.apps[provider].clientId) {
      failed.set(provider, `this hopper has no app for ${PROVIDER_NAME[provider]} to connect through: set ${CLIENT_ID_VARIABLE[provider]}`);
      return status(provider);
    }
    try {
      const pending = await flow(provider).start();
      const w: Waiting = { userCode: pending.userCode, verificationUri: pending.verificationUri, expiresAt: pending.expiresAt.toISOString(), abort: new AbortController() };
      waiting.set(provider, w);
      o.logger.info(`hopper: connecting ${PROVIDER_NAME[provider]}: waiting for the device code to be approved`);
      follow(provider, w, (s) => pending.grant(s));
    } catch (err) {
      failed.set(provider, deviceFlowFailure(err));
      o.logger.warn(`hopper: connecting ${PROVIDER_NAME[provider]} failed: ${deviceFlowFailure(err)}`);
    }
    return status(provider);
  }

  const end = (provider: ConnectedAccountProvider) => {
    waiting.get(provider)?.abort.abort('cancel');
    waiting.delete(provider);
  };

  async function token(provider: ConnectedAccountProvider): Promise<string> {
    const a = o.store.connectedAccounts.get(provider);
    if (!a) throw new Error(notConnected(provider));
    if (isExpired(a)) throw new Error(expired(provider));
    return a.accessToken;
  }

  function problem(provider: ConnectedAccountProvider): string | undefined {
    const a = o.store.connectedAccounts.get(provider);
    return !a ? notConnected(provider) : isExpired(a) ? expired(provider) : undefined;
  }

  return {
    status: () => Promise.all(CONNECTED_ACCOUNT_PROVIDERS.map((p) => withInstallations(status(p)))),
    adopt(c: Connection) {
      end(c.provider);
      failed.delete(c.provider);
      const g: Grant = { accessToken: c.accessToken, ...(c.expiresAt ? { expiresAt: new Date(c.expiresAt) } : {}) };
      keep(c.provider, c, g, o.clock.now().toISOString());
      o.logger.info(`hopper: ${PROVIDER_NAME[c.provider]} connected as ${c.account} (signed in with it)`);
      o.onChange?.(c.provider);
    },
    connect(provider) {
      if (waiting.has(provider)) return Promise.resolve(status(provider));
      let s = starting.get(provider);
      if (!s) {
        s = begin(provider).finally(() => starting.delete(provider));
        starting.set(provider, s);
      }
      return s;
    },
    cancel(provider) {
      end(provider);
      failed.delete(provider);
      return status(provider);
    },
    disconnect(provider) {
      end(provider);
      failed.delete(provider);
      if (o.store.connectedAccounts.delete(provider)) {
        o.logger.info(`hopper: ${PROVIDER_NAME[provider]} disconnected`);
        o.onChange?.(provider);
      }
      return status(provider);
    },
    async choose(provider, repositories) {
      const chosen = [...new Set(repositories)];
      o.store.settings.setJobRepositories(provider, chosen);
      o.logger.info(`hopper: ${PROVIDER_NAME[provider]} job repositories chosen: ${chosen.length}`);
      o.onChange?.(provider);
      return withInstallations(status(provider));
    },
    account: (provider) => o.store.connectedAccounts.get(provider)?.account,
    jobRepositories: (provider) => o.store.settings.getJobRepositories(provider),
    token,
    problem,
    endpoints: (provider) => ({ url: o.apps[provider].url, apiUrl: o.apps[provider].apiUrl }),
    stop() {
      for (const p of CONNECTED_ACCOUNT_PROVIDERS) end(p);
    },
  };
}
