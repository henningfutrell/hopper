// What an install changed in its compose.yaml, moved out of it (issue #697): the compose file the image ships with replaces it whole at
// each update, so the install's own settings live in .env — the published port's bind address (HOPPER_BIND) and port, and
// the hopper's settings it set in place or with another default than the new file's (`hopper update carry`). What .env cannot
// hold moves to compose.override.yaml, which compose reads beside it (`hopper update override`): a service of the install's
// own with the volumes it names, a host folder mounted into a service, a key of a service the hopper never sets, and the
// project name, when the install gave its own. The
// update script runs both.
import { isMap, parse, parseDocument, type Document } from 'yaml';

/** The `.env` lines to add, in order, and what a person must move by hand. */
export interface Carried {
  env: string[];
  notes: string[];
}

interface Service {
  ports?: unknown;
  environment?: unknown;
}

/** `${NAME}`, `${NAME:-default}` or `${NAME-default}`. */
const VARIABLE = /^\$\{([A-Za-z0-9_]+)(?::?-([^}]*))?\}$/;
const LOOPBACK = '127.0.0.1';
/** Where the compose file's own start files are: a variable naming one is the file's wiring, never a setting of the install. */
const OWN_FILES = '/run/hopper-secrets/';
const DEFAULT_PORT = '4790';

function services(text: string): Record<string, Service> | string {
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (e) {
    return (e as Error).message.split('\n')[0] ?? 'not YAML';
  }
  const s = (doc as { services?: unknown } | null)?.services;
  return s && typeof s === 'object' && !Array.isArray(s) ? (s as Record<string, Service>) : 'no services';
}

/** A service's environment as a map, from compose's map or list form. */
function environment(s: Service | undefined): Map<string, string> {
  const env = new Map<string, string>();
  const raw = s?.environment;
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const [k, ...v] = String(item).split('=');
      if (k && v.length) env.set(k, v.join('='));
    }
  } else if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) if (v !== null && v !== undefined) env.set(k, String(v));
  }
  return env;
}

/** A short port's parts, split on the colons outside `${…}`. */
function portParts(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let part = '';
  for (const ch of text) {
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    if (ch === ':' && depth === 0) { parts.push(part); part = ''; } else part += ch;
  }
  return [...parts, part];
}

/** The hopper's first published port: its host address (undefined: every interface) and published port. */
function publishedPort(s: Service): { host: string | undefined; published: string } | undefined {
  const first: unknown = Array.isArray(s.ports) ? s.ports[0] : undefined;
  if (first && typeof first === 'object') {
    const p = first as { host_ip?: unknown; published?: unknown };
    return p.published === undefined ? undefined : { host: p.host_ip === undefined ? undefined : String(p.host_ip), published: String(p.published) };
  }
  if (first === undefined) return undefined;
  const parts = portParts(String(first));
  if (parts.length === 3) return { host: parts[0], published: parts[1]! };
  return parts.length === 2 ? { host: undefined, published: parts[0]! } : undefined;
}

const literal = (v: string): boolean => !v.includes('$');

function carryPort(s: Service, add: (line: string) => void): void {
  const port = publishedPort(s);
  if (!port) return;
  if (port.host === undefined) add('HOPPER_BIND=0.0.0.0');
  else if (literal(port.host) && port.host !== LOOPBACK) add(`HOPPER_BIND=${port.host}`);
  if (literal(port.published) && port.published !== DEFAULT_PORT) add(`HOPPER_PORT=${port.published}`);
}

/** A setting the install gave in place, or under another default than the new compose file's: its value, else undefined. */
function localValue(key: string, old: string, next: string | undefined): string | undefined {
  const o = VARIABLE.exec(old);
  const r = next === undefined ? undefined : VARIABLE.exec(next);
  if (o) {
    if (o[1] !== key || !o[2]) return undefined;
    return next === undefined || (r && r[1] === key && r[2] !== o[2]) ? o[2] : undefined;
  }
  // A file the old compose file made and the new one does not (the old token key's, issue #659) is not carried.
  if (!literal(old) || old === next || old.startsWith(OWN_FILES)) return undefined;
  return next === undefined || r?.[1] === key ? old : undefined;
}

/** The `.env` lines that keep what `oldText` (an install's compose.yaml) changed, against `newText` (the compose file the update puts in). */
export function carryLocalSettings(oldText: string, newText: string): Carried {
  const old = services(oldText);
  if (typeof old === 'string') return { env: [], notes: [`the old compose.yaml was not read (${old}): nothing carried; move its local settings to .env or compose.override.yaml by hand`] };
  const hopper = old.hopper;
  if (!hopper) return { env: [], notes: ['the old compose.yaml has no hopper service: nothing carried'] };
  const next = services(newText);
  const nextServices = typeof next === 'string' ? {} : next;
  const env: string[] = [];
  const add = (line: string): void => { if (!env.some((l) => l.startsWith(`${line.split('=')[0]}=`))) env.push(line); };
  carryPort(hopper, add);
  const nextEnv = environment(nextServices.hopper);
  for (const [key, value] of environment(hopper)) {
    const v = localValue(key, value, nextEnv.get(key));
    if (v !== undefined) add(`${key}=${v}`);
  }
  return { env, notes: [] };
}

