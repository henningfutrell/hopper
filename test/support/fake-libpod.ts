// A rootless Podman for tests (issue #708): the handlers of a libpod API double (fake-runtime-api.ts) that keep
// containers, volumes and images in memory, so a box can be launched, listed, stopped and removed through the real
// adapter — here, or on a machine through its client (src/client/runtime.ts) — without a real runtime.
import type { Handler, SeenRequest } from './fake-runtime-api.ts';

const API = '/v5.0.0/libpod';

export interface LibpodContainer {
  id: string; name: string; image: string; labels: Record<string, string>; state: string; body: Record<string, unknown>;
  /** Its start check's next run (issue #708), when its create carried one: passes unless a test says otherwise. */
  check?: { passed: boolean; output: string };
  /** A one-shot box's run (a check box, issue #708): its exit code, and its logs as libpod sends them. */
  run?: { exit: number; logs: Buffer };
}

export interface FakeLibpod {
  handlers: Handler[];
  containers: Map<string, LibpodContainer>;
  volumes: Set<string>;
  images: Set<string>;
  /** Each image built (issue #708, a tools image on a machine): its tag, and the Containerfile its context carried. */
  builds: Map<string, string>;
  /** Put a container there as someone else made it. */
  put(c: Omit<LibpodContainer, 'id' | 'body' | 'state'>): string;
}

