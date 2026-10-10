// UI sessions, kept in the store so a daemon restart does not log the UI out. A session is a random token,
// a role, the identity it was made for and the user it acts for (issue #158); only the token's SHA-256 is
// stored, and lookups go by that hash (the hash of a 32-byte random token leaks nothing through timing).
//
// How long one lasts (issue #439, docs/sign-in.md "Sessions and logout") is the hopper's own, never the
// identity provider's token lifetime: each request renews it (`renew`), and it ends after the sign-in config's
// idle timeout without one, or at its maximum however much it is used. The lengths are read at each lookup, so
// a change in Settings → Sign-in applies to the sessions there are. A session a gateway realm made renews only
// while the token the gateway forwards still checks out for the same person: the gateway stays the authority.
// An issuer out of reach does not end it until GATEWAY_GRACE_MS after the last good check. A session signed in
// with GitHub ends when its user's GitHub connection does (issue #513): that connection is what they signed in
// for. Every end is reported to `ended` with its reason. A request whose token names no live session says why
// (issue #647): it expired just now, it ended earlier (with its reason, while this process remembers it), or no stored
// session has it.
import { createHash } from 'node:crypto';
import type { SignIn } from '../../auth/index.ts';
import type { Clock, UiSessionRepository, UiSessionRow } from '../../domain/ports.ts';
import type { ActingPerson, Identity, SessionEndReason, SessionLengths, SessionUser, UiRole } from '../../domain/types.ts';
import { randomSecret } from './secret.ts';

export interface UiSession { token: string; expiresAt: string; role: UiRole; identity: Identity; userId: string }

/** A session that ended, and why. */
export interface EndedSession { userId: string; identity: Identity; reason: SessionEndReason }

export interface UiSessions {
  /** A new session; `lastsMs` gives it a fixed end of its own, whatever the session lengths (the operator CLI's). */
  create(o: { role: UiRole; identity: Identity; userId: string; lastsMs?: number }): UiSession;
  /** The live session for this token, or undefined (unknown or ended). One that has expired ends here. */
  find(token: string | undefined): UiSession | undefined;
  /** A request of this session's, with its headers: renews it — for a gateway realm's, once its token checks out again. */
  renew(token: string | undefined, headers: Record<string, string | string[] | undefined>): Promise<void>;
  drop(token: string, reason: SessionEndReason): void;
  /**
   * Apply the sign-in config as it is now to every stored session (at start, and after every change from
   * Settings → Sign-in): `roleOf` null ends it (its realm is gone or off, or no rule grants it a role
   * any more); another role replaces the stored one.
   */
  reconcile(roleOf: (who: Identity) => UiRole | null): { dropped: number; changed: number };
  /** The identities of the stored sessions, as their realms gave them at sign-in. */
  identities(): Identity[];
}

/** A renewal is written at most this often (a tenth of the idle timeout when that is shorter); a gateway token is checked as often. */
export const RENEW_EVERY_MS = 60_000;
/** How long a gateway realm's issuer may stay out of reach before the sessions it vouches for end. */
export const GATEWAY_GRACE_MS = 5 * 60_000;
const HOUR = 3_600_000;

const hashOf = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');

/** Who signed in, as the UI shows it: the first name the realm gave. */
export const identityName = (who: Identity): string => who.name ?? who.username ?? who.email ?? who.subject;

/** The realm of a session the operator CLI mints for one call (issue #374): no sign-in config names it. */
export const CLI_REALM = 'cli';

/** Who acts through a session, and the way (issue #623): the operator CLI's session, or the UI's. */
export const actingOf = (who: Identity): ActingPerson => ({ person: identityName(who), via: who.realm === CLI_REALM ? 'cli' : 'ui' });

/** Who a session acts for: its user (id, name), its role, who signed in, whether they are a super admin (issue #242), and whether the session is the instance admin's (issue #240). */
export const sessionUser = (s: UiSession, userName: string, superAdmin: boolean, instanceAdmin: boolean): SessionUser => ({
  id: s.userId, name: userName, role: s.role, realm: s.identity.realm, identity: identityName(s.identity), superAdmin, instanceAdmin,
});

/** When the session ends however much it is used. */
const absoluteEnd = (r: UiSessionRow, lengths: SessionLengths): number =>
  Math.min(Date.parse(r.startedAt) + lengths.maxHours * HOUR, r.endsAt === undefined ? Infinity : Date.parse(r.endsAt));

/** When the session ends if nothing renews it, and why it would. */
function endOf(r: UiSessionRow, lengths: SessionLengths): { at: number; reason: SessionEndReason } {
  const idle = Date.parse(r.lastSeenAt) + lengths.idleHours * HOUR;
  const max = absoluteEnd(r, lengths);
  return idle < max ? { at: idle, reason: 'expired-idle' } : { at: max, reason: 'expired-absolute' };
}

