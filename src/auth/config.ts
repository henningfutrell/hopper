// The sign-in config (design.md "Sign-in: realms"): how people sign in, the instance's config record
// `sign-in` (design.md "Config in the database"). Loaded at start and after every change from Settings →
// Sign-in; an invalid one stops the daemon at start, naming the field, and is refused by the UI (sign-in
// fails closed). None → the one-time login code only. `realms` is the ordered list of realms, each of a
// realm type, on unless `enabled: false`; `local` (the login code) and `none` (no sign-in) are not realms.
// A secret comes from the environment only (`clientSecretEnv`, `bindPasswordEnv`, design.md "Secrets"),
// read only for a realm that is on; a SAML IdP certificate is public and sits inline.
import { z } from 'zod';
import { FORM_REALM_TYPES, UI_ROLES, type RealmType, type UiRole } from '../domain/types.ts';
import type { RoleRules } from './roles.ts';

interface RealmBase { name: string; label: string; enabled: boolean }
/** One password realm account: an argon2id hash (`hopper password-hash`), never the password. */
export interface PasswordUser { username: string; passwordHash: string; role: UiRole }
export interface PasswordRealmConfig extends RealmBase { type: 'password'; users: PasswordUser[] }
export interface LdapRealmConfig extends RealmBase {
  type: 'ldap';
  url: string;
  startTls: boolean;
  /** Absent: an anonymous search. */
  bindDn?: string;
  /** From `bindPasswordEnv`; absent with `bindDn`. Empty when the realm is off. */
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
export interface GithubRealmConfig extends RealmBase {
  type: 'github';
  clientId: string;
  /** Empty when the realm is off. */
  clientSecret: string;
  webUrl: string;
  apiUrl: string;
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
export type RealmConfig = PasswordRealmConfig | LdapRealmConfig | OidcRealmConfig | GithubRealmConfig | SamlRealmConfig;
/** No sign-in: everyone who reaches the UI gets a session with this role. */
export interface NoSignInConfig { role: UiRole }
export interface AuthConfig {
  local: { enabled: boolean };
  /** null: off. */
  none: NoSignInConfig | null;
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
const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'must be an environment variable name');
const base = {
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/, 'must be lowercase letters, digits and dashes (it is a URL path segment)')
    .refine((n) => !RESERVED.includes(n), `must not be ${RESERVED.join(' or ')}`),
  label: z.string().min(1).optional(),
  enabled: z.boolean().default(true),
};
const secret = { clientSecretEnv: envName.optional() };
const passwordUser = z.strictObject({
  username: z.string().min(1).max(128),
  passwordHash: z.string().startsWith('$argon2id$', 'must be an argon2id hash: hopper password-hash'),
  role: z.enum(UI_ROLES),
});
const password = z.strictObject({ ...base, type: z.literal('password'), users: z.array(passwordUser) });
/** ldaps, or ldap with StartTLS, or ldap to loopback (a local test directory). */
const ldapUrl = z.string().refine((u) => { try { return ['ldap:', 'ldaps:'].includes(new URL(u).protocol); } catch { return false; } }, 'must be an ldap:// or ldaps:// URL');
const ldap = z.strictObject({
  ...base, type: z.literal('ldap'), url: ldapUrl, startTls: z.boolean().default(false),
  bindDn: z.string().min(1).optional(), bindPasswordEnv: envName.optional(),
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
const oidc = z.strictObject({
  ...base, ...secret, type: z.literal('oidc'), issuer: endpoint, clientId: z.string().min(1),
  scopes: z.array(z.string().min(1)).default(['openid', 'email', 'profile']),
  claims: z.strictObject({
    email: z.string().default('email'), username: z.string().default('preferred_username'),
    name: z.string().default('name'), groups: z.string().default('groups'),
  }).default({ email: 'email', username: 'preferred_username', name: 'name', groups: 'groups' }),
  trustUnverifiedEmail: z.boolean().default(false),
  roles,
});
const github = z.strictObject({
  ...base, ...secret, type: z.literal('github'), clientId: z.string().min(1),
  webUrl: endpoint.default('https://github.com'), apiUrl: endpoint.default('https://api.github.com'),
  roles,
});
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
const realm = z.discriminatedUnion('type', [password, ldap, oidc, github, saml]);
const schema = z.strictObject({
  version: z.literal(1),
  local: z.strictObject({ enabled: z.boolean().default(true) }).default({ enabled: true }),
  none: z.strictObject({ role: z.enum(UI_ROLES) }).optional(),
  realms: z.array(realm).default([]),
}).superRefine((doc, ctx) => {
  doc.realms.forEach((r, i) => {
    const at = (...path: (string | number)[]) => ['realms', i, ...path];
    if (doc.realms.findIndex((q) => q.name === r.name) !== i) ctx.addIssue({ code: 'custom', path: at('name'), message: `${r.name} is named twice; names must be unique` });
    if (r.type === 'github' && r.clientSecretEnv === undefined) ctx.addIssue({ code: 'custom', path: at('clientSecretEnv'), message: 'GitHub needs clientSecretEnv: the variable holding its client secret' });
    if (r.type === 'ldap') {
      const u = new URL(r.url);
      if (u.protocol === 'ldap:' && !r.startTls && !LOOPBACK.includes(u.hostname)) ctx.addIssue({ code: 'custom', path: at('url'), message: 'must be ldaps://, or ldap:// with startTls: true (plain ldap only to 127.0.0.1 or localhost)' });
      if (r.bindDn !== undefined && r.bindPasswordEnv === undefined) ctx.addIssue({ code: 'custom', path: at('bindPasswordEnv'), message: 'a bindDn needs bindPasswordEnv: the variable holding its password' });
    }
    if (r.type === 'password') {
      r.users.forEach((u, j) => {
        if (r.users.findIndex((v) => v.username.toLowerCase() === u.username.toLowerCase()) !== j) {
          ctx.addIssue({ code: 'custom', path: at('users', j, 'username'), message: `${u.username} is named twice; usernames must be unique (case does not count)` });
        }
      });
    }
  });
});

type Env = (name: string) => string | undefined;
type ParsedRealm = z.output<typeof realm>;

function readSecretEnv(env: Env, name: string, field: string): string {
  const v = env(name);
  if (v === undefined || v === '') throw new Error(`invalid sign-in config: ${field}: environment variable ${name} is not set`);
  return v;
}

/** The realm with its label and, when it is on, its secret from the environment. */
function resolve(r: ParsedRealm, i: number, env: Env): RealmConfig {
  const label = r.label ?? r.name;
  const secretOf = (name: string | undefined, field: string): string | undefined =>
    (name === undefined ? undefined : r.enabled ? readSecretEnv(env, name, `realms.${i}.${field}`) : '');
  if (r.type === 'password' || r.type === 'saml') return { ...r, label };
  if (r.type === 'ldap') {
    const { bindPasswordEnv, ...rest } = r;
    const s = secretOf(bindPasswordEnv, 'bindPasswordEnv');
    return { ...rest, label, ...(s === undefined ? {} : { bindPassword: s }) };
  }
  const { clientSecretEnv, ...rest } = r;
  const s = secretOf(clientSecretEnv, 'clientSecretEnv');
  return rest.type === 'github' ? { ...rest, label, clientSecret: s! } : { ...rest, label, ...(s === undefined ? {} : { clientSecret: s }) };
}

/** Why `raw` is not a valid sign-in config, or undefined; the variables it names are not checked. */
export function signInConfigProblem(raw: unknown): string | undefined {
  const r = schema.safeParse(raw ?? {});
  return r.success ? undefined : r.error.issues.map((x) => `${x.path.join('.') || '(config)'}: ${x.message}`).join('; ');
}

/** The sign-in config (undefined: none yet → local sign-in only), its secrets from `env`. Throws on anything invalid. */
export function loadSignInConfig(raw: unknown, env: Env): AuthConfig {
  if (raw === undefined) return { local: { enabled: true }, none: null, realms: [] };
  const problem = signInConfigProblem(raw);
  if (problem) throw new Error(`invalid sign-in config: ${problem}`);
  const r = schema.parse(raw ?? {});
  return { local: r.local, none: r.none ?? null, realms: r.realms.map((x, i) => resolve(x, i, env)) };
}

/** The realm types whose people sign in through the username and password form. */
export const isFormRealm = (r: { type: RealmType }): r is PasswordRealmConfig | LdapRealmConfig => FORM_REALM_TYPES.includes(r.type);
