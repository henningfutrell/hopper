// Sign-in from the environment (issue #216, docs/sign-in.md "Sign-in from the environment"): realms, the
// login code and no sign-in set up at launch by HOPPER_SIGN_IN_* variables, the way Grafana takes its
// settings — for a deploy that sets the hopper up from its environment, with no config file and no
// persistent volume. A realm is HOPPER_SIGN_IN_REALM_<NAME>_TYPE plus one variable per setting:
// HOPPER_SIGN_IN_REALM_<NAME>_<SETTING>, the setting its field path in upper snake case (`claims.groups`
// → CLAIMS_GROUPS); the name's underscores are dashes. Every value may come from the file
// <variable>_FILE names instead (a mounted secret, design.md "Secrets"). Read at each start; what it
// sets is applied to the stored sign-in config (`applySignInEnvironment`) — the environment wins.
import { runtimeSecrets } from '../secrets/runtime.ts';
import { REALM_TYPES, UI_ROLES, type RealmType, type UiRole } from '../domain/types.ts';
import type { StoredRealm, StoredSignIn } from '../domain/store.ts';
import { signInConfigIssues } from './config.ts';

/** What the environment sets: its realms (in name order), and the rest only where it says. */
export interface SignInEnvironment {
  realms: StoredRealm[];
  /** The login code on or off. */
  local?: boolean;
  /** No sign-in's role; null: off. */
  none?: UiRole | null;
}

const PREFIX = 'HOPPER_SIGN_IN_';
const REALM = `${PREFIX}REALM_`;
const LOCAL = `${PREFIX}LOCAL_ENABLED`;
const NONE = `${PREFIX}NONE_ROLE`;

/** text: as given; switch: true or false; words: split on spaces or commas; list: commas, or a JSON array (for values with commas, such as LDAP group DNs). */
type Kind = 'text' | 'switch' | 'words' | 'list';

const ROLE_RULES: [string, Kind][] = [
  ...['admin', 'operator', 'viewer'].flatMap((role) => ['subjects', 'usernames', 'emails', 'emailDomains', 'groups'].map((m): [string, Kind] => [`roles.${role}.${m}`, 'list'])),
  ['roles.defaultRole', 'text'],
];
const COMMON: [string, Kind][] = [['label', 'text'], ['enabled', 'switch']];
const text = (...paths: string[]): [string, Kind][] => paths.map((p) => [p, 'text']);

/** Every setting a realm type takes from the environment: the same fields as its form (docs/sign-in.md "Realm settings"). */
const SETTINGS: Record<RealmType, [string, Kind][]> = {
  ldap: [
    ...COMMON, ...text('url'), ['startTls', 'switch'], ...text('bindDn', 'bindPassword', 'userBase', 'userFilter',
      'attributes.subject', 'attributes.username', 'attributes.email', 'attributes.name', 'attributes.groups',
      'groupSearch.base', 'groupSearch.filter', 'groupSearch.name'), ...ROLE_RULES,
  ],
  oidc: [
    ...COMMON, ...text('issuer', 'clientId', 'clientSecret'), ['scopes', 'words'],
    ...text('claims.email', 'claims.username', 'claims.name', 'claims.groups'), ['trustUnverifiedEmail', 'switch'], ...ROLE_RULES,
  ],
  // GitHub signs in through the hopper's app (issue #214): nothing of an app here.
  github: [...COMMON, ...ROLE_RULES],
  gateway: [
    ...COMMON, ...text('issuer', 'check'), ['audience', 'words'], ...text('header', 'clientId', 'clientSecret',
      'claims.email', 'claims.username', 'claims.name', 'claims.groups'), ['trustUnverifiedEmail', 'switch'], ...ROLE_RULES,
  ],
  saml: [
    ...COMMON, ...text('entryPoint', 'idpCert', 'entityId', 'idpIssuer', 'attributes.email', 'attributes.username', 'attributes.name', 'attributes.groups'),
    ['requireSignedResponse', 'switch'], ...ROLE_RULES,
  ],
};

/** `claims.groups` → CLAIMS_GROUPS, `emailDomains` → EMAIL_DOMAINS. */
const snake = (path: string): string => path.split('.').map((p) => p.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()).join('_');

const fail = (variable: string, message: string): never => { throw new Error(`invalid sign-in environment: ${variable}: ${message}`); };

