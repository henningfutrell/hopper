// The role a signed-in identity gets (design.md "Sign-in: none, password, local, OIDC and SAML" — Roles). Pure. Every
// identity provider fills the same Identity, so the rules read the same everywhere. The highest
// matching role wins; nothing matching and no default role → no role, no session.
import type { Identity, UiRole } from '../domain/types.ts';

/** Who a role is granted to. Emails, domains and usernames compare case-insensitively; subjects and groups exactly. */
export interface RoleMatch {
  subjects?: string[];
  usernames?: string[];
  emails?: string[];
  emailDomains?: string[];
  groups?: string[];
}

export interface RoleRules {
  admin?: RoleMatch;
  operator?: RoleMatch;
  viewer?: RoleMatch;
  /** The role of a signed-in identity no rule matches; absent or null: none. */
  defaultRole?: UiRole | null;
}

const HIGHEST_FIRST: readonly UiRole[] = ['admin', 'operator', 'viewer'];
const lower = (xs: string[] | undefined): string[] => (xs ?? []).map((x) => x.toLowerCase());

function matches(who: Identity, m: RoleMatch | undefined): boolean {
  if (!m) return false;
  const email = who.email?.toLowerCase();
  const domain = email?.includes('@') ? email.slice(email.lastIndexOf('@') + 1) : undefined;
  return (m.subjects ?? []).includes(who.subject)
    || (who.username !== undefined && lower(m.usernames).includes(who.username.toLowerCase()))
    || (email !== undefined && email !== '' && lower(m.emails).includes(email))
    || (domain !== undefined && domain !== '' && lower(m.emailDomains).includes(domain))
    || who.groups.some((g) => (m.groups ?? []).includes(g));
}

export function roleFor(who: Identity, rules: RoleRules): UiRole | null {
  return HIGHEST_FIRST.find((r) => matches(who, rules[r])) ?? rules.defaultRole ?? null;
}
