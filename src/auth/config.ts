// auth.yaml (design.md "Sign-in: local, OIDC and SAML" — Configuration): how people sign in, a config
// document in the store (design.md "Config documents"). Read once at start; an invalid document stops
// the daemon, naming the field (sign-in fails closed). None → the one-time login code only. A client
// secret comes from the environment only (`clientSecretEnv`, design.md "Secrets"); a SAML IdP
// certificate is public and sits inline.
import { parse } from 'yaml';
import { z } from 'zod';
import { UI_ROLES } from '../domain/types.ts';
import type { RoleRules } from './roles.ts';

interface ProviderBase { name: string; label: string; roles: RoleRules }
export interface OidcProviderConfig extends ProviderBase {
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
}
export interface GithubProviderConfig extends ProviderBase {
  type: 'github';
  clientId: string;
  clientSecret: string;
  webUrl: string;
  apiUrl: string;
}
export interface SamlProviderConfig extends ProviderBase {
  type: 'saml';
  entryPoint: string;
  idpCert: string;
  /** The SP entity id; absent: `<sign-in origin>/ui/auth/<name>/metadata`. */
  entityId?: string;
  /** The identity provider's entity id; when set, a response from another issuer is refused. */
  idpIssuer?: string;
  attributes: { email: string; username?: string; name: string; groups: string };
  requireSignedResponse: boolean;
}
export type ProviderConfig = OidcProviderConfig | GithubProviderConfig | SamlProviderConfig;
export interface AuthConfig { local: { enabled: boolean }; providers: ProviderConfig[] }

export const AUTH = 'auth.yaml';
/** Provider names are URL path segments; these two are taken by the routes. */
const RESERVED = ['local', 'complete'];

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
  roles,
};
const secret = { clientSecretEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'must be an environment variable name').optional() };
const oidc = z.strictObject({
  ...base, ...secret, type: z.literal('oidc'), issuer: endpoint, clientId: z.string().min(1),
  scopes: z.array(z.string().min(1)).default(['openid', 'email', 'profile']),
  claims: z.strictObject({
    email: z.string().default('email'), username: z.string().default('preferred_username'),
    name: z.string().default('name'), groups: z.string().default('groups'),
  }).default({ email: 'email', username: 'preferred_username', name: 'name', groups: 'groups' }),
  trustUnverifiedEmail: z.boolean().default(false),
});
const github = z.strictObject({
  ...base, ...secret, type: z.literal('github'), clientId: z.string().min(1),
  webUrl: endpoint.default('https://github.com'), apiUrl: endpoint.default('https://api.github.com'),
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
});
const provider = z.discriminatedUnion('type', [oidc, github, saml]);
const schema = z.strictObject({
  version: z.literal(1),
  local: z.strictObject({ enabled: z.boolean().default(true) }).default({ enabled: true }),
  providers: z.array(provider).default([]),
}).superRefine((doc, ctx) => {
  doc.providers.forEach((p, i) => {
    if (doc.providers.findIndex((q) => q.name === p.name) !== i) ctx.addIssue({ code: 'custom', path: ['providers', i, 'name'], message: `${p.name} is named twice; names must be unique` });
    if (p.type === 'github' && p.clientSecretEnv === undefined) ctx.addIssue({ code: 'custom', path: ['providers', i, 'clientSecretEnv'], message: 'GitHub needs clientSecretEnv: the variable holding its client secret' });
  });
});

type Env = (name: string) => string | undefined;

function readSecretEnv(env: Env, name: string, field: string): string {
  const v = env(name);
  if (v === undefined || v === '') throw new Error(`invalid auth.yaml: ${field}: environment variable ${name} is not set`);
  return v;
}

function resolve(p: z.output<typeof provider>, i: number, env: Env): ProviderConfig {
  const label = p.label ?? p.name;
  if (p.type === 'saml') return { ...p, label };
  const { clientSecretEnv, ...rest } = p;
  const s = clientSecretEnv === undefined ? undefined : readSecretEnv(env, clientSecretEnv, `providers.${i}.clientSecretEnv`);
  return p.type === 'github' ? { ...rest, type: 'github', label, clientSecret: s! } as GithubProviderConfig
    : { ...rest, type: 'oidc', label, ...(s === undefined ? {} : { clientSecret: s }) } as OidcProviderConfig;
}

/** Why `raw` (parsed YAML) is not a valid auth.yaml, or undefined; the variables it names are not checked. */
export function authDocumentProblem(raw: unknown): string | undefined {
  const r = schema.safeParse(raw ?? {});
  return r.success ? undefined : r.error.issues.map((x) => `${x.path.join('.') || '(document)'}: ${x.message}`).join('; ');
}

/** auth.yaml's text (undefined: none yet → local sign-in only), its secrets from `env`. Throws on anything invalid. */
export function loadAuthDocument(text: string | undefined, env: Env): AuthConfig {
  if (text === undefined) return { local: { enabled: true }, providers: [] };
  let doc: unknown;
  try { doc = parse(text); } catch (e) { throw new Error(`invalid auth.yaml: ${(e as Error).message}`, { cause: e }); }
  const problem = authDocumentProblem(doc);
  if (problem) throw new Error(`invalid auth.yaml: ${problem}`);
  const r = schema.parse(doc ?? {});
  return { local: r.local, providers: r.providers.map((p, i) => resolve(p, i, env)) };
}