function convert(variable: string, kind: Kind, value: string): unknown {
  if (kind === 'switch') return value === 'true' ? true : value === 'false' ? false : fail(variable, 'must be true or false');
  if (kind === 'words') return value.split(/[\s,]+/).filter(Boolean);
  if (kind === 'list') {
    if (!value.trimStart().startsWith('[')) return value.split(',').map((v) => v.trim()).filter(Boolean);
    let list: unknown;
    try { list = JSON.parse(value); } catch { list = undefined; }
    return Array.isArray(list) && list.every((v) => typeof v === 'string') ? list : fail(variable, 'must be values separated by commas, or a JSON array of strings');
  }
  return value;
}

function setAt(o: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  let cur = o;
  for (const k of keys.slice(0, -1)) cur = (cur[k] ??= {}) as Record<string, unknown>;
  cur[keys.at(-1)!] = value;
}

/** The realm `key` (its name in the variables) from its variables; refused, naming the variable, unless it loads alone. */
function realmOf(key: string, variables: string[], value: (name: string) => string | undefined): StoredRealm {
  const typeVar = `${REALM}${key}_TYPE`;
  const type = value(typeVar)!;
  if (!(REALM_TYPES as readonly string[]).includes(type)) fail(typeVar, `must be one of ${REALM_TYPES.join(', ')}`);
  const name = key.toLowerCase().replaceAll('_', '-');
  const realm: StoredRealm = { name, type };
  const settings = SETTINGS[type as RealmType];
  for (const variable of variables) {
    if (variable === typeVar) continue;
    const setting = variable.slice(`${REALM}${key}_`.length);
    const field = settings.find(([path]) => snake(path) === setting);
    if (!field) fail(variable, `a ${type} realm has no setting ${setting}`);
    setAt(realm, field![0], convert(variable, field![1], value(variable)!));
  }
  const issue = signInConfigIssues({ version: 1, realms: [realm] })[0];
  if (issue) {
    const path = issue.path.slice(2).filter((p) => typeof p === 'string').join('.');
    fail(path === 'name' || path === '' ? typeVar : `${REALM}${key}_${snake(path)}`, issue.message);
  }
  return realm;
}

/** What the HOPPER_SIGN_IN_* variables of `env` set. Throws, naming the variable, on one it cannot use. */
export function readSignInEnvironment(env: Record<string, string | undefined>): SignInEnvironment {
  const value = runtimeSecrets(env);
  const read = (name: string): string | undefined => {
    try {
      return value(name);
    } catch (e) {
      return fail(name, (e as Error).message);
    }
  };
  // Each variable once, whether it is set itself or through its _FILE.
  const set = [...new Set(Object.keys(env).filter((k) => k.startsWith(PREFIX)).map((k) => k.replace(/_FILE$/, '')))]
    .filter((k) => read(k) !== undefined).sort();
  const out: SignInEnvironment = { realms: [] };
  const realmKeys = set.flatMap((k) => /^HOPPER_SIGN_IN_REALM_([A-Z0-9_]+)_TYPE$/.exec(k)?.[1] ?? []);
  const byRealm = new Map<string, string[]>();
  for (const variable of set) {
    const v = read(variable)!;
    if (variable === LOCAL) out.local = convert(variable, 'switch', v) as boolean;
    else if (variable === NONE) {
      if (v !== 'off' && !(UI_ROLES as readonly string[]).includes(v)) fail(variable, `must be one of ${UI_ROLES.join(', ')} or off`);
      out.none = v === 'off' ? null : v as UiRole;
    } else if (variable.startsWith(REALM)) {
      // The longest realm key it starts with: a realm named acme-gh is not acme's.
      const key = realmKeys.filter((k) => variable.startsWith(`${REALM}${k}_`)).sort((a, b) => b.length - a.length)[0];
      if (key === undefined) fail(variable, `no such realm: a realm is set up by ${REALM}<NAME>_TYPE`);
      byRealm.set(key!, [...byRealm.get(key!) ?? [], variable]);
    } else fail(variable, `unknown: the sign-in variables are ${REALM}<NAME>_<SETTING>, ${LOCAL} and ${NONE}`);
  }
  out.realms = [...byRealm].map(([key, variables]) => realmOf(key, variables, read)).sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * The stored sign-in config with what the environment sets: each of its realms in place of the stored
 * realm of that name, or added at the end; the login code and no
 * sign-in where it says. A new copy; `stored` is left as it was.
 */
export function applySignInEnvironment(stored: StoredSignIn, e: SignInEnvironment): StoredSignIn {
  const s = structuredClone(stored);
  for (const realm of e.realms) {
    const i = s.realms.findIndex((r) => r.name === realm.name);
    if (i < 0) s.realms.push({ ...realm });
    else s.realms[i] = { ...realm };
  }
  if (e.local !== undefined) s.local = { enabled: e.local };
  if (e.none === null) delete s.none;
  else if (e.none !== undefined) s.none = { role: e.none };
  return s;
}