export function createUiSessions(o: {
  repo: UiSessionRepository; clock: Clock;
  /** The sign-in config as it applies now (the session lengths, which realms are gateways) and the gateway check. */
  signIn: Pick<SignIn, 'config' | 'checkGateway'>;
  ended?: (s: EndedSession) => void;
  /** Whether the user's GitHub connection ended (issue #513): their sessions signed in with GitHub end with it. */
  connectionEnded?: (userId: string) => boolean;
  /** A request carried a token that names no live session, and why (issue #647): once per token. */
  unknown?: (why: string) => void;
}): UiSessions {
  const now = (): number => o.clock.now().getTime();
  const lengths = (): SessionLengths => o.signIn.config().sessions;
  const renewEvery = (): number => Math.min(RENEW_EVERY_MS, lengths().idleHours * HOUR / 10);
  const isGateway = (realm: string): boolean => o.signIn.config().realms.some((r) => r.name === realm && r.type === 'gateway');
  const isGitHub = (realm: string): boolean => o.signIn.config().realms.some((r) => r.name === realm && r.type === 'github');
  /** Why recent sessions ended, by token hash (bounded): a later request with the token says so. */
  const endedWhy = new Map<string, SessionEndReason>();
  const end = (r: UiSessionRow, reason: SessionEndReason): void => {
    if (endedWhy.size >= 1000) endedWhy.clear();
    endedWhy.set(r.tokenHash, reason);
    o.repo.drop(r.tokenHash);
    o.ended?.({ userId: r.userId, identity: r.identity, reason });
  };
  /** The row, unless it has expired or, signed in with GitHub, its user's GitHub connection ended: then it ends. */
  const live = (r: UiSessionRow | undefined): UiSessionRow | undefined => {
    if (!r) return undefined;
    const e = endOf(r, lengths());
    if (now() >= e.at) { end(r, e.reason); return undefined; }
    if (isGitHub(r.identity.realm) && o.connectionEnded?.(r.userId) === true) { end(r, 'connection-ended'); return undefined; }
    return r;
  };
  const unknownSeen = new Set<string>();
  const unknownToken = (hash: string, why: string): void => {
    if (unknownSeen.has(hash)) return;
    if (unknownSeen.size >= 1000) unknownSeen.clear();
    unknownSeen.add(hash);
    o.unknown?.(why);
  };
  const EXPIRED: readonly SessionEndReason[] = ['expired-idle', 'expired-absolute'];
  const whyGone = (reason: SessionEndReason): string => `${EXPIRED.includes(reason) ? 'expired' : 'ended'}: ${reason}`;
  let sweptAt = -Infinity;
  /** End every stored session that has expired, a request naming it or not; at most once per renewal interval. */
  const sweep = (): void => {
    if (now() - sweptAt < renewEvery()) return;
    sweptAt = now();
    for (const r of o.repo.all()) live(r);
  };
  const view = (token: string, r: UiSessionRow): UiSession => ({
    token, expiresAt: new Date(endOf(r, lengths()).at).toISOString(), role: r.role, identity: r.identity, userId: r.userId,
  });

  return {
    create({ role, identity, userId, lastsMs }) {
      const at = o.clock.now().toISOString();
      const token = randomSecret();
      const row: UiSessionRow = {
        tokenHash: hashOf(token), startedAt: at, lastSeenAt: at, checkedAt: at, role, identity, userId,
        ...(lastsMs === undefined ? {} : { endsAt: new Date(now() + lastsMs).toISOString() }),
      };
      o.repo.create(row, new Date(absoluteEnd(row, lengths())).toISOString());
      return view(token, row);
    },
    find(token) {
      sweep();
      if (!token) return undefined;
      const r = live(o.repo.get(hashOf(token)));
      return r ? view(token, r) : undefined;
    },
    async renew(token, headers) {
      if (!token) return;
      const hash = hashOf(token);
      const stored = o.repo.get(hash);
      if (!stored) {
        const reason = endedWhy.get(hash);
        unknownToken(hash, reason ? whyGone(reason) : 'not found: it ended before this hopper started, the database was reset, or it is another hopper\'s');
        return;
      }
      const r = live(stored);
      if (!r) { unknownToken(hash, whyGone(endedWhy.get(hash)!)); return; }
      if (now() - Date.parse(r.lastSeenAt) < renewEvery()) return;
      const at = o.clock.now().toISOString();
      if (!isGateway(r.identity.realm)) { o.repo.touch(r.tokenHash, at); return; }
      const check = await o.signIn.checkGateway(headers);
      if (check.ok && check.who.realm === r.identity.realm && check.who.subject === r.identity.subject) { o.repo.touch(r.tokenHash, at, at); return; }
      // Out of reach: the session stands, unrenewed, until the grace period after the last good check.
      if (!check.ok && check.status === 502) {
        if (now() - Date.parse(r.checkedAt) >= GATEWAY_GRACE_MS) end(r, 'provider-unreachable');
        return;
      }
      end(r, 'refresh-refused');
    },
    drop(token, reason) {
      const r = o.repo.get(hashOf(token));
      if (r) end(r, reason);
    },
    reconcile(roleOf) {
      let dropped = 0;
      let changed = 0;
      for (const r of o.repo.all()) {
        const role = roleOf(r.identity);
        if (role === null) { end(r, 'realm-changed'); dropped++; } else if (role !== r.role) { o.repo.setRole(r.tokenHash, role); changed++; }
      }
      return { dropped, changed };
    },
    identities() {
      return o.repo.all().map((r) => r.identity);
    },
  };
}
