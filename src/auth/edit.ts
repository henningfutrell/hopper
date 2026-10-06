// Editing the sign-in config from Settings → Sign-in (design.md "Sign-in: realms", issues #185, #198): one
// change to the config record — a realm added or replaced from its JSON, removed, moved, turned on or
// off, or local sign-in and no sign-in set. Everything else in the config is kept. Whether the result
// loads is the caller's check (loadSignInConfig), so one schema decides.
import type { RealmType, RealmsEdit, RealmView, UiRole } from '../domain/types.ts';

export class AuthEditError extends Error {
  readonly status: 400 | 404;
  constructor(status: 400 | 404, message: string) { super(message); this.status = status; }
}

type Edit = RealmsEdit extends infer E ? E extends { version: string } ? Omit<E, 'version'> : never : never;
type Entry = Record<string, unknown>;

const isEntry = (x: unknown): x is Entry => typeof x === 'object' && x !== null && !Array.isArray(x);

function configOf(raw: unknown): Entry {
  if (raw === undefined || raw === null) return { version: 1 };
  if (!isEntry(raw)) throw new AuthEditError(400, 'the sign-in config is not an object');
  return structuredClone(raw);
}

function realmsOf(config: Entry): unknown[] {
  const realms = config.realms;
  if (Array.isArray(realms)) return realms;
  if (realms !== undefined && realms !== null) throw new AuthEditError(400, 'the sign-in config\'s realms is not a list');
  const fresh: unknown[] = [];
  config.realms = fresh;
  return fresh;
}

const nameOf = (item: unknown): string | undefined => (isEntry(item) && typeof item.name === 'string' ? item.name : undefined);

function indexOf(realms: unknown[], name: string): number {
  const i = realms.findIndex((x) => nameOf(x) === name);
  if (i < 0) throw new AuthEditError(404, `no realm ${name}`);
  return i;
}

/** One realm's JSON as a value. */
function entryOf(entry: string): Entry {
  let value: unknown;
  try { value = JSON.parse(entry); } catch (e) { throw new AuthEditError(400, `the realm is not valid JSON: ${(e as Error).message}`); }
  if (!isEntry(value)) throw new AuthEditError(400, 'a realm is an object: name, type and its settings');
  return value;
}

/** The sign-in config with `edit` made. Throws AuthEditError. */
export function editSignInConfig(raw: unknown, edit: Edit): Entry {
  const config = configOf(raw);
  if (edit.action === 'settings') {
    if (edit.local !== undefined) config.local = { enabled: edit.local };
    if (edit.none !== undefined) {
      if (edit.none === null) delete config.none;
      else config.none = { role: edit.none };
    }
    return config;
  }
  const realms = realmsOf(config);
  if (edit.action === 'save') {
    const entry = entryOf(edit.entry);
    const name = nameOf(entry);
    if (edit.name === undefined) {
      if (name !== undefined && realms.some((x) => nameOf(x) === name)) throw new AuthEditError(400, `a realm ${name} is already there`);
      realms.push(entry);
    } else {
      const i = indexOf(realms, edit.name);
      // Its sign-ins are linked to users by name, and the identity provider holds its callback URL.
      if (name !== edit.name) throw new AuthEditError(400, `a realm's name stays ${edit.name}: remove it and add a new one to rename it`);
      realms[i] = entry;
    }
  } else if (edit.action === 'remove') {
    realms.splice(indexOf(realms, edit.name), 1);
  } else if (edit.action === 'move') {
    const [item] = realms.splice(indexOf(realms, edit.name), 1);
    realms.splice(Math.min(edit.to, realms.length), 0, item);
  } else {
    const item = realms[indexOf(realms, edit.name)] as Entry;
    // On is the default: the field is there only while the realm is off.
    if (edit.enabled) delete item.enabled;
    else item.enabled = false;
  }
  return config;
}

const ROLES: readonly string[] = ['viewer', 'operator', 'admin'];

/** The sign-in config's realms in order, each as its own JSON, and local sign-in and no sign-in, read leniently. */
export function realmsView(raw: unknown): { local: boolean; none: UiRole | null; realms: Omit<RealmView, 'callback' | 'metadata'>[] } {
  const config = configOf(raw);
  const local = isEntry(config.local) ? config.local.enabled : undefined;
  const none = isEntry(config.none) ? config.none.role : undefined;
  const realms = (Array.isArray(config.realms) ? config.realms : []).filter(isEntry).map((json) => {
    const name = String(json.name ?? '');
    const label = typeof json.label === 'string' ? json.label : name;
    return { name, label, type: String(json.type) as RealmType, enabled: json.enabled !== false, entry: JSON.stringify(json, null, 2) };
  });
  return { local: local !== false, none: typeof none === 'string' && ROLES.includes(none) ? none as UiRole : null, realms };
}
