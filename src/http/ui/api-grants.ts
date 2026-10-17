// Grants (issue #881, design.md "Grants and refresh tokens"), on the model of OAuth 2.0 refresh-token rotation (RFC 6749,
// RFC 9700). A person mints a grant once for an agent; the agent trades its refresh token at POST /ui/auth/token/refresh
// for a short-lived API token — an API token session of the grant (./sessions.ts) — and a new refresh token, which
// replaces the one it sent. A refresh token is good once: one presented again after the grace period is taken as stolen,
// and the whole grant ends at once. A grant dies GRANT_IDLE_DAYS after its last refresh, at its fixed end if it has one,
// when it is revoked, or when its minter's sign-in no longer grants a role. Only hashes of refresh tokens are kept.
//
// A grant may be **bound** to a key of its agent's (issue #892, design.md "Sender binding", RFC 9449): then a refresh is
// good only with a DPoP proof of that key (./dpop.ts), and so is every use of its API tokens (../tenants.ts). A grant is
// bound at its mint (`jkt`: a device grant request's proof, or the thumbprint a person names), or at its first refresh
// that carries a proof; once bound it stays bound.
//
// The refresh token is 32 random bytes and kept as its SHA-256, as every token the hopper mints (./sessions.ts): a pepper
// adds nothing a guess could use against 256 random bits, so none is kept.
import { createHash, randomBytes } from 'node:crypto';
import type { ApiGrantRepository, ApiGrantRow } from '../../domain/api-grants.ts';
import type { DelegatePolicy } from '../../domain/delegates.ts';
import type { Clock } from '../../domain/ports.ts';
import {
  API_TOKEN_MINUTES, GRANT_IDLE_DAYS, REFRESH_GRACE_MS, REFRESH_TOKEN_PREFIX, lowerRole,
  type ApiGrantMinted, type ApiGrantView, type ApiTokenRefreshed, type ApiTokenSettings, type GrantEndReason, type Identity, type UiRole,
} from '../../domain/types.ts';
import { randomSecret } from './secret.ts';
import { CLI_REALM, type UiSession, type UiSessions } from './sessions.ts';

const DAY = 86_400_000;
const hashOf = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');

/** What a grant's life records (issue #881): each is an event of its user's, which notifiers and webhooks pass on. */
export type GrantRecord =
  | { type: 'api_grant.minted'; data: { grant: string; label: string; holder?: string; role: UiRole; scopes: string[]; box: boolean; endsAt: string | null; tokenMinutes: number } }
  | { type: 'api_grant.refreshed'; data: { grant: string; from: string } }
  | { type: 'api_grant.reuse_detected'; data: { grant: string; label: string; holder?: string; from: string } }
  | { type: 'api_grant.revoked'; data: { grant: string; label: string; holder?: string; reason: GrantEndReason } };

/** A grant to mint: its scopes already checked, its role already no higher than its minter's. `days` null: no fixed end. */
export interface GrantWanted {
  userId: string; identity: Identity; role: UiRole; label: string; holder?: string; scopes: string[]; box: boolean; days: number | null; minutes?: number;
  /** A delegate approver's approver policy (issue #1138). */
  delegate?: DelegatePolicy;
  /** The key the grant is bound to (issue #892): its thumbprint. */
  jkt?: string;
}

export type RefreshAnswer = { ok: true; value: ApiTokenRefreshed } | { ok: false; error: string };

export interface ApiGrants {
  /** The API-token lifetime and its bounds. */
  settings(): ApiTokenSettings;
  /** A new API-token lifetime (in its bounds: the caller checked); API tokens there are keep their own ends. */
  setTokenMinutes(minutes: number): ApiTokenSettings;
  /** A new grant and its first pair. */
  mint(want: GrantWanted, from: string): ApiGrantMinted & { session: UiSession };
  /**
   * Trade a refresh token for a new API token and a new refresh token. `jkt`: the key of the request's DPoP proof (issue
   * #892), checked already; a bound grant refuses any other, and an unbound one is bound to it.
   */
  refresh(refreshToken: string, from: string, jkt?: string): RefreshAnswer;
  /** The grant, while it lives; one that has expired ends here. */
  live(id: string): ApiGrantRow | undefined;
  /** The user's live grants, oldest first. */
  list(userId: string): ApiGrantView[];
  /** End the user's grant; false: the user has none such. */
  revoke(userId: string, id: string, reason?: GrantEndReason): boolean;
  /** End every grant of the user; how many. */
  revokeAll(userId: string): number;
  /** The sign-in config as it is now, applied to every grant: no role ends it, a lower role lowers it, never raises it. */
  reconcile(roleOf: (who: Identity) => UiRole | null): { dropped: number; changed: number };
}

