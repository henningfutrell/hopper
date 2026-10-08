// A user's connected account (issue #214, design.md "Sign in with GitHub, and work through that
// connection"): the GitHub account their work comes through. Signing in with GitHub hands its connection
// over (`adopt`); connecting from Sources (for someone signed in at the edge: SSO, SAML, a gateway) runs
// GitHub's device flow with the hopper's app — the UI shows the device code until the person approves it
// at GitHub — then asks GitHub who the token belongs to, keeps the account in the user's store and links
// it, so a later sign-in with it lands here. One device code at a time. The account's job source, and the
// jobs it gives, ask here for the token. Which repositories its jobs may use is the user's choice (issue
// #321), a setting that outlives a disconnect; none chosen, no job.
//
// GitHub App user tokens expire after 8 hours; the renewer (renewer.ts, issues #358, #441) keeps the token
// renewed — ahead of expiry whether or not anything asks, at start, and on a 401 — atomically across
// processes, and the tokens are sealed at rest (at-rest.ts). The sign-in ends only when GitHub refuses the
// refresh token itself and no newer pair is stored, or the refresh token is past its own expiry: then the
// account reads as expired — never as connected — offers no login, its source says to connect again —
// nothing reads GitHub in its place (issue #359) — and the owner is told once (`onExpired`).
//
// One grant per connection, never more (issue #514): GitHub keeps at most ten tokens per user and app, and
// making an eleventh revokes an older one, whoever holds it. Each connect and each sign-in with GitHub is a
// new grant; so the grant a new one replaces, and the one a disconnect drops, is revoked at GitHub first
// (revocation.ts) — best effort, logged when GitHub does not take it — with no renewal under way. A
// connection the runtime cannot open reads `unreadable`: give the key back, never a new grant.
import type { ConnectedAccount, ConnectedAccounts, ConnectedAccountTokens, Connection, UserStore } from '../domain/ports.ts';
import { CONNECTED_ACCOUNT_PROVIDERS, CONNECTED_VIA, type AppInstallation, type ConnectedAccountProvider, type ConnectedAccountStatus } from '../domain/types.ts';
import { runtimeSecrets } from '../secrets/runtime.ts';
import { tokenBoxOf, type TokenBox } from '../secrets/token-box.ts';
import { createAtRest, PROVIDER_NAME, recordOf } from './at-rest.ts';
import { revocation } from './revocation.ts';
import { deviceFlow, deviceFlowFailure, type DeviceFlow, type Grant } from './device-flow.ts';
import type { AccountIdentity } from './identity.ts';
import { CLIENT_ID_VARIABLE, configUrl, installUrl, type HopperApps } from './hopper-app.ts';
import { renewal, type Renewal } from './renewal.ts';
import { createRenewer, type Live } from './renewer.ts';
import { CLIENT_SECRET_VARIABLE } from './web-flow.ts';

export { PROVIDER_NAME };
export { RENEW_AHEAD_MS, RENEW_EVERY_MS, RETRY_MS } from './renewer.ts';
export const notConnected = (provider: ConnectedAccountProvider) => `${PROVIDER_NAME[provider]} is not connected: Sources → Connect ${PROVIDER_NAME[provider]}`;
/** What an account whose sign-in ended says, on its source and where its token is asked for (issue #358). */
export const expired = (provider: ConnectedAccountProvider) => `${PROVIDER_NAME[provider]}'s sign-in expired: Sources → Connect ${PROVIDER_NAME[provider]} again`;

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
  /** Renews a token with its refresh token (renewal.ts), per provider. */
  refresh(provider: ConnectedAccountProvider, refreshToken: string, grantedBy: Grant['grantedBy']): Promise<Grant>;
  /** Called once when an account's sign-in ends (issue #358): the owner is told. */
  onExpired?(provider: ConnectedAccountProvider, account: string, reason: string): void;
  /** Called after this process renewed an account's token (issue #441): running jobs are handed the new one. */
  onRenewed?(provider: ConnectedAccountProvider): void;
  /** Revokes a grant's tokens at GitHub (issue #514): the one a new grant replaces, or a disconnect drops. Absent: none is revoked. */
  revoke?(provider: ConnectedAccountProvider, credentials: string[]): Promise<void>;
  /** Seals the tokens at rest (issue #441); absent: the runtime gives no HOPPER_TOKEN_KEY, and they are kept in clear. */
  box?: TokenBox | undefined;
  /** How often the renewer looks; default RENEW_EVERY_MS. */
  renewEveryMs?: number;
}

export type { Renewal };

/**
 * What the runtime gives the connected accounts (issues #358, #441): the renewal, with the app's client
 * secret when the runtime gives one — read at each renewal, so a rotated one counts — and the box that
 * seals the tokens at rest, under the instance's HOPPER_TOKEN_KEY.
 */
