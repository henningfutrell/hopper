// What an install changed in its compose.yaml, moved out of it (issue #697): the compose file the image ships with replaces it whole at
// each update, so the install's own settings live in .env — the published port's bind address (HOPPER_BIND) and port, and
// the hopper's settings it set in place or with another default than the new file's. What cannot move to .env, a service of the install's own,
// is named for a person to move to compose.override.yaml. Read by `hopper update carry`, which the update script runs.
import { parse } from 'yaml';

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
  if (!literal(old) || old === next) return undefined;
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
  const notes = Object.keys(old).filter((name) => !(name in nextServices))
    .map((name) => `service ${name} is not in the new compose.yaml: move it to compose.override.yaml by hand (the old file is kept as the backup)`);
  return { env, notes };
}
