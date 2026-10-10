// The renewer of a connected account's token (issue #441, design.md "Keeping the connection"). GitHub App
// user tokens expire after 8 hours; the refresh token that comes with them (about 6 months) trades for a new
// pair once, and GitHub invalidates both the refresh token and the old access token the moment it is used.
// So a renewal is atomic across processes on one database: it takes the account's advisory lock, re-reads
// the row, uses a pair another process rotated meanwhile rather than calling GitHub, and keeps the new pair —
// before anything else awaits — only while the refresh token it used is still the stored one. It runs
// ahead of expiry whether or not anything asks, at start too, and on a 401. GitHub not answering, a 5xx, a
// rate limit, a lock held too long, or a hopper set up so it cannot renew ends nothing: it is tried again with
// backoff and shown on the account. Only GitHub refusing the refresh token itself (`bad_refresh_token`:
// revoked, expired, or the app's authorization removed) with no newer pair stored ends the sign-in — and so does
// GitHub refusing (a 401) the token it renewed moments before (issue #647): the connection needs a reconnect.
// A 401 asks GitHub at once even while a failed renewal waits for its retry, but at most once a minute.
// Each renewal and each failed renewal is told (`onRenewed`, `onRenewalFailed`: recorded as events, never a token).
import type { ConnectedAccount, UserStore } from '../domain/ports.ts';
import { CONNECTED_ACCOUNT_PROVIDERS, type ConnectedAccountProvider } from '../domain/types.ts';
import { NO_KEY, PROVIDER_NAME, recordOf, type AtRest } from './at-rest.ts';
import { oauthError, type Grant } from './device-flow.ts';
import { CLIENT_ID_VARIABLE } from './hopper-app.ts';
import { RenewalBlocked } from './renewal.ts';

/** A token is renewed once this little of its life is left: a job given it then has an hour of it at least. */
export const RENEW_AHEAD_MS = 60 * 60_000;
/** How often the renewer looks at the account. */
export const RENEW_EVERY_MS = 60_000;
/** A renewal that failed for a reason that may pass is tried again after these, the last repeated. */
export const RETRY_MS = [30_000, 60_000, 120_000, 300_000, 600_000, 900_000];
/** A 401 skips the backoff of a failed renewal at most this often, per account (issue #647). */
export const SKIP_BACKOFF_EVERY_MS = 60_000;
/** A 401 on a token renewed less than this long ago is GitHub refusing the connection (issue #647). */
export const FRESH_REFUSED_MS = 5 * 60_000;
/** How long a renewal waits for another process's renewal of the same account before it gives up for now. */
const LOCK_WAIT_MS = 30_000;
const LOCK_POLL_MS = 200;

/** GitHub refusing the refresh token itself: it was used, revoked, or expired, or the app's authorization was removed. */
const REFUSED_REFRESH = 'bad_refresh_token';
/** GitHub refusing the app's own credentials: how this hopper is set up, never the user's sign-in (except `incorrect_client_credentials` without a client secret, issue #597). */
const APP_REFUSED = new Set(['invalid_client', 'unauthorized_client']);