export function fromRuntime(apps: HopperApps, env: Record<string, string | undefined>, logger: { warn(line: string): void }): Pick<ConnectedAccountsOptions, 'refresh' | 'revoke' | 'box'> {
  const clientSecret = (): string | undefined => { try { return runtimeSecrets(env)(CLIENT_SECRET_VARIABLE); } catch { return undefined; } };
  return {
    refresh: (provider, refresh, grantedBy) => renewal(apps[provider], clientSecret)(refresh, grantedBy),
    revoke: (provider, credentials) => revocation(apps[provider])(credentials),
    box: tokenBoxOf(runtimeSecrets(env), logger),
  };
}

export type ConnectedAccountsService = ConnectedAccounts & ConnectedAccountTokens & {
  /** Starts the renewer (issue #441): it looks at once, then every `renewEveryMs`. */
  start(): void;
  /** One look of the renewer; resolves once every renewal it started has settled. */
  renewDue(): Promise<void>;
  stop(): void;
};

export function createConnectedAccounts(o: ConnectedAccountsOptions): ConnectedAccountsService {
  const flow = (p: ConnectedAccountProvider) => o.flows?.[p] ?? deviceFlow(o.apps[p]);
  const waiting = new Map<ConnectedAccountProvider, Waiting>();
  const failed = new Map<ConnectedAccountProvider, string>();
  const starting = new Map<ConnectedAccountProvider, Promise<ConnectedAccountStatus>>();
  const atRest = createAtRest(o.store, o.box);
  const past = (iso: string | undefined) => iso !== undefined && Date.parse(iso) <= o.clock.now().getTime();

  /** Why the account's sign-in ended, or undefined while it lives: GitHub refused it, or it expired with nothing to renew it. */
  const endOf = (a: ConnectedAccount): string | undefined => {
    if (a.ended) return a.ended;
    if (!past(a.expiresAt)) return undefined;
    if (!a.refreshToken) return `${PROVIDER_NAME[a.provider]}'s token expired at ${a.expiresAt} and there is no refresh token to renew it`;
    return past(a.refreshTokenExpiresAt) ? `${PROVIDER_NAME[a.provider]}'s refresh token expired at ${a.refreshTokenExpiresAt}` : undefined;
  };

  /** Record that the sign-in ended, and tell the owner — once. Answers the error to throw. */
  const end = (stored: ConnectedAccount, reason: string): Error => {
    const row = o.store.connectedAccounts.get(stored.provider);
    if (row && !row.ended) {
      o.store.connectedAccounts.put({ ...row, ended: reason });
      renewer.clear(stored.provider);
      o.logger.warn(`hopper: ${PROVIDER_NAME[stored.provider]} sign-in of ${stored.account} expired: ${reason}`);
      o.onExpired?.(stored.provider, stored.account, reason);
      o.onChange?.(stored.provider);
    }
    return new Error(expired(stored.provider));
  };

  type Current = (Live & { ended?: string }) | { unreadable: string; stored: ConnectedAccount };
  /** The account, its sign-in ended recorded (and told) the first time it is seen to have. */
  const current = (provider: ConnectedAccountProvider): Current | undefined => {
    const r = atRest.read(provider);
    if (!r || 'unreadable' in r) return r;
    const ended = endOf(r.account);
    if (ended && !r.account.ended) end(r.stored, ended);
    return ended ? { ...r, ended } : r;
  };

  /** The account while its sign-in lives, with its stored row; throws what to do when none is connected, it ended, or it cannot be read. */
  const live = (provider: ConnectedAccountProvider): Live => {
    const c = current(provider);
    if (!c) throw new Error(notConnected(provider));
    if ('unreadable' in c) throw new Error(c.unreadable);
    if (c.ended) throw new Error(expired(provider));
    return c;
  };

  const renewer = createRenewer({
    store: o.store, atRest, clock: o.clock, logger: o.logger, refresh: o.refresh, live, end,
    lookable: (p) => { const c = current(p); return !c || 'unreadable' in c || c.ended || waiting.has(p) ? undefined : c; },
    ...(o.onRenewed ? { onRenewed: o.onRenewed } : {}),
    ...(o.renewEveryMs ? { renewEveryMs: o.renewEveryMs } : {}),
  });

  const status = (provider: ConnectedAccountProvider): ConnectedAccountStatus => {
    const base = { provider, via: CONNECTED_VIA } as const;
    const w = waiting.get(provider);
    if (w) return { ...base, state: 'waiting', userCode: w.userCode, verificationUri: w.verificationUri, expiresAt: w.expiresAt };
    const c = current(provider);
    if (c && 'unreadable' in c) return { ...base, state: 'unreadable', account: c.stored.account, connectedAt: c.stored.connectedAt, error: c.unreadable };
    if (c?.ended) return { ...base, state: 'expired', account: c.account.account, connectedAt: c.account.connectedAt, error: c.ended };
    const a = c?.account;
    if (a) {
      const install = installUrl(o.apps[provider]);
      const trouble = renewer.trouble(provider);
      return {
        ...base, state: 'connected', account: a.account, connectedAt: a.connectedAt, jobRepositories: o.store.settings.getJobRepositories(provider),
        configUrl: configUrl(o.apps[provider]),
        ...(install ? { installUrl: install } : {}),
        ...(a.expiresAt ? { expiresAt: a.expiresAt } : {}),
        ...(trouble ? { renewal: trouble } : {}),
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

  /**
   * Revoke the account's grant at GitHub (issue #514), unless it ended — GitHub holds it no more — or is one
   * of `keeping`; then `write`. With no renewal under way, so the grant revoked is the one stored.
   */
  const replace = (provider: ConnectedAccountProvider, keeping: readonly string[], write: () => void): Promise<void> => renewer.exclusive(provider, async () => {
    const c = current(provider);
    if (c && 'unreadable' in c) o.logger.warn(`hopper: the ${PROVIDER_NAME[provider]} grant of ${c.stored.account} was not revoked: its tokens cannot be opened`);
    else if (c && !c.ended && o.revoke) {
      const credentials = [c.account.accessToken, c.account.refreshToken].filter((t): t is string => t !== undefined && !keeping.includes(t));
      try {
        if (credentials.length > 0) {
          await o.revoke(provider, credentials);
          o.logger.info(`hopper: the ${PROVIDER_NAME[provider]} grant of ${c.account.account} revoked`);
        }
      } catch (err) {
        o.logger.warn(`hopper: could not revoke the ${PROVIDER_NAME[provider]} grant of ${c.account.account}: ${(err as Error).message}; it counts toward GitHub's ten per user and app until it expires`);
      }
    }
    write();
  });

  const keep = (provider: ConnectedAccountProvider, who: Pick<AccountIdentity, 'subject' | 'account'>, g: Grant, connectedAt: string): Promise<void> =>
    replace(provider, [g.accessToken, ...(g.refreshToken ? [g.refreshToken] : [])], () => {
      o.store.connectedAccounts.put(atRest.sealed(recordOf(provider, who, g, connectedAt)));
      renewer.clear(provider);
    });

  /** Wait for the user in the background; the UI reads the outcome. */
  function follow(provider: ConnectedAccountProvider, w: Waiting, grant: (s: AbortSignal) => Promise<Grant>): void {
    void (async () => {
      try {
        const g = await grant(w.abort.signal);
        const who = await o.whoIs(provider, g.accessToken);
        if (waiting.get(provider) !== w) return;
        await keep(provider, who, g, o.clock.now().toISOString());
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

  const stopWaiting = (provider: ConnectedAccountProvider) => {
    waiting.get(provider)?.abort.abort('cancel');
    waiting.delete(provider);
  };

  async function token(provider: ConnectedAccountProvider): Promise<string> {
    const { account: a } = live(provider);
    return renewer.due(a) && a.refreshToken ? renewer.renew(provider) : a.accessToken;
  }

  return {
    status: () => Promise.all(CONNECTED_ACCOUNT_PROVIDERS.map((p) => withInstallations(status(p)))),
    async adopt(c: Connection) {
      stopWaiting(c.provider);
      failed.delete(c.provider);
      const g: Grant = {
        accessToken: c.accessToken, ...(c.grantedBy ? { grantedBy: c.grantedBy } : {}), ...(c.expiresAt ? { expiresAt: new Date(c.expiresAt) } : {}),
        ...(c.refreshToken ? { refreshToken: c.refreshToken } : {}),
        ...(c.refreshTokenExpiresAt ? { refreshTokenExpiresAt: new Date(c.refreshTokenExpiresAt) } : {}),
      };
      await keep(c.provider, c, g, o.clock.now().toISOString());
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
      stopWaiting(provider);
      failed.delete(provider);
      return status(provider);
    },
    async disconnect(provider) {
      stopWaiting(provider);
      failed.delete(provider);
      let gone = false;
      await replace(provider, [], () => { gone = o.store.connectedAccounts.delete(provider); });
      renewer.clear(provider);
      if (gone) {
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
    account: (provider) => { const c = current(provider); return c && !('unreadable' in c) && !c.ended ? c.account.account : undefined; },
    expired: (provider) => { const c = current(provider); return c !== undefined && !('unreadable' in c) && c.ended !== undefined; },
    ended: (provider) => { const c = current(provider); return !c ? undefined : 'unreadable' in c ? c.unreadable : c.ended ? expired(provider) : undefined; },
    renew: (provider, refused) => renewer.renew(provider, refused),
    jobRepositories: (provider) => o.store.settings.getJobRepositories(provider),
    token,
    endpoints: (provider) => ({ url: o.apps[provider].url, apiUrl: o.apps[provider].apiUrl }),
    start: () => renewer.start(),
    renewDue: () => renewer.renewDue(),
    stop() {
      renewer.stop();
      for (const p of CONNECTED_ACCOUNT_PROVIDERS) stopWaiting(p);
    },
  };
}
