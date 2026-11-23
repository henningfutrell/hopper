// A gateway realm's role check (issue #2986, docs/sign-in.md "Roles from an authorization service"): in a shared
// deployment behind an auth gateway, an authorization service records who may administer, operate or view each app,
// and the hopper asks it rather than keeping role lists. For each permission the realm names (admin, operator,
// viewer), the hopper posts `{ "object": <object>, "permission": <permission> }` to the check URL with the person's
// own token as `Authorization: Bearer <token>`, as the gateway forwarded it, and reads `{ "allowed": true|false }`.
// The highest permission allowed decides the role; none allowed: no role. Anything else — no answer, another status,
// another shape — is an error, never a no: the sign-in fails closed and says the authorization service is
// unavailable. Answers are kept a short time per subject; errors are not kept.
import type { UiRole } from '../domain/types.ts';
import type { GatewayRealmConfig, RoleCheckConfig } from './config.ts';

/** How long an answer is kept per subject. */
export const ROLE_CHECK_TTL_MS = 60_000;
const TIMEOUT_MS = 10_000;
/** Subjects kept at most; past it the oldest answer goes. */
const MAX_KEPT = 10_000;
const HIGHEST_FIRST: readonly UiRole[] = ['admin', 'operator', 'viewer'];

export type RoleCheckOutcome = { ok: true; role: UiRole | null } | { ok: false; error: string };

export interface RoleCheck {
  /** The role the authorization service grants `subject`, asked with its `token`, or from an answer kept less than the TTL. */
  decide(subject: string, token: string): Promise<RoleCheckOutcome>;
  /** The last answer for `subject`, however old; undefined: not asked since the hopper started. */
  last(subject: string): UiRole | null | undefined;
}

export function createRoleCheck(c: RoleCheckConfig, o: { now: () => number; ttlMs?: number }): RoleCheck {
  const ttl = o.ttlMs ?? ROLE_CHECK_TTL_MS;
  const kept = new Map<string, { role: UiRole | null; at: number }>();

  async function allowed(permission: string, token: string): Promise<boolean> {
    let res: Response;
    try {
      res = await fetch(c.url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ object: c.object, permission }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: 'error',
      });
    } catch (e) {
      throw new Error(`no answer: ${(e as Error).message}`, { cause: e });
    }
    if (res.status !== 200) { await res.body?.cancel(); throw new Error(`it answered HTTP ${res.status} for ${permission}`); }
    let body: unknown;
    try { body = await res.json(); } catch { throw new Error(`its answer for ${permission} is not JSON`); }
    const allow = (body as { allowed?: unknown } | null)?.allowed;
    if (typeof allow !== 'boolean') throw new Error(`its answer for ${permission} has no allowed true or false`);
    return allow;
  }

  return {
    async decide(subject, token) {
      const hit = kept.get(subject);
      if (hit && o.now() - hit.at < ttl) return { ok: true, role: hit.role };
      let granted: boolean[];
      try {
        granted = await Promise.all(HIGHEST_FIRST.map((r) => allowed(c.permissions[r], token)));
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
      const role = HIGHEST_FIRST.find((_, i) => granted[i]) ?? null;
      kept.delete(subject);
      while (kept.size >= MAX_KEPT) kept.delete(kept.keys().next().value!);
      kept.set(subject, { role, at: o.now() });
      return { ok: true, role };
    },
    last: (subject) => kept.get(subject)?.role,
  };
}

/** The role check of a gateway realm whose role provider is `check`; undefined: its role rules decide. */
export const roleCheckOf = (c: GatewayRealmConfig, now: () => number): RoleCheck | undefined =>
  (c.roles.provider === 'check' && c.roles.check ? createRoleCheck(c.roles.check, { now }) : undefined);