/** A failed renewal's code, for its event: GitHub's OAuth error, else what kept GitHub from answering. */
function codeOf(err: unknown): string {
  const code = oauthError(err);
  if (code) return code;
  if (err instanceof RenewalBlocked) return 'renewal_blocked';
  const status = (err as { status?: unknown }).status;
  return typeof status === 'number' ? `http_${status}` : 'no_answer';
}

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
  /** Whether the runtime gives a client secret (issue #597): `incorrect_client_credentials` without one ends the connection. */
  hasClientSecret?(): boolean;
  /** A renewal kept a new pair (issue #647): when the new token expires; never a token. */
  onRenewed?(provider: ConnectedAccountProvider, renewed: { account: string; expiresAt?: string }): void;
  /** A renewal failed (issue #647): GitHub's error code, or what kept it from answering; never a token. */
  onRenewalFailed?(provider: ConnectedAccountProvider, failed: { account: string; code: string }): void;
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
  /** When the renewer tries the account again (issue #647): the retry of a failed renewal, else an hour before its expiry. */
  next(a: ConnectedAccount): string | undefined;
  /** The last renewal that failed (issue #647), kept after later renewals succeed, until a new grant is kept. */
  lastError(provider: ConnectedAccountProvider): { at: string; error: string } | undefined;
  /** A new grant was kept: no trouble left, no last error. */
  clear(provider: ConnectedAccountProvider): void;
  /**
   * Run `fn` with no renewal of the account under way, in this process or another (its lock, waited for as
   * a renewal waits): the grant is replaced or dropped (issue #514) while nothing is rotating it.
   */
  exclusive<T>(provider: ConnectedAccountProvider, fn: () => Promise<T>): Promise<T>;
  start(): void;
  stop(): void;
}

