// The sign-in config (design.md "Sign-in: realms"): how people sign in, the instance's config record
// `sign-in` (design.md "Config in the database"). There is no password user realm (issue #237): the
// hopper keeps no username-and-password accounts of its own. Loaded at start and after every change from Settings →
// Sign-in; an invalid one stops the daemon at start, naming the field, and is refused by the UI (sign-in
// fails closed). None → the one-time login code only. `realms` is the ordered list of realms, each of a
// realm type, on unless `enabled: false`; `local` (the login code) and `none` (no sign-in) are not realms.
// A realm's secrets (`clientSecret`, `bindPassword`) are its own settings, set in the UI or from the
// environment and stored with it (issue #216, design.md "Secrets"); a realm that is off need not have
// them yet. A SAML IdP certificate is public and sits inline.
import { z } from 'zod';
import { DEVICE_REALM_TYPES, FORM_REALM_TYPES, REDIRECT_REALM_TYPES, UI_ROLES, type RealmType, type UiRole } from '../domain/types.ts';
import type { RoleRules } from './roles.ts';

interface RealmBase { name: string; label: string; enabled: boolean }
export interface LdapRealmConfig extends RealmBase {
  type: 'ldap';
  url: string;
  startTls: boolean;
  /** Absent: an anonymous search. */
  bindDn?: string;
  /** Present with `bindDn` while the realm is on. */
  bindPassword?: string;
  userBase: string;
  /** `{username}` is replaced by the escaped username. */
  userFilter: string;
  /** Attribute names. `subject` absent: the entry's DN. */
  attributes: { subject?: string; username: string; email: string; name: string; groups: string };
  /** Groups found by search; `filter`'s `{dn}` is the user's escaped DN, `name` the attribute a group is known by. */
  groupSearch?: { base: string; filter: string; name: string };
  roles: RoleRules;
}
export interface OidcRealmConfig extends RealmBase {
  type: 'oidc';
  issuer: string;
  clientId: string;
  /** Absent: a public client (PKCE only). */
  clientSecret?: string;
  scopes: string[];
  /** Claim names, in the ID token or userinfo. */
  claims: { email: string; username: string; name: string; groups: string };
  /** Count `email` even when `email_verified` is not true. */
  trustUnverifiedEmail: boolean;
  roles: RoleRules;
}
/**
 * A device realm (issue #214): GitHub, signed in with by a device code through the hopper's GitHub App —
 * its public client id, no secret, the app and GitHub's address from the instance's configuration
 * (HOPPER_GITHUB_*), not the realm. The token that signs a person in is their connected account.
 */
export interface DeviceRealmConfig extends RealmBase {
  type: 'github';
  roles: RoleRules;
}
export interface SamlRealmConfig extends RealmBase {
  type: 'saml';
  entryPoint: string;
  idpCert: string;
  /** The SP entity id; absent: `<sign-in origin>/ui/auth/<name>/metadata`. */
  entityId?: string;
  /** The identity provider's entity id; when set, a response from another issuer is refused. */
  idpIssuer?: string;
  attributes: { email: string; username?: string; name: string; groups: string };
  requireSignedResponse: boolean;
  roles: RoleRules;
}
/**
 * A gateway realm (issue #215): an auth gateway in front of the hopper (Envoy Gateway with OIDC,
 * oauth2-proxy, …) signs people in and forwards their token in `header`; the hopper only checks it.
 */
export interface GatewayRealmConfig extends RealmBase {
  type: 'gateway';
  /** The token's issuer; its discovery document names the keys (`jwt`) or the introspection endpoint. */
  issuer: string;
  /** `jwt`: verify the signature against the issuer's keys; `introspection`: ask the issuer (RFC 7662). */
  check: 'jwt' | 'introspection';
  /** The token must name one of these in `aud`. Required for `jwt`; for `introspection`, checked when set. */
  audience?: string[];
  /** The request header the gateway forwards the token in, lowercase; `authorization` carries `Bearer <token>`. */
  header: string;
  /** `introspection`: the hopper's client at the issuer. */
  clientId?: string;
  clientSecret?: string;
  /** Claim names, in the token or the introspection answer. */
  claims: { email: string; username: string; name: string; groups: string };
  trustUnverifiedEmail: boolean;
  roles: RoleRules;
}
export type RealmConfig = LdapRealmConfig | OidcRealmConfig | DeviceRealmConfig | SamlRealmConfig | GatewayRealmConfig;
/** No sign-in: everyone who reaches the UI gets a session with this role. */
export interface NoSignInConfig { role: UiRole }
/** Who the first person to sign in with GitHub was (issue #239): admin while their realm is a GitHub realm that is on. */
export interface GithubAdmin { realm: string; subject: string }
/** A super admin (issue #242): one identity, by its realm and subject; admin, and a super admin, while that realm is on. */
export interface SuperAdmin { realm: string; subject: string }

