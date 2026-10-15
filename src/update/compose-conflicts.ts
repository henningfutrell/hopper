// What compose.yaml and compose.override.yaml conflict on once compose merges them (issue #1246): the update checks this
// before it takes the stack down. podman-compose adds an override's volumes and ports to compose.yaml's, so a target
// mounted twice or a host port published twice makes `up -d` fail, after the old stack is down: an update that put the
// Podman socket in compose.yaml (issue #1157) left an install whose override mounted it too with no hopper. An override
// entry that only repeats what compose.yaml gives can be dropped (`dropRedundant`); the person accepts that first. A
// setting the override gives another value than compose.yaml's fixed one only warns: compose starts with it, the
// override's value wins.
import { isMap, isSeq, parse, parseDocument, type YAMLMap, type YAMLSeq } from 'yaml';

/** What `hopper update carry --with-override` reads on stdin between compose.yaml and compose.override.yaml. */
export const OVERRIDE_MARK = '#--- hopper update: compose.override.yaml';
export const COMPOSE = 'compose.yaml';
export const OVERRIDE = 'compose.override.yaml';

export interface ComposeConflict {
  kind: 'duplicate-mount' | 'duplicate-port' | 'conflicting-env';
  /** The file whose entry conflicts. */
  file: string;
  service: string;
  /** `volumes`, `ports` or `environment.<NAME>`. */
  key: string;
  /** The target mounted, the port published (`<port>/<protocol>`), or the setting's value in `file`. */
  value: string;
  detail: string;
  resolution: string;
  /** The stack would not start: the update stops. Else a warning. */
  refuse: boolean;
  /** compose.yaml gives the same: `dropRedundant` removes the override's entry. */
  fixable: boolean;
}

export interface ComposeCheck {
  conflicts: ComposeConflict[];
  /** A file that is not a compose file: nothing checked. */
  unread?: string;
}

interface File { name: string; text: string }
type Services = Record<string, Record<string, unknown>>;

/** `${NAME:-default}`, `${NAME-default}`: its default, as the update writes the install's values (issue #894). */
const resolve = (text: string): string => text.replace(/\$\{[A-Za-z0-9_]+:?-([^}]*)\}/g, '$1');

/** A short entry's parts, split on the colons outside `${…}` and `[…]`. */
function parts(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let part = '';
  for (const ch of text) {
    if (ch === '{' || ch === '[') depth++;
    if (ch === '}' || ch === ']') depth--;
    if (ch === ':' && depth === 0) { out.push(part); part = ''; } else part += ch;
  }
  return [...out, part];
}

/** A volume entry's target in the container. */
export function mountTarget(v: unknown): string | undefined {
  if (v && typeof v === 'object') { const t = (v as { target?: unknown }).target; return t === undefined ? undefined : resolve(String(t)); }
  if (typeof v !== 'string') return undefined;
  const p = parts(v);
  return resolve(p.length === 1 ? p[0]! : p[1]!);
}

interface Published { host: string; port: string }

/** A port entry's host address ('' for every one) and published port with its protocol; undefined when none is published. */
export function publishedPort(v: unknown): Published | undefined {
  if (v && typeof v === 'object') {
    const p = v as { host_ip?: unknown; published?: unknown; protocol?: unknown };
    if (p.published === undefined) return undefined;
    return { host: p.host_ip === undefined ? '' : resolve(String(p.host_ip)), port: `${resolve(String(p.published))}/${String(p.protocol ?? 'tcp')}` };
  }
  if (typeof v !== 'string' && typeof v !== 'number') return undefined;
  const [entry, protocol = 'tcp'] = String(v).split('/');
  const p = parts(entry!);
  if (p.length < 2) return undefined;
  return { host: p.length === 3 ? resolve(p[0]!) : '', port: `${resolve(p[p.length - 2]!)}/${protocol}` };
}

/** Two host addresses that cannot both publish one port: the same, or one is every address. */
const clash = (a: string, b: string): boolean =>
  a === b || a === '' || b === '' || (a === '0.0.0.0' && !b.startsWith('[')) || (b === '0.0.0.0' && !a.startsWith('['));

function servicesOf(file: File): Services | string {
  let doc: unknown;
  try { doc = parse(file.text); } catch (e) { return `${file.name} is not YAML (${(e as Error).message.split('\n')[0]})`; }
  if (doc === null || doc === undefined) return {};
  const s = (doc as { services?: unknown }).services;
  if (s === undefined || s === null) return {};
  return typeof s === 'object' && !Array.isArray(s) ? (s as Services) : `${file.name} has no services map`;
}

