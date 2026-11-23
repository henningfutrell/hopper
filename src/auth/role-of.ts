// The role a signed-in identity has now (design.md "Sign-in: realms" — Roles): the login code's, no sign-in's, a local
// account's, or its realm's — by the role rules, or, for a gateway realm with a role provider (issue #2986), break-glass
// admin by the rules, else the provider's last answer.
import type { Identity, UiRole } from '../domain/types.ts';
import type { AuthConfig, GatewayRealmConfig, RealmConfig } from './config.ts';
import { LOCAL_ACCOUNTS_REALM, localAccountRole, type LocalAccounts } from './local-accounts.ts';
import { isSuperAdmin, roleFor } from './roles.ts';

/** Where a role comes from (issue #2986): a gateway realm's role provider, or the sign-in config's rules. */
export type RoleSource = 'provider' | 'rule';

/** A gateway realm whose role provider decides its roles (issue #2986). */
const providerRealm = (r: RealmConfig | undefined): r is GatewayRealmConfig => r?.type === 'gateway' && r.roles.provider !== undefined;

/** Admin by the rules while a role provider decides (issue #2986): a super admin, or a subject the realm's admin rule names. */
export function breakGlass(config: AuthConfig, r: GatewayRealmConfig, who: Identity): boolean {
  return isSuperAdmin(config, who) || (r.roles.admin?.subjects ?? []).includes(who.subject);
}

/** Where the role of `who` comes from under `config`. */
export function roleSourceIn(config: AuthConfig, who: Identity): RoleSource {
  const r = config.realms.find((x) => x.name === who.realm);
  return providerRealm(r) && !breakGlass(config, r, who) ? 'provider' : 'rule';
}

/**
 * The role `config` grants `who`, a local account's from `accounts`; null: none, or its realm is gone or off. For a
 * realm with a role provider (issue #2986), break-glass admin, else `provided`'s last answer; undefined: not known.
 */
export function roleIn(config: AuthConfig, who: Identity, accounts?: LocalAccounts, provided?: (who: Identity) => UiRole | null | undefined): UiRole | null | undefined {
  if (who.realm === 'local') return config.local.enabled ? 'admin' : null;
  if (who.realm === LOCAL_ACCOUNTS_REALM) return accounts ? localAccountRole(accounts, who) : null;
  if (who.realm === 'none') return config.none?.role ?? null;
  const r = config.realms.find((x) => x.name === who.realm);
  if (!r?.enabled) return null;
  const first = config.githubAdmin;
  if (r.type === 'github' && first?.realm === who.realm && first.subject === who.subject) return 'admin';
  if (providerRealm(r)) return breakGlass(config, r, who) ? 'admin' : provided?.(who);
  if (isSuperAdmin(config, who)) return 'admin';
  return roleFor(who, r.roles);
}