export function createRenewer(o: RenewerOptions): Renewer {
  const renewing = new Map<ConnectedAccountProvider, Promise<string>>();
  const replacing = new Map<ConnectedAccountProvider, Promise<unknown>>();
  const troubles = new Map<ConnectedAccountProvider, Trouble>();
  const lastErrors = new Map<ConnectedAccountProvider, { at: string; error: string }>();
  /** When a 401 last skipped the backoff of a failed renewal, per account. */
  const skipped = new Map<ConnectedAccountProvider, number>();
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
    lastErrors.set(provider, { at: o.clock.now().toISOString(), error: why });
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
      if (o.atRest.storedRefresh(provider) !== refreshToken || Date.now() >= until) return false;
      await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
    }
  }

  function renew(provider: ConnectedAccountProvider, refused?: string): Promise<string> {
    let r = renewing.get(provider);
    if (r) return r;
    r = (async () => {
      await replacing.get(provider)?.catch(() => undefined);
      const first = o.live(provider);
      if (refused !== undefined && first.account.accessToken !== refused) return first.account.accessToken; // already renewed
      if (!first.account.refreshToken) throw o.end(first.stored, `${PROVIDER_NAME[provider]} refused the token and there is no refresh token to renew it`);
      const renewedAt = first.account.renewedAt === undefined ? undefined : Date.parse(first.account.renewedAt);
      if (refused !== undefined && renewedAt !== undefined && now() - renewedAt < FRESH_REFUSED_MS) {
        throw o.end(first.stored, `${PROVIDER_NAME[provider]} refused the token it renewed ${Math.round((now() - renewedAt) / 1000)} s before (401)`);
      }
      // A renewal that failed waits for its retry, asked or not: a 401 asks GitHub again before it, at most once a minute.
      const trouble = troubles.get(provider);
      if (trouble && trouble.retryAt > now()) {
        const skip = refused !== undefined && now() - (skipped.get(provider) ?? -Infinity) >= SKIP_BACKOFF_EVERY_MS;
        if (!skip) {
          if (refused === undefined && !past(first.account.expiresAt)) return first.account.accessToken;
          throw new Error(trouble.why);
        }
        skipped.set(provider, now());
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
    // Without the master key the new pair could not be kept, and GitHub ends the old one at the trade (issue #659).
    if (!o.atRest.keeps) throw new Error(NO_KEY);
    let g: Grant;
    try {
      g = await o.refresh(provider, a.refreshToken!, a.grantedBy);
    } catch (err) {
      const code = oauthError(err);
      o.onRenewalFailed?.(provider, { account: a.account, code: codeOf(err) });
      if (code === REFUSED_REFRESH) {
        // Another process that takes no lock (an older hopper beside this one) may have used it first: its pair, once.
        const after = o.live(provider);
        if (after.stored.refreshToken !== used) return again ? held(provider, undefined, false) : after.account.accessToken;
        throw o.end(after.stored, `${PROVIDER_NAME[provider]} refused the refresh token (${code})`);
      }
      // `incorrect_client_credentials` sent without a client secret (device-flow refresh) means the refresh token is dead (issue #597).
      if (code === 'incorrect_client_credentials' && !o.hasClientSecret?.()) {
        const after = o.live(provider);
        if (after.stored.refreshToken !== used) return again ? held(provider, undefined, false) : after.account.accessToken;
        throw o.end(after.stored, `${PROVIDER_NAME[provider]} refused the refresh token (${code}: GitHub ended the authorization)`);
      }
      const why = err instanceof RenewalBlocked ? err.message
        : code && APP_REFUSED.has(code) ? `${PROVIDER_NAME[provider]} refused this hopper's app while renewing the token (${code}): check ${CLIENT_ID_VARIABLE[provider]} and the client secret`
          : `${PROVIDER_NAME[provider]}: could not renew the token: ${code ?? (err as Error).message}`;
      return failed(provider, a, refused, why, err);
    }
    // Kept at once, before anything else awaits: GitHub has already invalidated the pair it was given.
    const kept = { ...recordOf(provider, a, g, a.connectedAt), ...(a.connectedBy ? { connectedBy: a.connectedBy } : {}), renewedAt: o.clock.now().toISOString() };
    // Through the vault, the row locked (issue #658): kept only while `used` is still the stored refresh token.
    if (!o.atRest.swap(provider, used, kept)) return o.live(provider).account.accessToken;
    troubles.delete(provider);
    o.logger.info(`hopper: ${PROVIDER_NAME[provider]} token of ${a.account} renewed`);
    o.onRenewed?.(provider, { account: a.account, ...(kept.expiresAt ? { expiresAt: kept.expiresAt } : {}) });
    return g.accessToken;
  }

  function exclusive<T>(provider: ConnectedAccountProvider, fn: () => Promise<T>): Promise<T> {
    const before = replacing.get(provider);
    const run = (async () => {
      await before?.catch(() => undefined);
      await renewing.get(provider)?.catch(() => undefined);
      const until = Date.now() + LOCK_WAIT_MS;
      let held = accounts.lock(provider);
      while (!held && Date.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
        held = accounts.lock(provider);
      }
      if (!held) o.logger.warn(`hopper: ${PROVIDER_NAME[provider]}: another process held the renewal lock for ${LOCK_WAIT_MS / 1000} s; going on without it`);
      try {
        return await fn();
      } finally {
        if (held) accounts.unlock(provider);
      }
    })();
    replacing.set(provider, run);
    void run.catch(() => undefined).finally(() => { if (replacing.get(provider) === run) replacing.delete(provider); });
    return run;
  }

  function renewDue(): Promise<void> {
    looking ??= (async () => {
      for (const p of CONNECTED_ACCOUNT_PROVIDERS) {
        const l = o.lookable(p);
        if (!l) continue;
        if (!o.atRest.keeps) continue;
        if (!l.account.refreshToken || !due(l.account) || (troubles.get(p)?.retryAt ?? 0) > now()) continue;
        await renew(p).catch(() => undefined); // logged where it failed
      }
    })().finally(() => { looking = undefined; });
    return looking;
  }

  const next = (a: ConnectedAccount): string | undefined => {
    const trouble = troubles.get(a.provider);
    if (trouble) return new Date(trouble.retryAt).toISOString();
    if (a.expiresAt === undefined || !a.refreshToken) return undefined;
    return new Date(Math.max(now(), Date.parse(a.expiresAt) - RENEW_AHEAD_MS)).toISOString();
  };

  return {
    renew, due, renewDue, exclusive, next,
    trouble: (provider) => troubles.get(provider)?.why,
    lastError: (provider) => lastErrors.get(provider),
    clear: (provider) => { troubles.delete(provider); lastErrors.delete(provider); skipped.delete(provider); },
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
