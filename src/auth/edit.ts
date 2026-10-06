// Changing the sign-in config from Settings → Sign-in (design.md "Sign-in: realms", issues #185, #198,
// #200): one change — a realm added or replaced from its fields, removed, moved, turned on or off; the
// login code and no sign-in set; a password account added, changed or removed. A new copy is answered;
// the one given is left as it was. Whether the result loads is the caller's check (loadSignInConfig),
// so one schema decides. A realm's secrets are written, never read back (issue #216): a save that
// leaves one out keeps the stored one, `null` removes it, and the view names which are set.
import { SECRET_SETTINGS } from './config.ts';
import type { StoredAccount, StoredRealm, StoredSignIn } from '../domain/store.ts';
import type { PasswordAccountView, RealmType, RealmView, UiRole } from '../domain/types.ts';

export class AuthEditError extends Error {
  readonly status: 400 | 404;
  constructor(status: 400 | 404, message: string) { super(message); this.status = status; }
}

/** One change. A password arrives hashed: the HTTP edge hashes it (argon2) before it gets here. */
export type SignInEdit =
  /**
   * Add a realm, or replace the one named `name` (its name stays). A password realm's accounts are kept, never set here.
   * A secret left out keeps the stored one; `null` removes it.
   */
  | { action: 'save'; name?: string; realm: { name: string; type: string } & Record<string, unknown> }
  | { action: 'remove'; name: string }
  /** Move to position `to` (0 first). */
  | { action: 'move'; name: string; to: number }
  | { action: 'enable'; name: string; enabled: boolean }
  /** The login code on or off; the role of no sign-in, or null for off. */
  | { action: 'settings'; local?: boolean; none?: UiRole | null }
  /** Add an account (needs `passwordHash`), or change one's role and, when given, its password. */
  | { action: 'account'; realm: string; username: string; role: UiRole; passwordHash?: string }
  | { action: 'account-remove'; realm: string; username: string };

const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

const secretsOf = (type: string): readonly string[] => SECRET_SETTINGS[type as RealmType] ?? [];

/** The realm's fields with its secrets as the save says: given → set, null → gone, left out → kept from `before` (same type). */
function withSecrets(fields: StoredRealm, before: StoredRealm | undefined): StoredRealm {
  const out: StoredRealm = { ...fields };
  for (const key of secretsOf(fields.type)) {
    if (out[key] === null) delete out[key];
    else if (out[key] === undefined && before?.type === fields.type && before[key] !== undefined) out[key] = before[key];
  }
  // A bind password is the bind DN's: an anonymous search keeps none.
  if (fields.type === 'ldap' && out.bindDn === undefined) delete out.bindPassword;
  return out;
}

function indexOf(realms: StoredRealm[], name: string): number {
  const i = realms.findIndex((r) => r.name === name);
  if (i < 0) throw new AuthEditError(404, `no realm ${name}`);
  return i;
}

function passwordRealm(realms: StoredRealm[], name: string): StoredRealm & { users: StoredAccount[] } {
  const r = realms[indexOf(realms, name)]!;
  if (r.type !== 'password') throw new AuthEditError(400, `${name} is not a password realm: it has no accounts`);
  r.users ??= [];
  return r as StoredRealm & { users: StoredAccount[] };
}

/** The sign-in config with `edit` made. Throws AuthEditError. */
export function editSignIn(current: StoredSignIn, edit: SignInEdit): StoredSignIn {
  const s = structuredClone(current);
  const realms = s.realms;
  if (edit.action === 'settings') {
    if (edit.local !== undefined) s.local = { enabled: edit.local };
    if (edit.none === null) delete s.none;
    else if (edit.none !== undefined) s.none = { role: edit.none };
  } else if (edit.action === 'save') {
    const { users: _users, enabled: _enabled, ...fields } = edit.realm;
    if (edit.name === undefined) {
      if (realms.some((r) => r.name === fields.name)) throw new AuthEditError(400, `a realm ${fields.name} is already there`);
      const added = withSecrets(fields, undefined);
      realms.push(fields.type === 'password' ? { ...added, users: [] } : added);
    } else {
      const i = indexOf(realms, edit.name);
      // Its sign-ins are linked to users by name, and the identity provider holds its callback URL.
      if (fields.name !== edit.name) throw new AuthEditError(400, `a realm's name stays ${edit.name}: remove it and add a new one to rename it`);
      const before = realms[i]!;
      realms[i] = {
        ...withSecrets(fields, before),
        ...(before.enabled === false ? { enabled: false } : {}),
        ...(fields.type === 'password' ? { users: before.type === 'password' ? before.users ?? [] : [] } : {}),
      };
    }
  } else if (edit.action === 'remove') {
    realms.splice(indexOf(realms, edit.name), 1);
  } else if (edit.action === 'move') {
    const [r] = realms.splice(indexOf(realms, edit.name), 1);
    realms.splice(Math.min(edit.to, realms.length), 0, r!);
  } else if (edit.action === 'enable') {
    const r = realms[indexOf(realms, edit.name)]!;
    // On is the default: the field is there only while the realm is off.
    if (edit.enabled) delete r.enabled;
    else r.enabled = false;
  } else if (edit.action === 'account') {
    const { users } = passwordRealm(realms, edit.realm);
    const account = users.find((u) => sameName(u.username, edit.username));
    if (account) {
      account.role = edit.role;
      if (edit.passwordHash !== undefined) account.passwordHash = edit.passwordHash;
    } else {
      if (edit.passwordHash === undefined) throw new AuthEditError(400, `a new account needs a password: ${edit.username} has none`);
      users.push({ username: edit.username, passwordHash: edit.passwordHash, role: edit.role });
    }
  } else {
    const { users } = passwordRealm(realms, edit.realm);
    const i = users.findIndex((u) => sameName(u.username, edit.username));
    if (i < 0) throw new AuthEditError(404, `no account ${edit.username} in ${edit.realm}`);
    users.splice(i, 1);
  }
  return s;
}

/** The account of `realm` named `username` (whatever its case), or undefined. */
export function accountOf(s: StoredSignIn, realm: string, username: string): StoredAccount | undefined {
  return s.realms.find((r) => r.name === realm)?.users?.find((u) => sameName(u.username, username));
}

type RealmRow = Omit<RealmView, 'callback' | 'metadata' | 'accounts' | 'environment'> & { accounts?: Omit<PasswordAccountView, 'user'>[] };

/**
 * The realms in order, each with its settings — never a secret: the names of those that are set — (a
 * password realm with its accounts, never a hash), the login code and no sign-in.
 */
export function realmsView(s: StoredSignIn): { local: boolean; none: UiRole | null; realms: RealmRow[] } {
  return {
    local: s.local?.enabled !== false,
    none: s.none?.role ?? null,
    realms: s.realms.map(({ name, type, label, enabled, users, ...all }) => {
      const settings = Object.fromEntries(Object.entries(all).filter(([k]) => !secretsOf(type).includes(k)));
      return {
        name, label: label ?? name, type: type as RealmType, enabled: enabled !== false, settings,
        secrets: secretsOf(type).filter((k) => all[k] !== undefined),
        ...(type === 'password' ? { accounts: (users ?? []).map((u) => ({ username: u.username, role: u.role })) } : {}),
      };
    }),
  };
}