export interface AuthConfig {
  local: { enabled: boolean };
  /** null: off. */
  none: NoSignInConfig | null;
  /** null: nobody has signed in with GitHub since the rule came (issue #239). */
  githubAdmin: GithubAdmin | null;
  /** The super admins (issue #242). Not stored yet: the first GitHub admin, else nobody. */
  superAdmins: SuperAdmin[];
  /** In order: the order the username and password form tries them and the sign-in buttons show. */
  realms: RealmConfig[];
}

/** The config record that holds it. */
export const SIGN_IN = 'sign-in';
/** Identities of the login code and no sign-in carry these as their realm; `complete` is a sign-in route. */
const RESERVED = ['local', 'complete', 'none'];

const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]'];
/** https, or http to loopback (a local test IdP). */
const endpoint = z.url().refine((u) => { const x = new URL(u); return x.protocol === 'https:' || (x.protocol === 'http:' && LOOPBACK.includes(x.hostname)); },
  'must be https (http only to 127.0.0.1 or localhost)');
const list = z.array(z.string().min(1)).optional();
const roleMatch = z.strictObject({ subjects: list, usernames: list, emails: list, emailDomains: list, groups: list });
const roles = z.strictObject({
  admin: roleMatch.optional(), operator: roleMatch.optional(), viewer: roleMatch.optional(),
  defaultRole: z.enum(UI_ROLES).nullable().optional(),
}).default({});
const base = {
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/, 'must be lowercase letters, digits and dashes (it is a URL path segment)')
    .refine((n) => !RESERVED.includes(n), `must not be ${RESERVED.join(' or ')}`),
  label: z.string().min(1).optional(),
  enabled: z.boolean().default(true),
};
const secret = { clientSecret: z.string().min(1).optional() };
/** ldaps, or ldap with StartTLS, or ldap to loopback (a local test directory). */
const ldapUrl = z.string().refine((u) => { try { return ['ldap:', 'ldaps:'].includes(new URL(u).protocol); } catch { return false; } }, 'must be an ldap:// or ldaps:// URL');
const ldap = z.strictObject({
  ...base, type: z.literal('ldap'), url: ldapUrl, startTls: z.boolean().default(false),
  bindDn: z.string().min(1).optional(), bindPassword: z.string().min(1).optional(),
  userBase: z.string().min(1),
  userFilter: z.string().includes('{username}', 'must contain {username}').default('(uid={username})'),
  attributes: z.strictObject({
    subject: z.string().min(1).optional(), username: z.string().default('uid'), email: z.string().default('mail'),
    name: z.string().default('cn'), groups: z.string().default('memberOf'),
  }).default({ username: 'uid', email: 'mail', name: 'cn', groups: 'memberOf' }),
  groupSearch: z.strictObject({
    base: z.string().min(1), filter: z.string().includes('{dn}', 'must contain {dn}').default('(member={dn})'), name: z.string().default('cn'),
  }).optional(),
  roles,
});
const oidcClaims = z.strictObject({
  email: z.string().default('email'), username: z.string().default('preferred_username'),
  name: z.string().default('name'), groups: z.string().default('groups'),
}).default({ email: 'email', username: 'preferred_username', name: 'name', groups: 'groups' });
const oidc = z.strictObject({
  ...base, ...secret, type: z.literal('oidc'), issuer: endpoint, clientId: z.string().min(1),
  scopes: z.array(z.string().min(1)).default(['openid', 'email', 'profile']),
  claims: oidcClaims,
  trustUnverifiedEmail: z.boolean().default(false),
  roles,
});
const github = z.strictObject({ ...base, type: z.literal('github'), roles });
const saml = z.strictObject({
  ...base, type: z.literal('saml'), entryPoint: endpoint,
  idpCert: z.string().min(1),
  entityId: z.string().min(1).optional(),
  idpIssuer: z.string().min(1).optional(),
  attributes: z.strictObject({
    email: z.string().default('email'), username: z.string().optional(), name: z.string().default('displayName'), groups: z.string().default('groups'),
  }).default({ email: 'email', name: 'displayName', groups: 'groups' }),
  requireSignedResponse: z.boolean().default(false),
  roles,
});
const gateway = z.strictObject({
  ...base, ...secret, type: z.literal('gateway'), issuer: endpoint,
  check: z.enum(['jwt', 'introspection']).default('jwt'),
  audience: z.array(z.string().min(1)).optional(),
  header: z.string().regex(/^[A-Za-z0-9-]+$/, 'must be an HTTP header name').transform((x) => x.toLowerCase()).default('authorization'),
  clientId: z.string().min(1).optional(),
  claims: oidcClaims,
  trustUnverifiedEmail: z.boolean().default(false),
  roles,
});
const realm = z.discriminatedUnion('type', [ldap, oidc, github, saml, gateway]);
const schema = z.strictObject({
  version: z.literal(1),
  local: z.strictObject({ enabled: z.boolean().default(true) }).default({ enabled: true }),
  none: z.strictObject({ role: z.enum(UI_ROLES) }).optional(),
  githubAdmin: z.strictObject({ realm: z.string().min(1), subject: z.string().min(1) }).optional(),
  superAdmins: z.array(z.strictObject({ realm: z.string().min(1), subject: z.string().min(1) })).optional(),
  realms: z.array(realm).default([]),
}).superRefine((doc, ctx) => {
  doc.realms.forEach((r, i) => {
    const at = (...path: (string | number)[]) => ['realms', i, ...path];
    if (doc.realms.findIndex((q) => q.name === r.name) !== i) ctx.addIssue({ code: 'custom', path: at('name'), message: `${r.name} is named twice; names must be unique` });
    // A realm can be set up before its secret is at hand; it needs it to be on.
    if (r.type === 'gateway') {
      if (r.check === 'jwt' && !r.audience?.length) ctx.addIssue({ code: 'custom', path: at('audience'), message: 'checking JWTs needs audience: the aud values a token for the hopper carries' });
      if (r.check === 'introspection' && r.clientId === undefined) ctx.addIssue({ code: 'custom', path: at('clientId'), message: 'introspection needs clientId: the hopper\'s client at the issuer' });
      if (r.enabled && r.check === 'introspection' && r.clientSecret === undefined) ctx.addIssue({ code: 'custom', path: at('clientSecret'), message: 'introspection needs its client secret' });
    }
    if (r.type === 'ldap') {
      const u = new URL(r.url);
      if (u.protocol === 'ldap:' && !r.startTls && !LOOPBACK.includes(u.hostname)) ctx.addIssue({ code: 'custom', path: at('url'), message: 'must be ldaps://, or ldap:// with startTls: true (plain ldap only to 127.0.0.1 or localhost)' });
      if (r.enabled && r.bindDn !== undefined && r.bindPassword === undefined) ctx.addIssue({ code: 'custom', path: at('bindPassword'), message: 'a bindDn needs its bind password' });
    }
  });
});