export function createApiGrants(o: {
  repo: ApiGrantRepository; sessions: UiSessions; clock: Clock;
  /** The role the minter's sign-in grants now (null: none); asked at each refresh. */
  roleOf: (who: Identity) => UiRole | null;
  recorded?: (userId: string, record: GrantRecord) => void;
}): ApiGrants {
  const now = (): number => o.clock.now().getTime();
  const iso = (): string => o.clock.now().toISOString();
  const tokenMinutes = (): number => o.repo.tokenMinutes() ?? API_TOKEN_MINUTES.default;
  const minutesOf = (g: ApiGrantRow): number => Math.min(g.tokenMinutes ?? Infinity, tokenMinutes());
  const idleEnd = (g: ApiGrantRow): number => Date.parse(g.lastUsedAt) + GRANT_IDLE_DAYS * DAY;
  /** The CLI's identity is no realm's (the CLI's own sessions end at each start): its grants keep the role they were minted with. */
  const roleNow = (g: ApiGrantRow, roleOf = o.roleOf): UiRole | null => (g.identity.realm === CLI_REALM ? g.role : roleOf(g.identity));
  /** Answers a rotated refresh token gave, for a retry within the grace period, by the rotated token's hash. */
  const answered = new Map<string, { at: number; value: ApiTokenRefreshed }>();

  const who = (g: ApiGrantRow) => ({ grant: g.id, label: g.label, ...(g.holder === undefined ? {} : { holder: g.holder }) });
  const end = (g: ApiGrantRow, reason: GrantEndReason): void => {
    o.repo.drop(g.id);
    o.sessions.endGrant(g.id);
    o.recorded?.(g.userId, { type: 'api_grant.revoked', data: { ...who(g), reason } });
  };
  const live = (g: ApiGrantRow | undefined): ApiGrantRow | undefined => {
    if (!g) return undefined;
    if (g.endsAt !== undefined && now() >= Date.parse(g.endsAt)) { end(g, 'expired-absolute'); return undefined; }
    if (now() >= idleEnd(g)) { end(g, 'expired-idle'); return undefined; }
    return g;
  };
  const view = (g: ApiGrantRow): ApiGrantView => ({
    id: g.id, label: g.label, ...(g.holder === undefined ? {} : { holder: g.holder }), role: g.role, box: g.box === true, scopes: g.scopes,
    createdAt: g.createdAt, endsAt: g.endsAt ?? null, idleEndsAt: new Date(idleEnd(g)).toISOString(),
    ...(g.lastUsedAt === g.createdAt ? {} : { lastUsedAt: g.lastUsedAt }), ...(g.lastUsedFrom === undefined ? {} : { lastUsedFrom: g.lastUsedFrom }),
    ...(g.tokenMinutes === undefined ? {} : { tokenMinutes: g.tokenMinutes }), ...(g.delegate ? { delegate: { deny: [...g.delegate.deny] } } : {}),
    ...(g.jkt === undefined ? {} : { jkt: g.jkt }),
  });
  const bound = (g: ApiGrantRow): { tokenType?: 'DPoP' } => (g.jkt === undefined ? {} : { tokenType: 'DPoP' });
  /** A new API token of the grant: an API token session, with the grant's role and box flag, for the grant's lifetime. */
  const issue = (g: ApiGrantRow): UiSession => o.sessions.create({
    role: g.role, identity: g.identity, userId: g.userId, lastsMs: minutesOf(g) * 60_000, api: { label: g.label, box: g.box === true, grantId: g.id },
  });
  const forget = (): void => {
    for (const [hash, a] of answered) if (now() - a.at > REFRESH_GRACE_MS) answered.delete(hash);
  };

  return {
    settings: () => ({ tokenMinutes: tokenMinutes(), min: API_TOKEN_MINUTES.min, max: API_TOKEN_MINUTES.max }),
    setTokenMinutes(minutes) {
      o.repo.setTokenMinutes(minutes);
      return this.settings();
    },
    mint(want, from) {
      const at = iso();
      const g: ApiGrantRow = {
        id: randomBytes(8).toString('hex'), userId: want.userId, identity: want.identity, label: want.label,
        ...(want.holder === undefined ? {} : { holder: want.holder }), role: want.role, scopes: [...new Set(want.scopes)].sort(),
        ...(want.box ? { box: true as const } : {}), createdAt: at, ...(want.days === null ? {} : { endsAt: new Date(now() + want.days * DAY).toISOString() }),
        ...(want.minutes === undefined ? {} : { tokenMinutes: want.minutes }), lastUsedAt: at, lastUsedFrom: from,
        ...(want.delegate ? { delegate: { deny: [...want.delegate.deny] } } : {}), ...(want.jkt === undefined ? {} : { jkt: want.jkt }),
      };
      const refresh = `${REFRESH_TOKEN_PREFIX}${randomSecret()}`;
      o.repo.create(g, hashOf(refresh));
      const session = issue(g);
      o.recorded?.(g.userId, { type: 'api_grant.minted', data: { ...who(g), role: g.role, scopes: g.scopes, box: g.box === true, endsAt: g.endsAt ?? null, tokenMinutes: minutesOf(g) } });
      return {
        grant: g.id, token: session.token, expiresAt: session.expiresAt, refresh, ...bound(g), view: view(g), session,
        ...(g.endsAt === undefined ? { warning: 'this grant has no fixed end: it lives while it is used, until it is revoked' } : {}),
      };
    },
    refresh(refreshToken, from, jkt) {
      forget();
      const hash = hashOf(refreshToken);
      const t = o.repo.refreshToken(hash);
      const g = t && live(o.repo.get(t.grantId));
      if (!t || !g) return { ok: false, error: 'the refresh token is unknown, or its grant ended' };
      // Before reuse detection: a refresh token without its key is no use to a thief, and does not end the grant.
      if (g.jkt !== undefined && jkt !== g.jkt) {
        return { ok: false, error: jkt === undefined ? 'this grant is bound to a key: send a DPoP proof of it with the refresh' : 'the DPoP proof is signed with another key than the one this grant is bound to' };
      }
      if (t.rotatedAt !== undefined) {
        const kept = answered.get(hash);
        if (kept) return { ok: true, value: kept.value };
        if (now() - Date.parse(t.rotatedAt) <= REFRESH_GRACE_MS) return { ok: false, error: 'this refresh token was just used, and its answer is gone (the hopper restarted): use the refresh token that answer gave' };
        o.recorded?.(g.userId, { type: 'api_grant.reuse_detected', data: { ...who(g), from } });
        end(g, 'reuse-detected');
        return { ok: false, error: 'this refresh token was used before: it may be stolen, so its grant is revoked. A person mints a new grant' };
      }
      const granted = roleNow(g);
      if (granted === null) {
        end(g, 'realm-changed');
        return { ok: false, error: 'the sign-in this grant was minted with grants no role any more: its grant is revoked' };
      }
      const at = iso();
      const next = `${REFRESH_TOKEN_PREFIX}${randomSecret()}`;
      o.repo.rotate(hash, hashOf(next), at);
      const kept: ApiGrantRow = { ...g, role: lowerRole(granted, g.role), lastUsedAt: at, lastUsedFrom: from, ...(jkt === undefined ? {} : { jkt }) };
      o.repo.update(kept);
      const session = issue(kept);
      const value: ApiTokenRefreshed = { grant: g.id, token: session.token, expiresAt: session.expiresAt, refresh: next, ...bound(kept) };
      answered.set(hash, { at: now(), value });
      o.recorded?.(g.userId, { type: 'api_grant.refreshed', data: { grant: g.id, from } });
      return { ok: true, value };
    },
    live: (id) => live(o.repo.get(id)),
    list(userId) {
      return o.repo.all().filter((g) => g.userId === userId).map(live).filter((g): g is ApiGrantRow => g !== undefined)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(view);
    },
    revoke(userId, id, reason = 'revoked') {
      const g = live(o.repo.get(id));
      if (!g || g.userId !== userId) return false;
      end(g, reason);
      return true;
    },
    revokeAll(userId) {
      const mine = o.repo.all().filter((g) => g.userId === userId);
      for (const g of mine) end(g, 'revoked-all');
      return mine.length;
    },
    reconcile(roleOf) {
      let dropped = 0;
      let changed = 0;
      for (const g of o.repo.all()) {
        const granted = roleNow(g, roleOf);
        if (granted === null) { end(g, 'realm-changed'); dropped++; continue; }
        const role = lowerRole(granted, g.role);
        if (role !== g.role) { o.repo.update({ ...g, role }); changed++; }
      }
      return { dropped, changed };
    },
  };
}