export function createFakeLibpod(): FakeLibpod {
  let n = 0;
  const containers = new Map<string, LibpodContainer>();
  const volumes = new Set<string>();
  const images = new Set<string>();
  const builds = new Map<string, string>();
  /** Each volume's labels, as its create gave them: an inspect answers them (issue #1371). */
  const volumeLabels = new Map<string, Record<string, string>>();
  const byRef = (ref: string): LibpodContainer | undefined => containers.get(ref) ?? [...containers.values()].find((c) => c.name === ref);
  const path = (r: SeenRequest, re: RegExp): RegExpExecArray | null => (r.path.startsWith(API) ? re.exec(r.path.slice(API.length)) : null);
  const listed = (c: LibpodContainer) => ({ Id: c.id, Names: [c.name], Image: c.image, Labels: c.labels, State: c.state });
  const matches = (c: LibpodContainer, q: URLSearchParams): boolean => {
    const filters = q.get('filters');
    const labels = filters ? (JSON.parse(filters) as { label?: string[] }).label ?? [] : [];
    return labels.every((l) => { const [k, v] = l.split('='); return c.labels[k!] === v; });
  };
  const handler: Handler = (r) => {
    let m: RegExpExecArray | null;
    if (r.method === 'GET' && path(r, /^\/info$/)) return { status: 200, body: { host: { security: { rootless: true } } } };
    if (r.method === 'GET' && (m = path(r, /^\/images\/(.+)\/exists$/))) return { status: images.has(decodeURIComponent(m[1]!)) ? 204 : 404 };
    if (r.method === 'POST' && path(r, /^\/images\/pull$/)) { images.add(r.query.get('reference') ?? ''); return { status: 200, text: '{"id":"img"}\n' }; }
    if (r.method === 'GET' && (m = path(r, /^\/images\/(.+)\/json$/))) return images.has(decodeURIComponent(m[1]!)) ? { status: 200, body: { Config: { User: 'agent' } } } : { status: 404, body: { message: 'no such image' } };
    if (r.method === 'POST' && path(r, /^\/build$/)) {
      // The context is a tar of one Containerfile: a 512-byte header (its size in octal at 124), then the file.
      const tar = String(r.body);
      const tag = r.query.get('t') ?? '';
      builds.set(tag, tar.slice(512, 512 + parseInt(tar.slice(124, 135), 8)));
      images.add(tag);
      return { status: 200, text: `{"stream":"Successfully tagged ${tag}\\n"}\n` };
    }
    if (r.method === 'POST' && path(r, /^\/volumes\/create$/)) {
      const name = (r.body as { Name: string }).Name;
      if (volumes.has(name)) return { status: 409, body: { message: 'volume exists' } };
      volumes.add(name);
      volumeLabels.set(name, (r.body as { Label?: Record<string, string> }).Label ?? {});
      return { status: 201, body: { Name: name } };
    }
    if (r.method === 'GET' && path(r, /^\/volumes\/json$/)) {
      const filters = r.query.get('filters');
      const want = filters ? (JSON.parse(filters) as { label?: string[] }).label ?? [] : [];
      return { status: 200, body: [...volumes].filter((v) => want.every((l) => { const [k, x] = l.split('='); return volumeLabels.get(v)?.[k!] === x; })).map((v) => ({ Name: v, Labels: volumeLabels.get(v) ?? {} })) };
    }
    if (r.method === 'GET' && (m = path(r, /^\/volumes\/([^/]+)\/json$/))) {
      const name = decodeURIComponent(m[1]!);
      return volumes.has(name) ? { status: 200, body: { Name: name, Labels: volumeLabels.get(name) ?? {} } } : { status: 404, body: { message: 'no such volume' } };
    }
    if (r.method === 'DELETE' && (m = path(r, /^\/volumes\/([^/]+)$/))) return volumes.delete(decodeURIComponent(m[1]!)) ? { status: 204 } : { status: 404, body: { message: 'no such volume' } };
    if (r.method === 'POST' && path(r, /^\/containers\/create$/)) {
      const body = r.body as Record<string, unknown> & { name: string; image: string; labels: Record<string, string> };
      if (byRef(body.name)) return { status: 500, body: { message: `the container name "${body.name}" is already in use` } };
      const id = `c${++n}`;
      containers.set(id, { id, name: body.name, image: body.image, labels: body.labels, state: 'created', body, ...(body.healthconfig ? { check: { passed: true, output: '' } } : {}) });
      return { status: 201, body: { Id: id } };
    }
    if (r.method === 'GET' && path(r, /^\/containers\/json$/)) return { status: 200, body: [...containers.values()].filter((c) => matches(c, r.query)).map(listed) };
    if ((m = path(r, /^\/containers\/([^/]+)(\/json|\/start|\/stop|\/healthcheck|\/wait|\/logs)?$/))) {
      const c = byRef(decodeURIComponent(m[1]!));
      if (!c) return { status: 404, body: { message: 'no such container' } };
      const health = c.check && { Status: c.check.passed ? 'healthy' : 'unhealthy', Log: [{ ExitCode: c.check.passed ? 0 : 1, Output: c.check.output }] };
      if (r.method === 'GET' && m[2] === '/json') {
        return { status: 200, body: { Id: c.id, Name: c.name, ImageName: c.image, Config: { Labels: c.labels, ...(c.body.healthconfig ? { Healthcheck: c.body.healthconfig } : {}) }, State: { Status: c.state, ...(health ? { Health: health } : {}) } } };
      }
      if (r.method === 'GET' && m[2] === '/healthcheck') return health ? { status: 200, body: { Status: health.Status, FailingStreak: 0, Log: null } } : { status: 409, body: { message: `container ${c.id} has no defined healthcheck` } };
      if (r.method === 'POST' && m[2] === '/start') { c.state = 'running'; return { status: 204 }; }
      // A container stuck stopping refuses another stop; only a forced remove takes it.
      if (r.method === 'POST' && m[2] === '/stop' && c.state === 'stopping') return { status: 500, body: { message: `container ${c.id} is stopping` } };
      if (r.method === 'POST' && m[2] === '/stop') { c.state = 'exited'; return { status: 204 }; }
      if (r.method === 'POST' && m[2] === '/wait') { c.state = 'exited'; return { status: 200, text: String(c.run?.exit ?? 0) }; }
      if (r.method === 'GET' && m[2] === '/logs') return { status: 200, bytes: c.run?.logs ?? Buffer.alloc(0) };
      if (r.method === 'DELETE' && m[2] === undefined) { containers.delete(c.id); return { status: 204 }; }
    }
    return undefined;
  };
  return {
    handlers: [handler], containers, volumes, images, builds,
    put(c) {
      const id = `c${++n}`;
      containers.set(id, { ...c, id, state: 'running', body: {} });
      return id;
    },
  };
}
