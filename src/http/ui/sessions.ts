// UI sessions, in memory only (a daemon restart logs the UI out). A session is a random token
// with an expiry; lookups compare in constant time.
import type { Clock } from '../../domain/ports.ts';
import { randomSecret, sameSecret } from './secret.ts';

export interface UiSession { token: string; expiresAt: string }

export interface UiSessions {
  create(): UiSession;
  /** The live session for this token, or undefined (unknown or expired). */
  find(token: string | undefined): UiSession | undefined;
  drop(token: string): void;
}

export function createUiSessions(o: { clock: Clock; hours: number }): UiSessions {
  const live: UiSession[] = [];
  const prune = (): void => {
    const now = o.clock.now().toISOString();
    for (let i = live.length - 1; i >= 0; i--) if (live[i]!.expiresAt <= now) live.splice(i, 1);
  };
  const find = (token: string | undefined): UiSession | undefined => {
    prune();
    return token ? live.find((s) => sameSecret(s.token, token)) : undefined;
  };
  return {
    create() {
      prune();
      const s = { token: randomSecret(), expiresAt: new Date(o.clock.now().getTime() + o.hours * 3_600_000).toISOString() };
      live.push(s);
      return s;
    },
    find,
    drop(token) {
      const s = find(token);
      if (s) live.splice(live.indexOf(s), 1);
    },
  };
}
