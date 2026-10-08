// The renewer of a connected account's token (issue #441, design.md "Keeping the connection"). GitHub App
// user tokens expire after 8 hours; the refresh token that comes with them (about 6 months) trades for a new
// pair once, and GitHub invalidates both the refresh token and the old access token the moment it is used.
// So a renewal is atomic across processes on one database: it takes the account's advisory lock, re-reads
// the row, uses a pair another process rotated meanwhile rather than calling GitHub, and keeps the new pair —
// before anything else awaits — only while the refresh token it used is still the stored one. It runs
// ahead of expiry whether or not anything asks, at start too, and on a 401. GitHub not answering, a 5xx, a
// rate limit, a lock held too long, or a hopper set up so it cannot renew ends nothing: it is tried again with
// backoff and shown on the account. Only GitHub refusing the refresh token itself (`bad_refresh_token`:
// revoked, expired, or the app's authorization removed) with no newer pair stored ends the sign-in.
import type { ConnectedAccount, UserStore } from '../domain/ports.ts';
import { CONNECTED_ACCOUNT_PROVIDERS, type ConnectedAccountProvider } from '../domain/types.ts';
import { PROVIDER_NAME, recordOf, type AtRest } from './at-rest.ts';
import { oauthError, type Grant } from './device-flow.ts';
import { CLIENT_ID_VARIABLE } from './hopper-app.ts';
import { RenewalBlocked } from './renewal.ts';

/** A token is renewed once this little of its life is left: a job given it then has an hour of it at least. */
export const RENEW_AHEAD_MS = 60 * 60_000;
/** How often the renewer looks at the account. */
export const RENEW_EVERY_MS = 60_000;
/** A renewal that failed for a reason that may pass is tried again after these, the last repeated. */
export const RETRY_MS = [30_000, 60_000, 120_000, 300_000, 600_000, 900_000];
/** How long a renewal waits for another process's renewal of the same account before it gives up for now. */
const LOCK_WAIT_MS = 30_000;
const LOCK_POLL_MS = 200;

/** GitHub refusing the refresh token itself: it was used, revoked, or expired, or the app's authorization was removed. */
const REFUSED_REFRESH = 'bad_refresh_token';
/** GitHub refusing the app's own credentials: how this hopper is set up, never the user's sign-in. */
const APP_REFUSED = new Set(['incorrect_client_credentials', 'invalid_client', 'unauthorized_client']);

/** Why the last renewal failed and when the renewer tries again. */
interface Trouble { why: string; tries: number; retryAt: number }

/** The account while its sign-in lives, with its stored row. */
export interface Live { account: ConnectedAccount; stored: ConnectedAccount }

export interface RenewerOptions {
  store: Pick<UserStore, 'connectedAccounts'>;
  atRest: AtRest;
  clock: { now(): Date };
  logger: { info(line: string): void; warn(line: string): void };
  refresh(provider: ConnectedAccountProvider, refreshToken: string, grantedBy: Grant['grantedBy']): Promise<Grant>;
  /** The account while its sign-in lives; throws what to do when none is connected, it ended, or it cannot be read. */
  live(provider: ConnectedAccountProvider): Live;
  /** The account the renewer may look at now: connected, readable, not ended, no device code waiting. */
  lookable(provider: ConnectedAccountProvider): Live | undefined;
  /** Records that the sign-in ended and tells the owner, once; the error the caller throws. */
  end(stored: ConnectedAccount, reason: string): Error;
  onRenewed?(provider: ConnectedAccountProvider): void;
  renewEveryMs?: number;
}

export interface Renewer {
  /** A renewal now (`refused`: the access token GitHub refused, a 401); the token to use. */
  renew(provider: ConnectedAccountProvider, refused?: string): Promise<string>;
  /** Whether the account's token is in the renewal window. */
  due(a: ConnectedAccount): boolean;
  /** One look: every account near its expiry renewed, unless a failed renewal waits for its retry. */
  renewDue(): Promise<void>;
  /** Why the last renewal failed, while it is tried again. */
  trouble(provider: ConnectedAccountProvider): string | undefined;
  /** A new grant was kept: no trouble left. */
  clear(provider: ConnectedAccountProvider): void;
  start(): void;
  stop(): void;
}