function environment(raw: unknown): Map<string, string> {
  const env = new Map<string, string>();
  if (Array.isArray(raw)) {
    for (const item of raw) { const [k, ...v] = String(item).split('='); if (k && v.length) env.set(k, v.join('=')); }
  } else if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) if (v !== null && v !== undefined) env.set(k, String(v));
  }
  return env;
}

const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/**
 * The conflicts of `files` (compose.yaml first, then each override, in the order compose reads them) once merged: a
 * target mounted twice and a host port published twice into the same service refuse; an override's other value for a
 * setting compose.yaml fixes (no variable) warns.
 */
export function composeConflicts(files: File[]): ComposeCheck {
  const read: Services[] = [];
  for (const f of files) {
    const s = servicesOf(f);
    if (typeof s === 'string') return { conflicts: [], unread: s };
    read.push(s);
  }
  const conflicts: ComposeConflict[] = [];
  const names = new Set(read.flatMap((s) => Object.keys(s)));
  for (const service of names) {
    const mounts = new Map<string, string>();
    const ports: (Published & { file: string })[] = [];
    const env = new Map<string, string>();
    read.forEach((services, i) => {
      const file = files[i]!.name;
      const s = services[service] ?? {};
      const base = i === 0;
      for (const v of list(s.volumes)) {
        const target = mountTarget(v);
        if (!target) continue;
        const first = mounts.get(target);
        if (first === undefined) { mounts.set(target, file); continue; }
        const fixable = first === COMPOSE && !base;
        conflicts.push({
          kind: 'duplicate-mount', file, service, key: 'volumes', value: target, refuse: true, fixable,
          detail: first === COMPOSE && !base ? `${COMPOSE} mounts ${target} itself now; mounted twice, the stack does not start`
            : `${first} mounts ${target} twice; the stack does not start`,
          resolution: fixable ? `remove the volume with target ${target} from ${file}: ${COMPOSE} gives it`
            : `keep one volume with target ${target} in ${file}`,
        });
      }
      for (const v of list(s.ports)) {
        const p = publishedPort(v);
        if (!p) continue;
        const first = ports.find((o) => o.port === p.port && clash(o.host, p.host));
        if (!first) { ports.push({ ...p, file }); continue; }
        const fixable = first.file === COMPOSE && !base;
        conflicts.push({
          kind: 'duplicate-port', file, service, key: 'ports', value: p.port, refuse: true, fixable,
          detail: `${first.file} publishes ${p.port} on ${first.host || 'every address'} already; published twice, the stack does not start`,
          resolution: fixable ? `remove the port ${p.port} from ${file}: ${COMPOSE} publishes it (its address: HOPPER_BIND)`
            : `publish ${p.port} once, or on another host port`,
        });
      }
      for (const [key, value] of environment(s.environment)) {
        const fixed = env.get(key);
        if (base) { if (!value.includes('$')) env.set(key, value); continue; }
        if (fixed === undefined || resolve(value) === fixed) continue;
        conflicts.push({
          kind: 'conflicting-env', file, service, key: `environment.${key}`, value, refuse: false, fixable: false,
          detail: `${COMPOSE} sets ${key} to ${fixed}; ${file} gives ${value}, which wins`,
          resolution: `remove ${key} from ${file} unless you need another value than ${COMPOSE}'s`,
        });
      }
    });
  }
  return { conflicts };
}

/** One line for a person: where, what, and what to do. */
export const conflictLine = (c: ComposeConflict): string =>
  `${c.refuse ? 'conflict' : 'warning'}: ${c.file}: services.${c.service}.${c.key}: ${c.value}: ${c.detail}. To fix: ${c.resolution}`;

/** `overrideText` without the entries of the fixable conflicts in it, its comments kept; a list or service left empty goes too. */
export function dropRedundant(overrideText: string, conflicts: ComposeConflict[]): string {
  const doc = parseDocument(overrideText);
  for (const c of conflicts) {
    if (!c.fixable || c.file !== OVERRIDE) continue;
    const seq = doc.getIn(['services', c.service, c.key]);
    if (!isSeq(seq)) continue;
    const items = (seq as YAMLSeq).items;
    const at = items.findIndex((item) => {
      const v = (item as { toJSON?: () => unknown }).toJSON?.() ?? item;
      return c.kind === 'duplicate-mount' ? mountTarget(v) === c.value : publishedPort(v)?.port === c.value;
    });
    if (at < 0) continue;
    items.splice(at, 1);
    if (items.length === 0) doc.deleteIn(['services', c.service, c.key]);
    const service = doc.getIn(['services', c.service]);
    if (isMap(service) && (service as YAMLMap).items.length === 0) doc.deleteIn(['services', c.service]);
  }
  return doc.toString({ flowCollectionPadding: false, nullStr: '' });
}
