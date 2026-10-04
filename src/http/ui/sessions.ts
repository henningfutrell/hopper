// UI sessions, kept in the store so a daemon restart does not log the UI out. A session is a
// random token with an expiry; only the token's SHA-256 is stored, and lookups go by that hash
// (the hash of a 32-byte random token leaks nothing through timing).
import { createHash } from 'node:crypto';
import type { Clock, UiSessionRepository } from '../../domain/ports.ts';
import { randomSecret } from './secret.ts';

export interface UiSession { token: string; expiresAt: string }

export interface UiSessions {
  create(): UiSession;
  /** The live session for this token, or undefined (unknown or expired). */
  find(token: string | undefined): UiSession | undefined;
  drop(token: string): void;
}

const hashOf = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');

export function createUiSessions(o: { repo: UiSessionRepository; clock: Clock; hours: number }): UiSessions {
  return {
    create() {
      const s = { token: randomSecret(), expiresAt: new Date(o.clock.now().getTime() + o.hours * 3_600_000).toISOString() };
      o.repo.create(hashOf(s.token), s.expiresAt);
      return s;
    },
    find(token) {
      if (!token) return undefined;
      const expiresAt = o.repo.find(hashOf(token), o.clock.now().toISOString());
      return expiresAt ? { token, expiresAt } : undefined;
    },
    drop(token) {
      o.repo.drop(hashOf(token));
    },
  };
}