export function createRenewer(o: RenewerOptions): Renewer {
  const renewing = new Map<ConnectedAccountProvider, Promise<string>>();
  const troubles = new Map<ConnectedAccountProvider, Trouble>();
  const now = () => o.clock.now().getTime();
  const past = (iso: string | undefined) => iso !== undefined && Date.parse(iso) <= now();
  const due = (a: ConnectedAccount) => a.expiresAt !== undefined && Date.parse(a.expiresAt) - now() <= RENEW_AHEAD_MS;
  const accounts = o.store.connectedAccounts;
  let timer: ReturnType<typeof setInterval> | undefined;
  let looking: Promise<void> | undefined;

  const troubled = (provider: ConnectedAccountProvider, why: string): void => {
    const tries = (troubles.get(provider)?.tries ?? 0) + 1;
    const wait = RETRY_MS[Math.min(tries, RETRY_MS.length) - 1]!;
    troubles.set(provider, { why, tries, retryAt: now() + wait });
    o.logger.warn(`hopper: ${why}; trying again in ${Math.round(wait / 1000)} s`);
  };

  /** The current token while it is still good and was not the one refused; else the failure, as an error. */
  const failed = (provider: ConnectedAccountProvider, a: ConnectedAccount, refused: string | undefined, why: string, cause?: unknown): string => {
    troubled(provider, why);
    if (refused === undefined && !past(a.expiresAt)) return a.accessToken;
    throw new Error(why, { cause });
  };

  /** Take the account's lock across processes; false when another process renewed meanwhile, or held it too long. */
  async function locked(provider: ConnectedAccountProvider, refreshToken: string | undefined): Promise<boolean> {
    const until = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      if (accounts.lock(provider)) return true;
      if (accounts.get(provider)?.refreshToken !== refreshToken || Date.now() >= until) return false;
      await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
    }
  }

  function renew(provider: ConnectedAccountProvider, refused?: string): Promise<string> {
    let r = renewing.get(provider);
    if (r) return r;
    r = (async () => {
      const first = o.live(provider);
      if (refused !== undefined && first.account.accessToken !== refused) return first.account.accessToken; // already renewed
      if (!first.account.refreshToken) throw o.end(first.stored, `${PROVIDER_NAME[provider]} refused the token and there is no refresh token to renew it`);
      // A renewal that failed waits for its retry, asked or not: a 401 alone asks GitHub again before it.
      const trouble = troubles.get(provider);
      if (refused === undefined && trouble && trouble.retryAt > now()) {
        if (!past(first.account.expiresAt)) return first.account.accessToken;
        throw new Error(trouble.why);
      }
      if (!await locked(provider, first.stored.refreshToken)) {
        const after = o.live(provider);
        if (after.stored.refreshToken !== first.stored.refreshToken) return after.account.accessToken; // another process renewed it
        return failed(provider, after.account, refused, `${PROVIDER_NAME[provider]}: another process is renewing the token`);
      }
      try {
        return await held(provider, refused, true);
      } finally {
        accounts.unlock(provider);
      }
    })().finally(() => renewing.delete(provider));
    renewing.set(provider, r);
    return r;
  }

  /** The renewal under the account's lock: re-read, trade, keep — the new pair stored the moment GitHub answers. */
  async function held(provider: ConnectedAccountProvider, refused: string | undefined, again: boolean): Promise<string> {
    const { account: a, stored } = o.live(provider);
    if (refused !== undefined ? a.accessToken !== refused : !due(a)) return a.accessToken; // renewed elsewhere meanwhile
    const used = stored.refreshToken!;
    let g: Grant;
    try {
      g = await o.refresh(provider, a.refreshToken!, a.grantedBy);
    } catch (err) {
      const code = oauthError(err);
      if (code === REFUSED_REFRESH) {
        // Another process that takes no lock (an older hopper beside this one) may have used it first: its pair, once.
        const after = o.live(provider);
        if (after.stored.refreshToken !== used) return again ? held(provider, undefined, false) : after.account.accessToken;
        throw o.end(after.stored, `${PROVIDER_NAME[provider]} refused the refresh token (${code})`);
      }
      const why = err instanceof RenewalBlocked ? err.message
        : code && APP_REFUSED.has(code) ? `${PROVIDER_NAME[provider]} refused this hopper's app while renewing the token (${code}): check ${CLIENT_ID_VARIABLE[provider]} and the client secret`
          : `${PROVIDER_NAME[provider]}: could not renew the token: ${code ?? (err as Error).message}`;
      return failed(provider, a, refused, why, err);
    }
    // Kept at once, before anything else awaits: GitHub has already invalidated the pair it was given.
    if (!accounts.swap(provider, used, o.atRest.sealed(recordOf(provider, a, g, a.connectedAt)))) return o.live(provider).account.accessToken;
    troubles.delete(provider);
    o.logger.info(`hopper: ${PROVIDER_NAME[provider]} token of ${a.account} renewed`);
    o.onRenewed?.(provider);
    return g.accessToken;
  }

  /** A token kept in clear — before #441, or before the runtime gave a key — sealed now. */
  function seal({ account: a, stored }: Live): void {
    const done = stored.refreshToken !== undefined ? accounts.swap(a.provider, stored.refreshToken, o.atRest.sealed(a)) : (accounts.put(o.atRest.sealed(a)), true);
    if (done) o.logger.info(`hopper: ${PROVIDER_NAME[a.provider]} tokens of ${a.account} sealed at rest`);
  }

  function renewDue(): Promise<void> {
    looking ??= (async () => {
      for (const p of CONNECTED_ACCOUNT_PROVIDERS) {
        const l = o.lookable(p);
        if (!l) continue;
        if (o.atRest.clear(l.stored)) seal(l);
        if (!l.account.refreshToken || !due(l.account) || (troubles.get(p)?.retryAt ?? 0) > now()) continue;
        await renew(p).catch(() => undefined); // logged where it failed
      }
    })().finally(() => { looking = undefined; });
    return looking;
  }

  return {
    renew, due, renewDue,
    trouble: (provider) => troubles.get(provider)?.why,
    clear: (provider) => { troubles.delete(provider); },
    start() {
      if (timer) return;
      void renewDue();
      timer = setInterval(() => { void renewDue(); }, o.renewEveryMs ?? RENEW_EVERY_MS);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
