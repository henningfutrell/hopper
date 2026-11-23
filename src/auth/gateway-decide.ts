// What a gateway realm that accepted the token decides (issues #215, #2986, #2996): the role from its role provider —
// break-glass admin by the rules first —, else from the role rules. A refusal for no role names what the role rules
// match on, so an operator can write a rule from the message alone; a provider that could not be asked fails closed.
import type { Identity, UiRole } from '../domain/types.ts';
import type { AuthConfig, GatewayRealmConfig } from './config.ts';
import { tokenIn } from './gateway.ts';
import type { GatewayCheckOutcome } from './index.ts';
import type { GatewayRealm } from './realm.ts';
import type { RoleCheck } from './role-check.ts';
import { breakGlass } from './role-of.ts';
import { matchedOn } from './roles.ts';

type Headers = Record<string, string | string[] | undefined>;

export async function decideGateway(o: {
  realm: GatewayRealm; config: GatewayRealmConfig; roles: RoleCheck | undefined;
  who: Identity; usernameClaim: string | undefined; headers: Headers;
  auth: AuthConfig; roleOf(who: Identity): UiRole | null | undefined;
}): Promise<GatewayCheckOutcome> {
  const { realm, config: c, roles, who } = o;
  const noRole = (by: string): GatewayCheckOutcome =>
    ({ ok: false, status: 403, error: `signed in at the gateway, but ${by} grants this account no role (${realm.label}: ${matchedOn(who, o.usernameClaim)})`, who });
  if (roles && !breakGlass(o.auth, c, who)) {
    // The person's own token, as the gateway forwarded it: the realm's check just read it.
    const asked = await roles.decide(who.subject, tokenIn(o.headers, c.header)!);
    if (!asked.ok) return { ok: false, status: 502, error: `authorization service unavailable (${realm.label}): ${asked.error}`, who };
    return asked.role === null ? noRole('the authorization service') : { ok: true, who, role: asked.role };
  }
  const role = o.roleOf(who) ?? null;
  return role === null ? noRole('the sign-in config') : { ok: true, who, role };
}