type ParsedRealm = z.output<typeof realm>;

/** The realm with its label. */
function resolve(r: ParsedRealm): RealmConfig {
  const label = r.label ?? r.name;
  return { ...r, label };
}

/** What is wrong with `raw` as a sign-in config, each where it is; empty when it is valid. */
export function signInConfigIssues(raw: unknown): { path: PropertyKey[]; message: string }[] {
  const r = schema.safeParse(raw ?? {});
  return r.success ? [] : r.error.issues.map((x) => ({ path: x.path, message: x.message }));
}

/** Why `raw` is not a valid sign-in config, or undefined. */
export function signInConfigProblem(raw: unknown): string | undefined {
  const issues = signInConfigIssues(raw);
  return issues.length ? issues.map((x) => `${x.path.map(String).join('.') || '(config)'}: ${x.message}`).join('; ') : undefined;
}

/** The sign-in config (undefined: none yet → local sign-in only). Throws on anything invalid. */
export function loadSignInConfig(raw: unknown): AuthConfig {
  if (raw === undefined) return { local: { enabled: true }, none: null, githubAdmin: null, superAdmins: [], realms: [] };
  const problem = signInConfigProblem(raw);
  if (problem) throw new Error(`invalid sign-in config: ${problem}`);
  const r = schema.parse(raw ?? {});
  const superAdmins = r.superAdmins ?? (r.githubAdmin ? [r.githubAdmin] : []);
  return { local: r.local, none: r.none ?? null, githubAdmin: r.githubAdmin ?? null, superAdmins, realms: r.realms.map(resolve) };
}

/** The realm types that send the browser to an identity provider. */
export const isRedirectRealm = (r: { type: RealmType }): r is OidcRealmConfig | SamlRealmConfig => REDIRECT_REALM_TYPES.includes(r.type);
export const isDeviceRealm = (r: { type: RealmType }): r is DeviceRealmConfig => DEVICE_REALM_TYPES.includes(r.type);
export const isGatewayRealm = (r: { type: RealmType }): r is GatewayRealmConfig => r.type === 'gateway';

/** The settings of each realm type that are secrets: stored, never answered back (issue #216). */
export const SECRET_SETTINGS: Readonly<Record<RealmType, readonly string[]>> = {
  saml: [], ldap: ['bindPassword'], oidc: ['clientSecret'], github: [], gateway: ['clientSecret'],
};

/** The realm types whose people sign in through the username and password form. */
export const isFormRealm = (r: { type: RealmType }): r is LdapRealmConfig => FORM_REALM_TYPES.includes(r.type);
