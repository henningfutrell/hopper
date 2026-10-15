// The Logins view's model (issue #477): a login's phase on the clock, its countdown, the nav badge, the order
// of the cards and which logins stay on a card. Pure: every `now` is server time (the browser's clock plus the
// offset read with the logins, `clockOffset`), passed in.
import type { LastAccount, LoginSettings, LoginView } from './wire.ts';

/** `expiring`: pending, under the warning. `expired` also when the client's clock passed `expiresAt` first. */
export type LoginPhase = 'pending' | 'expiring' | 'expired' | 'completed' | 'cancelled' | 'failed' | 'dismissed';

/** How long an ended login stays on a card before it goes to the history; a resolved one goes at once (issue #1110). */
export const ENDED_ON_CARD_MS = 5 * 60_000;

/** Server time less the browser's, from the `now` a logins read answered: add it to `Date.now()`. */
export const clockOffset = (serverNow: string, browserNow: number): number => Date.parse(serverNow) - browserNow;

/** Whole seconds left on the code; 0 or less once it ran out. */
export const secondsLeft = (l: LoginView, now: number): number => Math.floor((Date.parse(l.expiresAt) - now) / 1000);

/** mm:ss left, or null once the code ran out. */
export function countdownText(l: LoginView, now: number): string | null {
  if (Date.parse(l.expiresAt) <= now) return null;
  const s = Math.max(0, secondsLeft(l, now));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** The warning, in seconds: the setting, or a fifth of the code's life (from its last report) when that is longer. */
export function warnSecOf(l: LoginView, settings: LoginSettings): number {
  const life = (Date.parse(l.expiresAt) - Date.parse(l.updatedAt)) / 1000;
  return Math.max(settings.warnSec, Math.floor(life / 5));
}

/** The server's status wins once it ended or expired; a pending one is read on the clock. */
export function phaseOf(l: LoginView, now: number, settings: LoginSettings): LoginPhase {
  if (l.status !== 'pending') return l.status;
  if (Date.parse(l.expiresAt) <= now) return 'expired';
  return secondsLeft(l, now) <= warnSecOf(l, settings) ? 'expiring' : 'pending';
}

export const isOpen = (p: LoginPhase): boolean => p === 'pending' || p === 'expiring';

/**
 * An expired code its job still waits to renew (issue #1016): `onExpiry` renew (the job is asked for a new code by
 * itself) or hold (a person asks), on a run that can ask its tool again. It still waits on the user, so it counts.
 */
export const awaitsNewCode = (l: LoginView, phase: LoginPhase, settings: LoginSettings): boolean =>
  phase === 'expired' && l.renewable && l.jobId !== undefined && settings.onExpiry !== 'fail';

/**
 * The nav badge and the header: how many logins wait on the user, whether one is about to expire, and how many of
 * them a high-priority job waits on (issue #535).
 */
export function loginsBadge(logins: LoginView[], now: number, settings: LoginSettings): { n: number; warn: boolean; high: number } {
  const open = logins.map((l) => ({ l, phase: phaseOf(l, now, settings) })).filter((x) => isOpen(x.phase) || awaitsNewCode(x.l, x.phase, settings));
  return { n: open.length, warn: open.some((x) => x.phase !== 'pending'), high: open.filter((x) => x.l.high === true).length };
}

/** Open logins first — a high-priority job's first (issue #535), then the least time left —; then the rest, the latest end first. */
export function sortByTimeLeft(logins: LoginView[], now: number, settings: LoginSettings): LoginView[] {
  const endOf = (l: LoginView) => Date.parse(l.endedAt ?? l.expiresAt);
  return [...logins].sort((a, b) => {
    const oa = isOpen(phaseOf(a, now, settings));
    const ob = isOpen(phaseOf(b, now, settings));
    if (oa !== ob) return oa ? -1 : 1;
    if (oa && a.high !== b.high) return a.high ? -1 : 1;
    return oa ? Date.parse(a.expiresAt) - Date.parse(b.expiresAt) : endOf(b) - endOf(a);
  });
}

/**
 * On a card: every login the server still has pending (a reopened one too, issue #1110), an expired one waiting for a
 * new code (`onExpiry` renew or hold, a run that can ask), and any other but a resolved one — completed or dismissed,
 * which goes at once (issue #1110) — for `ENDED_ON_CARD_MS` after it ended or expired. The rest are the history.
 */
export function onCard(l: LoginView, now: number, settings: LoginSettings): boolean {
  if (l.status === 'pending') return true;
  if (l.status === 'completed' || l.status === 'dismissed') return false;
  if (l.status === 'expired' && settings.onExpiry !== 'fail' && l.renewable) return true;
  return now - Date.parse(l.endedAt ?? l.expiresAt) < ENDED_ON_CARD_MS;
}

/**
 * Who a sign-in request's machine was last signed in as (issue #1269), so the person knows who to sign in as: the account and its
 * organization, then the machine. On a login, a not-signed-in question and a machine on Accounts. Undefined for one that does not
 * say (no machine, or a tool whose account is not read).
 */
export function lastAccountText(lastAccount: LastAccount | null | undefined, machine: string): string | undefined {
  if (lastAccount === undefined) return undefined;
  if (lastAccount === null) return `No previous account known for this machine (${machine})`;
  const org = lastAccount.organization ? ` (${lastAccount.organization})` : '';
  return `Last signed in as ${lastAccount.identity}${org} on ${machine}`;
}