/** Every service a hopper compose.yaml has shipped: one the new file lacks is the hopper's, retired, never the install's. */
const SHIPPED_SERVICES = new Set(['postgres', 'hopper', 'secrets', 'openfga', 'openfga-migrate', 'hopper-vault', 'kms', 'vault']);
/** Every key a shipped service has set: the hopper's to change, so never carried. */
const SHIPPED_KEYS = new Set(['build', 'command', 'depends_on', 'entrypoint', 'env_file', 'environment', 'healthcheck', 'image', 'ports', 'profiles', 'restart', 'user', 'volumes', 'working_dir']);
/** A volume entry that mounts a host folder or file: the install's own, as a shipped file mounts only named volumes. */
const HOST_PATH = /^(\/|\.{1,2}\/|~)/;
const OVERRIDE = 'compose.override.yaml';
const HEADER = ' Moved here from compose.yaml by the hopper update (issue #697): compose.yaml is replaced whole at each update,\n and compose reads this file beside it. Yours to edit.';

/** What `hopper update override` answers: the whole new compose.override.yaml, or undefined when nothing moves; and what it did. */
export interface CarriedOverride {
  override: string | undefined;
  notes: string[];
}

const volumeSource = (v: unknown): string | undefined =>
  typeof v === 'string' ? v.split(':')[0] : v && typeof v === 'object' ? String((v as { source?: unknown }).source ?? '') : undefined;

/** The top-level volumes the moved services name, that the new file does not declare. */
function namedVolumes(services: Record<string, unknown>[], declared: Record<string, unknown>): string[] {
  const names = services.flatMap((s) => (Array.isArray(s.volumes) ? s.volumes as unknown[] : []).map(volumeSource));
  return [...new Set(names.filter((n): n is string => !!n && !HOST_PATH.test(n) && !(n in declared)))];
}

/**
 * The compose.override.yaml that keeps what `oldText` (an install's compose.yaml) has and `newText` (the compose file the
 * update puts in) cannot: `overrideText` (the install's own override, if any) with what moves added, its comments kept;
 * nothing it already has is replaced.
 */
export function carryOverride(oldText: string, newText: string, overrideText: string | undefined): CarriedOverride {
  const old = services(oldText);
  if (typeof old === 'string') return { override: undefined, notes: [`the old compose.yaml was not read (${old}): nothing moved to ${OVERRIDE}`] };
  const nextDoc = parse(newText) as { name?: unknown; services?: Record<string, Record<string, unknown>>; volumes?: Record<string, unknown> } | null;
  const next = nextDoc?.services ?? {};
  let doc: Document;
  try {
    doc = parseDocument(overrideText ?? '');
    if (doc.errors.length) throw doc.errors[0];
  } catch (e) {
    return { override: undefined, notes: [`${OVERRIDE} was not read (${(e as Error).message.split('\n')[0]}): nothing moved to it`] };
  }
  if (!isMap(doc.contents)) doc.contents = doc.createNode({}) as never;
  const notes: string[] = [];
  let moved = false;
  const has = (path: string[]): boolean => doc.hasIn(path);
  const put = (path: string[], value: unknown, note: string, kept: string): void => {
    if (has(path)) { notes.push(`${kept}: ${OVERRIDE} has it already, kept`); return; }
    doc.setIn(path, doc.createNode(value));
    notes.push(`${note} moved to ${OVERRIDE}`);
    moved = true;
  };
  // The project name: another one would start the stack on new, empty volumes.
  const oldName = (parse(oldText) as { name?: unknown } | null)?.name;
  if (typeof oldName === 'string' && literal(oldName) && oldName !== nextDoc?.name) put(['name'], oldName, 'name', 'name');
  const movedServices: Record<string, unknown>[] = [];
  for (const [name, raw] of Object.entries(old)) {
    const service = (raw ?? {}) as Record<string, unknown>;
    if (!(name in next)) {
      if (SHIPPED_SERVICES.has(name)) { notes.push(`service ${name}: the hopper no longer ships it, dropped`); continue; }
      put(['services', name], service, `service ${name}`, `service ${name}`);
      movedServices.push(service);
      continue;
    }
    const nextTargets = new Set((Array.isArray(next[name]?.volumes) ? next[name].volumes as unknown[] : []).map(String));
    const mounts = (Array.isArray(service.volumes) ? service.volumes : [])
      .filter((v) => typeof v === 'string' && HOST_PATH.test(v) && !nextTargets.has(v)) as string[];
    for (const mount of mounts) {
      const list = doc.getIn(['services', name, 'volumes']);
      if (Array.isArray((list as { items?: unknown[] } | undefined)?.items) && (list as { items: { value?: unknown }[] }).items.some((i) => i.value === mount)) {
        notes.push(`${name}: volume ${mount}: ${OVERRIDE} has it already, kept`);
        continue;
      }
      if (list === undefined) doc.setIn(['services', name, 'volumes'], doc.createNode([mount]));
      else doc.addIn(['services', name, 'volumes'], mount);
      notes.push(`${name}: volume ${mount} moved to ${OVERRIDE}`);
      moved = true;
    }
    for (const [key, value] of Object.entries(service)) {
      if (SHIPPED_KEYS.has(key) || key in (next[name] ?? {})) continue;
      put(['services', name, key], value, `${name}: ${key}`, `${name}: ${key}`);
    }
  }
  for (const volume of namedVolumes(movedServices, nextDoc?.volumes ?? {})) {
    put(['volumes', volume], null, `volume ${volume}`, `volume ${volume}`);
  }
  if (!moved) return { override: undefined, notes };
  if (overrideText === undefined || !overrideText.trim()) doc.commentBefore = HEADER;
  return { override: doc.toString({ flowCollectionPadding: false, nullStr: '' }), notes };
}
