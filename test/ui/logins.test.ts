// The Logins view's model (issue #477), on a fake clock: every `now` is passed in. A login is pending, then
// about to expire under the warning (the setting, or a fifth of the code's life when longer), then expired at
// `expiresAt` by the client's clock even before the server says so; the server's word is final. The countdown is
// server time: the browser's clock plus the offset read with the logins. Open logins count and sort by time left;
// ended ones stay on a card a short while, then go to the history.
import { describe, expect, it } from 'vitest';
import { clockOffset, countdownText, ENDED_ON_CARD_MS, loginsBadge, onCard, phaseOf, secondsLeft, sortByTimeLeft, warnSecOf } from '../../ui/src/model/logins.ts';
import type { LoginSettings, LoginView } from '../../ui/src/model/wire.ts';

const T0 = Date.parse('2026-10-08T12:00:00.000Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const SETTINGS: LoginSettings = { onExpiry: 'fail', warnSec: 60 };

/** A gh login reported at T0, its code good for `life` seconds. */
const login = (over: Partial<LoginView> = {}, life = 900): LoginView => ({
  id: 'l1', kind: 'device_code', tool: 'gh', status: 'pending', expiresAt: at(life), jobId: 'j1', machineId: 'desk', run: 'herdr-claude',
  renewable: true, createdAt: at(0), updatedAt: at(0), codeKept: true, verificationUrl: 'https://github.com/login/device', userCode: 'WDJB-MJHT', ...over,
});

describe('a login\'s phase on a fake clock', () => {
  it('pending with time left, about to expire under the warning, expired at expiresAt by the client clock', () => {
    const l = login();
    expect(phaseOf(l, T0 + 1_000, SETTINGS)).toBe('pending');
    // A fifth of 900 s is 180 s, longer than the 60 s setting.
    expect(warnSecOf(l, SETTINGS)).toBe(180);
    expect(phaseOf(l, T0 + 719_000, SETTINGS)).toBe('pending');
    expect(phaseOf(l, T0 + 720_000, SETTINGS)).toBe('expiring');
    expect(phaseOf(l, T0 + 899_999, SETTINGS)).toBe('expiring');
    expect(phaseOf(l, T0 + 900_000, SETTINGS)).toBe('expired');
  });

  it('the warning is the setting when a fifth of the code\'s life is shorter, and follows a renewed code from its update', () => {
    expect(warnSecOf(login({}, 120), SETTINGS)).toBe(60);
    expect(warnSecOf(login({}, 120), { ...SETTINGS, warnSec: 90 })).toBe(90);
    const renewed = login({ updatedAt: at(1000), expiresAt: at(1300) });
    expect(warnSecOf(renewed, SETTINGS)).toBe(60);
  });

  it('the server\'s status is final: expired, completed, cancelled and failed whatever the clock says', () => {
    for (const status of ['expired', 'completed', 'cancelled', 'failed'] as const) {
      expect(phaseOf(login({ status }), T0 + 1_000, SETTINGS)).toBe(status);
    }
  });

  it('the countdown is mm:ss of server time, null once passed', () => {
    const l = login();
    expect(secondsLeft(l, T0)).toBe(900);
    expect(countdownText(l, T0)).toBe('15:00');
    expect(countdownText(l, T0 + 1_000)).toBe('14:59');
    expect(countdownText(l, T0 + 899_001)).toBe('0:00');
    expect(countdownText(l, T0 + 900_000)).toBeNull();
  });

  it('clock skew: the offset makes a browser clock 5 minutes behind count down from the server\'s time', () => {
    const browser = T0 - 300_000;
    const offset = clockOffset(at(0), browser);
    expect(offset).toBe(300_000);
    expect(countdownText(login(), browser + offset)).toBe('15:00');
    expect(phaseOf(login(), browser + 900_000 + offset, SETTINGS)).toBe('expired');
  });
});

describe('the logins together', () => {
  it('the badge counts the open logins and warns when one is about to expire; an expired one no longer counts', () => {
    const a = login({ id: 'a' }, 900);
    const b = login({ id: 'b' }, 100);
    expect(loginsBadge([a, b], T0, SETTINGS)).toEqual({ n: 2, warn: false, high: 0 });
    expect(loginsBadge([a, b], T0 + 50_000, SETTINGS)).toEqual({ n: 2, warn: true, high: 0 });
    expect(loginsBadge([a, b], T0 + 100_000, SETTINGS)).toEqual({ n: 1, warn: false, high: 0 });
    expect(loginsBadge([a, login({ id: 'c', status: 'completed' })], T0, SETTINGS)).toEqual({ n: 1, warn: false, high: 0 });
  });

  it('several open logins sort by time left, the shortest first; ended ones after, the latest end first', () => {
    const long = login({ id: 'long' }, 900);
    const short = login({ id: 'short' }, 120);
    const done = login({ id: 'done', status: 'completed', endedAt: at(10) });
    const older = login({ id: 'older', status: 'failed', endedAt: at(5) });
    expect(sortByTimeLeft([long, older, done, short], T0, SETTINGS).map((l) => l.id)).toEqual(['short', 'long', 'done', 'older']);
  });

  it('an ended login stays on a card a short while, then goes to the history; an expired one held for a new code stays', () => {
    const done = login({ status: 'completed', endedAt: at(10) });
    expect(onCard(done, T0 + 10_000, SETTINGS)).toBe(true);
    expect(onCard(done, T0 + 10_000 + ENDED_ON_CARD_MS, SETTINGS)).toBe(false);
    const expired = login({ status: 'expired' }, 60);
    expect(onCard(expired, T0 + 60_000 + ENDED_ON_CARD_MS - 1, SETTINGS)).toBe(true);
    expect(onCard(expired, T0 + 60_000 + ENDED_ON_CARD_MS, SETTINGS)).toBe(false);
    expect(onCard(expired, T0 + 60_000 + ENDED_ON_CARD_MS, { ...SETTINGS, onExpiry: 'hold' })).toBe(true);
    expect(onCard(login(), T0 + 3_600_000, SETTINGS)).toBe(true);
  });
});
