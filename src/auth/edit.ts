// Changing the sign-in config from Settings → Sign-in (design.md "Sign-in: realms", issues #185, #198,
// #200): one change — a realm added or replaced from its fields, removed, moved, turned on or off; the
// login code and no sign-in set; a password account added, changed or removed. A new copy is answered;
// the one given is left as it was. Whether the result loads is the caller's check (loadSignInConfig),
// so one schema decides.
import type { StoredAccount, StoredRealm, StoredSignIn } from '../domain/store.ts';
import type { PasswordAccountView, RealmType, RealmView, UiRole } from '../domain/types.ts';

export class AuthEditError extends Error {
  readonly status: 400 | 404;
  constructor(status: 400 | 404, message: string) { super(message); this.status = status; }
}

/** One change. A password arrives hashed: the HTTP edge hashes it (argon2) before it gets here. */
export type SignInEdit =
  /** Add a realm, or replace the one named `name` (its name stays). A password realm's accounts are kept, never set here. */
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
      realms.push(fields.type === 'password' ? { ...fields, users: [] } : fields);
    } else {
      const i = indexOf(realms, edit.name);
      // Its sign-ins are linked to users by name, and the identity provider holds its callback URL.
      if (fields.name !== edit.name) throw new AuthEditError(400, `a realm's name stays ${edit.name}: remove it and add a new one to rename it`);
      const before = realms[i]!;
      realms[i] = {
        ...fields,
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

type RealmRow = Omit<RealmView, 'callback' | 'metadata' | 'accounts'> & { accounts?: Omit<PasswordAccountView, 'user'>[] };

/** The realms in order, each with its settings (a password realm with its accounts, never a hash), the login code and no sign-in. */
export function realmsView(s: StoredSignIn): { local: boolean; none: UiRole | null; realms: RealmRow[] } {
  return {
    local: s.local?.enabled !== false,
    none: s.none?.role ?? null,
    realms: s.realms.map(({ name, type, label, enabled, users, ...settings }) => ({
      name, label: label ?? name, type: type as RealmType, enabled: enabled !== false, settings,
      ...(type === 'password' ? { accounts: (users ?? []).map((u) => ({ username: u.username, role: u.role })) } : {}),
    })),
  };
}
