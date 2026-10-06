// A realm's form (issue #200, docs/sign-in.md): the fields of each realm type, and the conversion
// between a realm's stored settings and the form's draft. A field left empty is left out, so the
// daemon's default applies (shown as the placeholder). A secret (issue #216) is typed, never shown: left
// empty it keeps the stored one, removed it is sent as null. Role rules are rows — a role, what it
// matches, one value per line — and a default role. Pure: the view renders it, the daemon checks the result.
import type { RealmSettings, RealmType, UiRole } from './wire';

export type FieldKind = 'text' | 'multiline' | 'switch' | 'words' | 'secret';

export interface RealmField {
  /** Where it sits in the settings: `url`, `attributes.email`. */
  path: string;
  label: string;
  kind: FieldKind;
  placeholder?: string;
  help?: string;
}


export const REALM_FIELDS: Record<RealmType, RealmField[]> = {
  ldap: [
    { path: 'url', label: 'Directory URL', kind: 'text', placeholder: 'ldaps://ldap.example.com' },
    { path: 'startTls', label: 'StartTLS', kind: 'switch', help: 'needed for a plain ldap:// URL that is not on this machine' },
    { path: 'bindDn', label: 'Bind DN', kind: 'text', placeholder: 'cn=hopper,ou=services,dc=example,dc=com', help: 'empty: an anonymous search' },
    { path: 'bindPassword', label: 'Bind password', kind: 'secret' },
    { path: 'userBase', label: 'User base', kind: 'text', placeholder: 'ou=people,dc=example,dc=com' },
    { path: 'userFilter', label: 'User filter', kind: 'text', placeholder: '(uid={username})' },
    { path: 'attributes.subject', label: 'Subject attribute', kind: 'text', placeholder: 'the entry\'s DN', help: 'a stable id, such as entryUUID or objectGUID' },
    { path: 'attributes.username', label: 'Username attribute', kind: 'text', placeholder: 'uid' },
    { path: 'attributes.email', label: 'Email attribute', kind: 'text', placeholder: 'mail' },
    { path: 'attributes.name', label: 'Name attribute', kind: 'text', placeholder: 'cn' },
    { path: 'attributes.groups', label: 'Group attribute', kind: 'text', placeholder: 'memberOf' },
    { path: 'groupSearch.base', label: 'Group search base', kind: 'text', placeholder: 'ou=groups,dc=example,dc=com', help: 'empty: no group search' },
    { path: 'groupSearch.filter', label: 'Group search filter', kind: 'text', placeholder: '(member={dn})' },
    { path: 'groupSearch.name', label: 'Group name attribute', kind: 'text', placeholder: 'cn' },
  ],
  oidc: [
    { path: 'issuer', label: 'Issuer URL', kind: 'text', placeholder: 'https://idp.example.com' },
    { path: 'clientId', label: 'Client ID', kind: 'text' },
    { path: 'clientSecret', label: 'Client secret', kind: 'secret', help: 'none: a public client' },
    { path: 'scopes', label: 'Scopes', kind: 'words', placeholder: 'openid email profile' },
    { path: 'claims.email', label: 'Email claim', kind: 'text', placeholder: 'email' },
    { path: 'claims.username', label: 'Username claim', kind: 'text', placeholder: 'preferred_username' },
    { path: 'claims.name', label: 'Name claim', kind: 'text', placeholder: 'name' },
    { path: 'claims.groups', label: 'Groups claim', kind: 'text', placeholder: 'groups' },
    { path: 'trustUnverifiedEmail', label: 'Trust unverified email', kind: 'switch', help: 'count the email even when the identity provider does not mark it verified' },
  ],
  // GitHub signs in through the hopper's app (issue #214): nothing to set but the role rules.
  github: [],
  gateway: [
    { path: 'issuer', label: 'Issuer URL', kind: 'text', placeholder: 'https://idp.example.com', help: 'the issuer of the tokens the auth gateway forwards' },
    { path: 'check', label: 'Check', kind: 'text', placeholder: 'jwt', help: 'jwt: verify the token against the issuer\'s keys; introspection: ask the issuer' },
    { path: 'audience', label: 'Audience', kind: 'words', placeholder: 'hopper', help: 'a token must name one of these in aud; needed to check JWTs' },
    { path: 'header', label: 'Token header', kind: 'text', placeholder: 'authorization', help: 'the header the gateway forwards the token in; authorization carries "Bearer <token>"' },
    { path: 'clientId', label: 'Client ID', kind: 'text', help: 'introspection: the hopper\'s client at the issuer' },
    { path: 'clientSecret', label: 'Client secret', kind: 'secret', help: 'introspection: the hopper\'s client secret at the issuer' },
    { path: 'claims.email', label: 'Email claim', kind: 'text', placeholder: 'email' },
    { path: 'claims.username', label: 'Username claim', kind: 'text', placeholder: 'preferred_username' },
    { path: 'claims.name', label: 'Name claim', kind: 'text', placeholder: 'name' },
    { path: 'claims.groups', label: 'Groups claim', kind: 'text', placeholder: 'groups' },
    { path: 'trustUnverifiedEmail', label: 'Trust unverified email', kind: 'switch', help: 'count the email even when the issuer does not mark it verified' },
  ],
  saml: [
    { path: 'entryPoint', label: 'Sign-on URL', kind: 'text', placeholder: 'https://idp.example.com/sso/saml' },
    { path: 'idpCert', label: 'Identity provider certificate', kind: 'multiline', placeholder: '-----BEGIN CERTIFICATE-----' },
    { path: 'idpIssuer', label: 'Identity provider issuer', kind: 'text', placeholder: 'https://idp.example.com/metadata', help: 'when set, a response from another issuer is refused' },
    { path: 'entityId', label: 'Entity ID', kind: 'text', placeholder: 'this realm\'s metadata URL' },
    { path: 'attributes.email', label: 'Email attribute', kind: 'text', placeholder: 'email' },
    { path: 'attributes.username', label: 'Username attribute', kind: 'text' },
    { path: 'attributes.name', label: 'Name attribute', kind: 'text', placeholder: 'displayName' },
    { path: 'attributes.groups', label: 'Groups attribute', kind: 'text', placeholder: 'groups' },
    { path: 'requireSignedResponse', label: 'Require a signed response', kind: 'switch' },
  ],
};

