// Changing the sign-in config from Settings → Sign-in (design.md "Sign-in: realms", issues #185, #198):
// one change — a realm added or replaced from its fields, removed, moved, turned on or off; the login
// code and no sign-in set; an identity made admin, or super admin (issue #242). A new copy is answered;
// the one given is left as it was. Whether the result loads is the caller's check (loadSignInConfig),
// so one schema decides. A realm's secrets are written, never read back (issue #216): a save that
// leaves one out keeps the stored one, `null` removes it, and the view names which are set.
import { SECRET_SETTINGS } from './config.ts';
import type { StoredRealm, StoredSignIn } from '../domain/store.ts';
import { DEFAULT_SESSION_LENGTHS, type RealmType, type RealmView, type SessionLengths, type UiRole } from '../domain/types.ts';

export class AuthEditError extends Error {
  readonly status: 400 | 404;
  constructor(status: 400 | 404, message: string) { super(message); this.status = status; }
}

/** One change. */
export type SignInEdit =
  /** Add a realm, or replace the one named `name` (its name stays). A secret left out keeps the stored one; `null` removes it. */
  | { action: 'save'; name?: string; realm: { name: string; type: string } & Record<string, unknown> }
  | { action: 'remove'; name: string }
  /** Move to position `to` (0 first). */
  | { action: 'move'; name: string; to: number }
  | { action: 'enable'; name: string; enabled: boolean }
  /** The login code on or off; the role of no sign-in, or null for off; how long a UI session lasts (issue #439). */
  | { action: 'settings'; local?: boolean; none?: UiRole | null; sessions?: SessionLengths }
  /** Add the identity to its realm's admin rule, by subject (issue #242). */
  | { action: 'admin'; who: { realm: string; subject: string } }
  /** Add the identity to the super admins; with `transfer`, take `from` out of them (issue #242). Who may is the caller's check. */
  | { action: 'super-admin'; who: { realm: string; subject: string }; transfer?: boolean; from?: { realm: string; subject: string } };

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

/** The sign-in config with `edit` made. Throws AuthEditError. */
export function editSignIn(current: StoredSignIn, edit: SignInEdit): StoredSignIn {
  const s = structuredClone(current);
  const realms = s.realms;
  if (edit.action === 'settings') {
    if (edit.local !== undefined) s.local = { enabled: edit.local };
    if (edit.none === null) delete s.none;
    else if (edit.none !== undefined) s.none = { role: edit.none };
    if (edit.sessions !== undefined) s.sessions = { idleHours: edit.sessions.idleHours, maxHours: edit.sessions.maxHours };
  } else if (edit.action === 'save') {
    const { enabled: _enabled, ...fields } = edit.realm;
    if (edit.name === undefined) {
      if (realms.some((r) => r.name === fields.name)) throw new AuthEditError(400, `a realm ${fields.name} is already there`);
      realms.push(withSecrets(fields, undefined));
    } else {
      const i = indexOf(realms, edit.name);
      // Its sign-ins are linked to users by name, and the identity provider holds its callback URL.
      if (fields.name !== edit.name) throw new AuthEditError(400, `a realm's name stays ${edit.name}: remove it and add a new one to rename it`);
      const before = realms[i]!;
      realms[i] = {
        ...withSecrets(fields, before),
        ...(before.enabled === false ? { enabled: false } : {}),
      };
    }
  } else if (edit.action === 'admin') {
    const r = realms[indexOf(realms, edit.who.realm)]!;
    const roles = (r.roles ?? {}) as { admin?: { subjects?: string[] } };
    const subjects = roles.admin?.subjects ?? [];
    if (!subjects.includes(edit.who.subject)) r.roles = { ...roles, admin: { ...roles.admin, subjects: [...subjects, edit.who.subject] } };
  } else if (edit.action === 'super-admin') {
    indexOf(realms, edit.who.realm);
    const same = (a: { realm: string; subject: string }, b: { realm: string; subject: string }) => a.realm === b.realm && a.subject === b.subject;
    let supers = s.superAdmins ?? (s.githubAdmin ? [s.githubAdmin] : []);
    if (!supers.some((a) => same(a, edit.who))) supers = [...supers, { ...edit.who }];
    const from = edit.from;
    if (edit.transfer && from) {
      if (same(from, edit.who)) throw new AuthEditError(400, 'you are a super admin already: hand it over to someone else');
      supers = supers.filter((a) => !same(a, from));
    }
    s.superAdmins = supers;
  } else if (edit.action === 'remove') {
    realms.splice(indexOf(realms, edit.name), 1);
  } else if (edit.action === 'move') {
    const [r] = realms.splice(indexOf(realms, edit.name), 1);
    realms.splice(Math.min(edit.to, realms.length), 0, r!);
  } else {
    const r = realms[indexOf(realms, edit.name)]!;
    // On is the default: the field is there only while the realm is off.
    if (edit.enabled) delete r.enabled;
    else r.enabled = false;
  }
  return s;
}

type RealmRow = Omit<RealmView, 'callback' | 'metadata' | 'environment'>;

/** The realms in order, each with its settings — never a secret: the names of those that are set — the login code and no sign-in. */
export function realmsView(s: StoredSignIn): { local: boolean; none: UiRole | null; sessions: SessionLengths; realms: RealmRow[] } {
  return {
    local: s.local?.enabled !== false,
    none: s.none?.role ?? null,
    sessions: s.sessions ?? { ...DEFAULT_SESSION_LENGTHS },
    realms: s.realms.map(({ name, type, label, enabled, ...all }) => {
      const settings = Object.fromEntries(Object.entries(all).filter(([k]) => !secretsOf(type).includes(k)));
      return {
        name, label: label ?? name, type: type as RealmType, enabled: enabled !== false, settings,
        secrets: secretsOf(type).filter((k) => all[k] !== undefined),
      };
    }),
  };
}
