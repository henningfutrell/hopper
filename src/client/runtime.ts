// The remote runtime's far end (issue #708, design.md "Sandbox boxes the hopper launches"): `POST /runtime` carries
// the hopper's container runtime calls to this machine's own rootless Podman — or Docker, when only Docker is here —
// over its socket, so the hopper starts sandbox boxes on this machine through the one sandbox module.
//   {which: true}                        → {kind} of the runtime here, or {problem}: what to do to give it one
//   {method, path, body?, timeoutMs?}    → {status, text}: the runtime's own answer
//   {method, path, tar, timeoutMs?}      → the same, for a build: its context, a tar in base64 (issue #716)
// The hopper builds every call (src/sandbox/podman.ts, docker.ts); this end runs only the calls those adapters make,
// and checks them: a container it creates carries the sandbox flags and mounts nothing of this machine; it starts,
// stops, inspects, start-checks and removes only containers the hopper labelled as its boxes, and volumes named as their homes;
// it builds only a tools image, with the adapters' own build options, from a context of one Containerfile.
// A refused call answers 403 in the runtime's own shape, `{message}`. The checks restate src/sandbox/flags.ts's
// builder on purpose: this end imports nothing of hopper, and it holds the line even if the hopper's end is wrong.
// Imports nothing of hopper but its own directory: it is installed on the target as plain files.
import { existsSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';

export type RuntimeKind = 'podman' | 'docker';
export interface RuntimeSockets { podman?: string; docker?: string }

/** Where rootless Podman and rootless Docker put their sockets: under the user's runtime dir. */
export function defaultRuntimeSockets(env: NodeJS.ProcessEnv = process.env, uid = process.getuid?.() ?? 0): RuntimeSockets {
  const dir = env.XDG_RUNTIME_DIR || `/run/user/${uid}`;
  return { podman: join(dir, 'podman', 'podman.sock'), docker: join(dir, 'docker.sock') };
}

const PREFIX: Record<RuntimeKind, string> = { podman: '/v5.0.0/libpod', docker: '/v1.41' };
/** A build fetches every tool it adds (issue #716): the longest call the adapters make. */
const MAX_TIMEOUT_MS = 30 * 60_000;
const NAME = /^hopper-sandbox-[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const BOX_LABEL = 'io.hopper.box';
const HOME = '/home/agent';
/** The tag of a tools image (src/sandbox/tools.ts `TOOLS_IMAGE`): the one image a build may make here. */
const TOOLS_TAG = /^localhost\/hopper-box-tools:[0-9a-f]{16}$/;
/** A build's options as each adapter sends them; any other (a host network, a volume, a remote context) is refused. */
const BUILD_OPTIONS: Record<RuntimeKind, Record<string, string>> = { podman: { dockerfile: 'Containerfile', layers: 'true', rm: 'true' }, docker: { dockerfile: 'Containerfile', rm: '1' } };
const MAX_CONTAINERFILE = 64 * 1024;
const NO_RUNTIME = 'no Podman or Docker socket on this machine: run `systemctl --user enable --now podman.socket` there, and `loginctl enable-linger` so it outlives the sign-in session';

/** Podman when its socket is here, else Docker; undefined: neither. */
export function runtimeHere(sockets: RuntimeSockets): { kind: RuntimeKind; socket: string } | undefined {
  for (const kind of ['podman', 'docker'] as const) {
    const socket = sockets[kind];
    if (socket && existsSync(socket)) return { kind, socket };
  }
  return undefined;
}

interface Answer { status: number; text: string }

function call(socket: string, method: string, path: string, body: unknown, timeoutMs: number): Promise<Answer> {
  return new Promise((resolve, reject) => {
    // A Buffer is a build's context, sent as the tar it is; anything else as JSON.
    const payload = body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body);
    const type = Buffer.isBuffer(body) ? 'application/x-tar' : 'application/json';
    const req = request({
      socketPath: socket, method, path, timeout: timeoutMs,
      headers: { host: 'localhost', ...(payload === undefined ? {} : { 'content-type': type, 'content-length': Buffer.byteLength(payload) }) },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (d: string) => { text += d; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`no answer from the runtime within ${Math.round(timeoutMs / 1000)} s`)));
    req.on('error', reject);
    req.end(payload);
  });
}

const refused = (why: string): Answer => ({ status: 403, text: JSON.stringify({ message: `the hopper client refuses: ${why}` }) });
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const rootUser = (u: unknown): boolean => typeof u !== 'string' || ['', 'root', '0'].includes(u.split(':')[0]!.trim());
const onlyKeys = (o: Record<string, unknown>, allowed: string[], what: string): string | undefined => {
  const extra = Object.keys(o).filter((k) => !allowed.includes(k));
  return extra.length ? `${what} may not set ${extra.join(', ')}` : undefined;
};
const sameList = (v: unknown, want: string[]): boolean => Array.isArray(v) && v.length === want.length && v.every((x, i) => x === want[i]);

const PODMAN_KEYS = ['name', 'image', 'labels', 'env', 'user', 'cap_drop', 'no_new_privileges', 'read_only_filesystem', 'read_only_tmpfs', 'mounts', 'volumes', 'resource_limits', 'restart_policy', 'netns', 'networks', 'healthconfig'];
const DOCKER_KEYS = ['Image', 'Labels', 'User', 'Env', 'HostConfig', 'Healthcheck'];
/** The start check (issue #708): a command run in the box, as the box's user, under its flags; only these fields. */
const CHECK_KEYS = ['Test', 'Interval', 'Timeout', 'Retries'];
const checkProblem = (c: unknown): string | undefined => (c === undefined ? undefined : !isObject(c) || !Array.isArray(c.Test) ? "a sandbox box's start check is a Test command" : onlyKeys(c, CHECK_KEYS, "a sandbox box's start check"));
const DOCKER_HOST_KEYS = ['CapDrop', 'SecurityOpt', 'ReadonlyRootfs', 'Tmpfs', 'Mounts', 'NanoCpus', 'Memory', 'RestartPolicy', 'NetworkMode'];

/** Why a libpod create body is not a sandbox box's; undefined: it is. */
function podmanCreateProblem(b: Record<string, unknown>): string | undefined {
  const extra = onlyKeys(b, PODMAN_KEYS, 'a sandbox box') ?? checkProblem(b.healthconfig);
  if (extra) return extra;
  if (typeof b.name !== 'string' || !NAME.test(b.name)) return 'a sandbox box is named hopper-sandbox-<name>';
  if (!isObject(b.labels) || typeof b.labels[BOX_LABEL] !== 'string') return `a sandbox box carries the ${BOX_LABEL} label`;
  if (!sameList(b.cap_drop, ['ALL'])) return 'a sandbox box runs with every capability dropped';
  if (b.no_new_privileges !== true) return 'a sandbox box runs with no new privileges';
  if (b.read_only_filesystem !== true) return 'a sandbox box runs on a read-only root';
  if (!Array.isArray(b.mounts) || !b.mounts.every((m) => isObject(m) && m.type === 'tmpfs' && m.destination === '/tmp')) return 'a sandbox box mounts only a tmpfs at /tmp';
  if (!Array.isArray(b.volumes) || !b.volumes.every((v) => isObject(v) && typeof v.Name === 'string' && NAME.test(v.Name) && v.Dest === HOME)) return `a sandbox box mounts only its own home volume, at ${HOME}`;
  if (rootUser(b.user)) return 'a sandbox box runs as a non-root user';
  return undefined;
}

/** Why a Docker Engine create body is not a sandbox box's; undefined: it is. */
function dockerCreateProblem(b: Record<string, unknown>, name: string | null): string | undefined {
  const h = b.HostConfig;
  if (!isObject(h)) return 'a sandbox box has its HostConfig';
  const extra = onlyKeys(b, DOCKER_KEYS, 'a sandbox box') ?? onlyKeys(h, DOCKER_HOST_KEYS, "a sandbox box's HostConfig") ?? checkProblem(b.Healthcheck);
  if (extra) return extra;
  if (!name || !NAME.test(name)) return 'a sandbox box is named hopper-sandbox-<name>';
  if (!isObject(b.Labels) || typeof b.Labels[BOX_LABEL] !== 'string') return `a sandbox box carries the ${BOX_LABEL} label`;
  if (!sameList(h.CapDrop, ['ALL'])) return 'a sandbox box runs with every capability dropped';
  if (!sameList(h.SecurityOpt, ['no-new-privileges'])) return 'a sandbox box runs with no new privileges';
  if (h.ReadonlyRootfs !== true) return 'a sandbox box runs on a read-only root';
  if (!isObject(h.Tmpfs) || !Object.keys(h.Tmpfs).every((k) => k === '/tmp')) return 'a sandbox box mounts only a tmpfs at /tmp';
  if (!Array.isArray(h.Mounts) || !h.Mounts.every((m) => isObject(m) && m.Type === 'volume' && typeof m.Source === 'string' && NAME.test(m.Source) && m.Target === HOME)) return `a sandbox box mounts only its own home volume, at ${HOME}`;
  if (rootUser(b.User)) return 'a sandbox box runs as a non-root user';
  return undefined;
}

/**
 * Whether a build's context is a tar of one regular file, `Containerfile`, and nothing else: one header (no link, no
 * path prefix), the file, then only zeros. The tar the hopper sends (src/sandbox/socket-http.ts `containerfileTar`).
 */
function oneContainerfile(tar: Buffer): boolean {
  if (tar.length < 512 * 3 || tar.length % 512 !== 0) return false;
  const field = (at: number, len: number): string => tar.subarray(at, at + len).toString('latin1').replace(/[\0 ]+$/, '');
  const size = parseInt(field(124, 12), 8);
  if (field(0, 100) !== 'Containerfile' || tar[156] !== 0x30 || !(size >= 0 && size <= MAX_CONTAINERFILE)) return false;
  const zero = (from: number, to: number): boolean => tar.subarray(from, to).every((b) => b === 0);
  return zero(157, 257) && zero(345, 512) && 512 + size <= tar.length && zero(512 + size, tar.length);
}

/** Why a build is not a tools image's, as the adapters make it; undefined: it is. */
function buildProblem(kind: RuntimeKind, q: URLSearchParams, c: RuntimeCall): string | undefined {
  if (c.tar === undefined || c.body !== undefined) return 'a build carries its context as a tar of its Containerfile';
  if (q.getAll('t').length !== 1 || !TOOLS_TAG.test(q.get('t')!)) return 'a build makes only a tools image, localhost/hopper-box-tools:<hash>';
  const want = BUILD_OPTIONS[kind];
  const extra = [...new Set(q.keys())].filter((k) => k !== 't' && !(k in want));
  if (extra.length) return `a build may not set ${extra.join(', ')}`;
  for (const [k, v] of Object.entries(want)) if (q.getAll(k).length !== 1 || q.get(k) !== v) return `a build sets ${k}=${v}`;
  if (!oneContainerfile(Buffer.from(c.tar, 'base64'))) return "a build's context is one file, its Containerfile";
  return undefined;
}

type Check = { container: string } | { volume: string } | { create: true } | { build: true } | 'open';

/** What a call is, as the adapters make it: undefined, it is no call of theirs. */
function routeOf(kind: RuntimeKind, method: string, route: string): Check | undefined {
  const seg = route.split('/').slice(1).map((s) => { try { return decodeURIComponent(s); } catch { return '\0'; } });
  const [a, b, c] = seg;
  const n = seg.length;
  if (method === 'GET' && route === '/info') return 'open';
  if (method === 'GET' && route === '/containers/json') return 'open';
  if (method === 'POST' && route === '/containers/create') return { create: true };
  if (method === 'POST' && route === '/volumes/create') return 'open';
  if (method === 'POST' && route === '/build') return { build: true };
  if (a === 'images' && method === 'GET' && n >= 3 && (seg.at(-1) === 'json' || (kind === 'podman' && seg.at(-1) === 'exists'))) return 'open';
  if (method === 'POST' && route === (kind === 'podman' ? '/images/pull' : '/images/create')) return 'open';
  if (a === 'volumes' && n === 2 && (method === 'DELETE' || (kind === 'docker' && method === 'GET'))) return { volume: b! };
  if (a === 'containers' && n === 2 && method === 'DELETE') return { container: b! };
  if (a === 'containers' && n === 3 && ((method === 'GET' && (c === 'json' || (kind === 'podman' && c === 'healthcheck'))) || (method === 'POST' && (c === 'start' || c === 'stop')))) return { container: b! };
  return undefined;
}

export interface RuntimeCall { method: string; path: string; body?: unknown; tar?: string; timeoutMs?: number }

export function runtimeCallOf(v: unknown): RuntimeCall | { which: true } | string {
  if (!isObject(v)) return 'the call must be a JSON object';
  if (v.which === true) return { which: true };
  const { method, path, body, tar, timeoutMs } = v;
  if (typeof method !== 'string' || typeof path !== 'string') return 'the call names its method and path';
  if (tar !== undefined && typeof tar !== 'string') return 'tar must be base64 text';
  if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !(timeoutMs > 0))) return 'timeoutMs must be a positive number';
  return { method, path, ...(body !== undefined ? { body } : {}), ...(tar !== undefined ? { tar } : {}), ...(timeoutMs !== undefined ? { timeoutMs: Math.min(timeoutMs, MAX_TIMEOUT_MS) } : {}) };
}