export const REALM_TYPE_LABELS: { type: RealmType; label: string }[] = [
  { type: 'ldap', label: 'LDAP or Active Directory' },
  { type: 'oidc', label: 'OpenID Connect' },
  { type: 'github', label: 'GitHub (through the hopper\'s app)' },
  { type: 'saml', label: 'SAML' },
  { type: 'gateway', label: 'Auth gateway in front of the hopper (it signs people in)' },
];

/** What a role rule matches on. */
export type RuleMatch = 'subjects' | 'usernames' | 'emails' | 'emailDomains' | 'groups';
export const RULE_MATCHES: { match: RuleMatch; label: string }[] = [
  { match: 'emails', label: 'emails' },
  { match: 'emailDomains', label: 'email domains' },
  { match: 'groups', label: 'groups' },
  { match: 'usernames', label: 'usernames' },
  { match: 'subjects', label: 'subjects' },
];
const RULE_ROLES: UiRole[] = ['admin', 'operator', 'viewer'];

/** One role rule as a row: who it matches gets `role`. `values`: one per line. */
export interface RoleRule { role: UiRole; match: RuleMatch; values: string }

export interface RealmDraft {
  name: string;
  label: string;
  type: RealmType;
  /** A secret's value is only what was typed; null: remove the stored one. */
  values: Record<string, string | boolean | null>;
  /** The secrets the stored realm has. */
  secrets: string[];
  rules: RoleRule[];
  /** '' : no default — someone no rule matches gets no session. */
  defaultRole: UiRole | '';
}

const at = (o: unknown, path: string): unknown => path.split('.').reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), o);

function setAt(o: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  let cur = o;
  for (const k of keys.slice(0, -1)) cur = (cur[k] ??= {}) as Record<string, unknown>;
  cur[keys.at(-1)!] = value;
}

/** A new realm's draft. */
export const emptyDraft = (type: RealmType): RealmDraft => ({ name: '', label: '', type, values: {}, secrets: [], rules: [], defaultRole: '' });

/** The draft of a stored realm. */
export function draftOf(r: { name: string; label: string; type: RealmType; settings: RealmSettings; secrets: string[] }): RealmDraft {
  const values: Record<string, string | boolean | null> = {};
  for (const f of REALM_FIELDS[r.type]) {
    if (f.kind === 'secret') continue;
    const v = at(r.settings, f.path);
    if (v === undefined || v === null) continue;
    values[f.path] = f.kind === 'switch' ? v === true : Array.isArray(v) ? v.join(' ') : String(v);
  }
  const roles = (r.settings.roles ?? {}) as Partial<Record<UiRole, Partial<Record<RuleMatch, string[]>>>> & { defaultRole?: UiRole | null };
  const rules = RULE_ROLES.flatMap((role) => RULE_MATCHES.flatMap(({ match }) => {
    const list = roles[role]?.[match];
    return list?.length ? [{ role, match, values: list.join('\n') }] : [];
  }));
  return { name: r.name, label: r.label === r.name ? '' : r.label, type: r.type, values, secrets: r.secrets, rules, defaultRole: roles.defaultRole ?? '' };
}

/** The realm a draft saves: name, label (when set), type, and the fields that are filled in. */
export function realmOf(d: RealmDraft): { name: string; label?: string; type: RealmType } & RealmSettings {
  const settings: Record<string, unknown> = {};
  for (const f of REALM_FIELDS[d.type]) {
    const v = d.values[f.path];
    if (f.kind === 'switch') { if (v === true) setAt(settings, f.path, true); continue; }
    if (f.kind === 'secret' && v === null) { setAt(settings, f.path, null); continue; }
    const text = typeof v === 'string' ? v.trim() : '';
    if (text === '') continue;
    setAt(settings, f.path, f.kind === 'words' ? text.split(/[\s,]+/).filter(Boolean) : text);
  }
  const roles: Record<string, unknown> = {};
  for (const r of d.rules) {
    const values = r.values.split('\n').map((v) => v.trim()).filter(Boolean);
    if (values.length === 0) continue;
    const rule = (roles[r.role] ??= {}) as Record<string, string[]>;
    rule[r.match] = [...(rule[r.match] ?? []), ...values];
  }
  if (d.defaultRole !== '') roles.defaultRole = d.defaultRole;
  if (Object.keys(roles).length > 0) settings.roles = roles;
  const label = d.label.trim();
  return { name: d.name.trim(), ...(label === '' ? {} : { label }), type: d.type, ...settings };
}
