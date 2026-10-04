// auth.yaml (design.md "Sign-in: local, OIDC and SAML" — Configuration): how people sign in. Read once
// at start; an invalid file stops the daemon, naming the field (sign-in fails closed). No file →
// the one-time login code only. Secrets may sit inline (the file is 0600), in their own files, or in
// environment variables.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
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

export const DEFAULT_AUTH_FILE = '~/.config/job-hopper/auth.yaml';
/** Provider names are URL path segments; these two are taken by the routes. */
const RESERVED = ['local', 'complete'];

const expandHome = (p: string): string => (p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);
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
const secret = { clientSecret: z.string().min(1).optional(), clientSecretFile: z.string().min(1).optional(), clientSecretEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'must be an environment variable name').optional() };
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
  idpCert: z.string().min(1).optional(), idpCertFile: z.string().min(1).optional(),
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
    const secrets = p.type === 'saml' ? 0 : [p.clientSecret, p.clientSecretFile, p.clientSecretEnv].filter((x) => x !== undefined).length;
    if (secrets > 1) ctx.addIssue({ code: 'custom', path: ['providers', i, 'clientSecret'], message: 'set one of clientSecret, clientSecretFile and clientSecretEnv' });
    if (p.type === 'github' && secrets === 0) ctx.addIssue({ code: 'custom', path: ['providers', i, 'clientSecret'], message: 'GitHub needs clientSecret, clientSecretFile or clientSecretEnv' });
    if (p.type === 'saml' && (p.idpCert === undefined) === (p.idpCertFile === undefined)) ctx.addIssue({ code: 'custom', path: ['providers', i, 'idpCert'], message: 'set exactly one of idpCert and idpCertFile' });
  });
});

function readSecretFile(path: string, field: string): string {
  const p = expandHome(path);
  try {
    if (statSync(p).mode & 0o077) console.warn(`job-hopper: WARNING: ${p} (${field}) is readable by others; chmod 600 it`);
    return readFileSync(p, 'utf8').trim();
  } catch (e) {
    throw new Error(`invalid auth.yaml: ${field}: cannot read ${p}: ${(e as Error).message}`, { cause: e });
  }
}

function readSecretEnv(name: string, field: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') throw new Error(`invalid auth.yaml: ${field}: environment variable ${name} is not set`);
  return v;
}

function resolve(p: z.output<typeof provider>, i: number): ProviderConfig {
  const at = `providers.${i}`;
  const label = p.label ?? p.name;
  if (p.type === 'saml') {
    const { idpCertFile, idpCert, ...rest } = p;
    return { ...rest, label, idpCert: idpCert ?? readSecretFile(idpCertFile!, `${at}.idpCertFile`) };
  }
  const { clientSecretFile, clientSecretEnv, clientSecret, ...rest } = p;
  const s = clientSecret
    ?? (clientSecretFile === undefined ? undefined : readSecretFile(clientSecretFile, `${at}.clientSecretFile`))
    ?? (clientSecretEnv === undefined ? undefined : readSecretEnv(clientSecretEnv, `${at}.clientSecretEnv`));
  return p.type === 'github' ? { ...rest, type: 'github', label, clientSecret: s! } as GithubProviderConfig
    : { ...rest, type: 'oidc', label, ...(s === undefined ? {} : { clientSecret: s }) } as OidcProviderConfig;
}

/** auth.yaml at `path`, or local sign-in only when there is none. Throws on anything invalid. */
export function loadAuthFile(path: string): AuthConfig {
  const p = expandHome(path);
  if (!existsSync(p)) return { local: { enabled: true }, providers: [] };
  if (statSync(p).mode & 0o077) console.warn(`job-hopper: WARNING: ${p} is readable by others; chmod 600 it`);
  let doc: unknown;
  try { doc = parse(readFileSync(p, 'utf8')); } catch (e) { throw new Error(`invalid auth.yaml: ${(e as Error).message}`, { cause: e }); }
  const r = schema.safeParse(doc ?? {});
  if (!r.success) throw new Error(`invalid auth.yaml: ${r.error.issues.map((x) => `${x.path.join('.') || '(file)'}: ${x.message}`).join('; ')}`);
  return { local: r.data.local, providers: r.data.providers.map(resolve) };
}