/** One `POST /runtime`: what the client answers (always 200; the runtime's status is in it). */
export async function runtimeAnswer(sockets: RuntimeSockets, c: RuntimeCall | { which: true }): Promise<{ kind: RuntimeKind } | { problem: string } | Answer> {
  const here = runtimeHere(sockets);
  if ('which' in c) return here ? { kind: here.kind } : { problem: NO_RUNTIME };
  if (!here) return { status: 503, text: JSON.stringify({ message: NO_RUNTIME }) };
  const prefix = PREFIX[here.kind];
  const at = c.path.indexOf('?');
  const route = at < 0 ? c.path : c.path.slice(0, at);
  if (!route.startsWith(`${prefix}/`) || /\/\.\.?(\/|$)|\/\/|[\0\n\r]/.test(route)) return refused(`${c.method} ${route} is no call of the hopper's ${here.kind} runtime`);
  const check = routeOf(here.kind, c.method, route.slice(prefix.length));
  if (!check) return refused(`${c.method} ${route} is no call of the hopper's ${here.kind} runtime`);
  const timeout = c.timeoutMs ?? 30_000;
  const query = new URLSearchParams(at < 0 ? '' : c.path.slice(at + 1));
  if (check !== 'open' && 'build' in check) {
    const problem = buildProblem(here.kind, query, c);
    if (problem) return refused(problem);
    return call(here.socket, c.method, c.path, Buffer.from(c.tar!, 'base64'), timeout);
  }
  if (c.tar !== undefined) return refused('only a build carries a tar');
  if (check !== 'open' && 'create' in check) {
    const problem = !isObject(c.body) ? 'a create carries its body'
      : here.kind === 'podman' ? podmanCreateProblem(c.body) : dockerCreateProblem(c.body, query.get('name'));
    if (problem) return refused(problem);
  }
  if (check !== 'open' && 'volume' in check && !NAME.test(check.volume)) return refused(`${check.volume} is not a sandbox box's home volume`);
  if (check !== 'open' && 'container' in check) {
    const seen = await call(here.socket, 'GET', `${prefix}/containers/${encodeURIComponent(check.container)}/json`, undefined, timeout);
    if (seen.status === 404) return seen;
    if (seen.status < 200 || seen.status >= 300) return seen;
    let labels: unknown;
    try { labels = (JSON.parse(seen.text) as { Config?: { Labels?: unknown } }).Config?.Labels; } catch { /* no labels */ }
    if (!isObject(labels) || typeof labels[BOX_LABEL] !== 'string') return refused(`${check.container} is not a sandbox box the hopper made`);
  }
  return call(here.socket, c.method, c.path, c.body, timeout);
}

/** `POST /runtime`, its body as sent: the status and the payload the client answers with. */
export async function runtimeRoute(sockets: RuntimeSockets, body: string): Promise<{ status: number; payload: unknown }> {
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return { status: 400, payload: { error: 'body must be JSON' } }; }
  const c = runtimeCallOf(parsed);
  if (typeof c === 'string') return { status: 400, payload: { error: c } };
  try {
    return { status: 200, payload: await runtimeAnswer(sockets, c) };
  } catch (e) {
    return { status: 502, payload: { error: `the runtime on this machine did not answer: ${(e as Error).message}` } };
  }
}
