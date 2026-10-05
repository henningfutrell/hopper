// UI sessions, kept in the store so a daemon restart does not log the UI out. A session is a
// random token with an expiry, a role, the identity it was made for and the user it acts for (issue
// #158); only the token's SHA-256 is
// stored, and lookups go by that hash (the hash of a 32-byte random token leaks nothing through timing).
import { createHash } from 'node:crypto';
import type { Clock, UiSessionRepository } from '../../domain/ports.ts';
import type { Identity, SessionUser, UiRole } from '../../domain/types.ts';
import { randomSecret } from './secret.ts';

export interface UiSession { token: string; expiresAt: string; role: UiRole; identity: Identity; userId: string }

export interface UiSessions {
  create(o: { role: UiRole; identity: Identity; userId: string }): UiSession;
  /** The live session for this token, or undefined (unknown or expired). */
  find(token: string | undefined): UiSession | undefined;
  drop(token: string): void;
  /**
   * Apply auth.yaml as it is now to every stored session (at start): `roleOf` null drops it (its
   * provider is gone, or no rule grants it a role any more); another role replaces the stored one.
   */
  reconcile(roleOf: (who: Identity) => UiRole | null): { dropped: number; changed: number };
}

const hashOf = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');

/** Who signed in, as the UI shows it: the first name the provider gave. */
export const identityName = (who: Identity): string => who.name ?? who.username ?? who.email ?? who.subject;

/** Who a session acts for: its user (id, name), its role, and who signed in. */
export const sessionUser = (s: UiSession, userName: string): SessionUser => ({
  id: s.userId, name: userName, role: s.role, provider: s.identity.provider, identity: identityName(s.identity),
});

export function createUiSessions(o: { repo: UiSessionRepository; clock: Clock; hours: number }): UiSessions {
  return {
    create({ role, identity, userId }) {
      const s = { token: randomSecret(), expiresAt: new Date(o.clock.now().getTime() + o.hours * 3_600_000).toISOString(), role, identity, userId };
      o.repo.create({ tokenHash: hashOf(s.token), expiresAt: s.expiresAt, role, identity, userId });
      return s;
    },
    find(token) {
      if (!token) return undefined;
      const r = o.repo.find(hashOf(token), o.clock.now().toISOString());
      return r ? { token, expiresAt: r.expiresAt, role: r.role, identity: r.identity, userId: r.userId } : undefined;
    },
    drop(token) {
      o.repo.drop(hashOf(token));
    },
    reconcile(roleOf) {
      let dropped = 0;
      let changed = 0;
      for (const r of o.repo.all()) {
        const role = roleOf(r.identity);
        if (role === null) { o.repo.drop(r.tokenHash); dropped++; } else if (role !== r.role) { o.repo.setRole(r.tokenHash, role); changed++; }
      }
      return { dropped, changed };
    },
  };
}
