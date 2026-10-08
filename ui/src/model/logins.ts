// The Logins view's model (issue #477): a login's phase on the clock, its countdown, the nav badge, the order
// of the cards and which logins stay on a card. Pure: every `now` is server time (the browser's clock plus the
// offset read with the logins, `clockOffset`), passed in.
import type { LoginSettings, LoginView } from './wire.ts';

/** `expiring`: pending, under the warning. `expired` also when the client's clock passed `expiresAt` first. */
export type LoginPhase = 'pending' | 'expiring' | 'expired' | 'completed' | 'cancelled' | 'failed';

/** How long an ended login stays on a card before it goes to the history. */
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

/** The nav badge and the header: how many logins wait on the user, and whether one is about to expire. */
export function loginsBadge(logins: LoginView[], now: number, settings: LoginSettings): { n: number; warn: boolean } {
  const phases = logins.map((l) => phaseOf(l, now, settings)).filter(isOpen);
  return { n: phases.length, warn: phases.includes('expiring') };
}

/** Open logins first, the least time left on top; then the rest, the latest end first. */
export function sortByTimeLeft(logins: LoginView[], now: number, settings: LoginSettings): LoginView[] {
  const endOf = (l: LoginView) => Date.parse(l.endedAt ?? l.expiresAt);
  return [...logins].sort((a, b) => {
    const oa = isOpen(phaseOf(a, now, settings));
    const ob = isOpen(phaseOf(b, now, settings));
    if (oa !== ob) return oa ? -1 : 1;
    return oa ? Date.parse(a.expiresAt) - Date.parse(b.expiresAt) : endOf(b) - endOf(a);
  });
}

/**
 * On a card: every login the server still has pending, an expired one held for a new code (`onExpiry: hold`, a
 * run that can ask), and any other for `ENDED_ON_CARD_MS` after it ended or expired. The rest are the history.
 */
export function onCard(l: LoginView, now: number, settings: LoginSettings): boolean {
  if (l.status === 'pending') return true;
  if (l.status === 'expired' && settings.onExpiry === 'hold' && l.renewable) return true;
  return now - Date.parse(l.endedAt ?? l.expiresAt) < ENDED_ON_CARD_MS;
}
