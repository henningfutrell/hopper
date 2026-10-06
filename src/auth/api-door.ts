// The API door (issue #255, design.md "The API door"): the token in `Authorization: Bearer …` on a read of
// /api/, checked as the UI door checks the same sign-in — one pipeline, two doors. A JWT goes to the
// gateway realms (`checkGateway`, as POST /ui/auth/gateway: its signature against the issuer's keys); any
// other token to GitHub for the first GitHub realm that is on (who it belongs to, as a GitHub sign-in
// asks). The same role rules grant the role. Which user it reads as is the HTTP edge's (src/http/tenants.ts).
import { createHash } from 'node:crypto';
import type { AccountIdentity } from '../connected-accounts/identity.ts';
import type { Identity, UiRole } from '../domain/types.ts';
import type { DeviceRealmConfig } from './config.ts';
import { tokenIn } from './gateway.ts';
import type { GatewayCheckOutcome } from './index.ts';

/**
 * A token on the API door: who it signs in as, their role, and which check accepted it (`github`: the
 * identity is a GitHub realm's, so it reads only as the user it is the connected account of).
 */
export type TokenCheckOutcome =
  | { ok: true; who: Identity; role: UiRole; via: 'gateway' | 'github' }
  | { ok: false; status: 401 | 403 | 502; error: string; who?: Identity };

type Headers = Record<string, string | string[] | undefined>;

/** How long GitHub's answer to who a token belongs to is kept: the door asks once a minute per token, not per request. */
const IDENTITY_MS = 60_000;
const MAX_IDENTITIES = 1_000;
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;

/** The identity of a GitHub account in a GitHub realm (a sign-in, and the API door). */
export const githubIdentity = (r: DeviceRealmConfig, id: AccountIdentity): Identity => ({
  realm: r.name, subject: id.subject, username: id.account, groups: [],
  ...(id.email ? { email: id.email } : {}), ...(id.name ? { name: id.name } : {}),
});

export function createTokenCheck(o: {
  checkGateway(headers: Headers): Promise<GatewayCheckOutcome>;
  gatewayOn(): boolean;
  githubRealm(): DeviceRealmConfig | undefined;
  whoIs(token: string): Promise<AccountIdentity>;
  roleOf(who: Identity): UiRole | null;
  now(): number;
}): { check(headers: Headers): Promise<TokenCheckOutcome>; forget(): void } {
  // By the token's hash, never the token.
  const kept = new Map<string, { id: AccountIdentity; expires: number }>();
  async function accountOf(token: string): Promise<AccountIdentity> {
    const key = createHash('sha256').update(token, 'utf8').digest('hex');
    const k = kept.get(key);
    if (k && k.expires > o.now()) return k.id;
    kept.delete(key);
    const id = await o.whoIs(token);
    while (kept.size >= MAX_IDENTITIES) kept.delete(kept.keys().next().value!);
    kept.set(key, { id, expires: o.now() + IDENTITY_MS });
    return id;
  }

  async function check(headers: Headers): Promise<TokenCheckOutcome> {
    const token = tokenIn(headers, 'authorization');
    if (token === undefined) return { ok: false, status: 401, error: 'no token in authorization: send Authorization: Bearer <token>' };
    if (JWT.test(token)) {
      if (!o.gatewayOn()) return { ok: false, status: 401, error: 'the token is a JWT, and no gateway realm is on to check it' };
      const r = await o.checkGateway(headers);
      if (r.ok) return { ...r, via: 'gateway' };
      // Refused (403 naming nobody): the credential is wrong, 401. Accepted without a role stays 403.
      return r.status === 403 && !r.who ? { ...r, status: 401 } : r;
    }
    const r = o.githubRealm();
    if (!r) return { ok: false, status: 401, error: 'no GitHub realm is on to check the token' };
    let id: AccountIdentity;
    try {
      id = await accountOf(token);
    } catch (e) {
      const status = (e as { status?: unknown }).status;
      if (status === 401 || status === 403) return { ok: false, status: 401, error: `${r.label} does not accept the token` };
      return { ok: false, status: 502, error: `${r.label} could not be asked whose the token is: ${(e as Error).message}` };
    }
    const who = githubIdentity(r, id);
    const role = o.roleOf(who);
    if (role === null) return { ok: false, status: 403, error: 'signed in, but the sign-in config grants this account no role', who };
    return { ok: true, who, role, via: 'github' };
  }

  return { check, forget: () => kept.clear() };
}
