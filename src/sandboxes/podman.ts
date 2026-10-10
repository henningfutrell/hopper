// The sandbox engine (issue #603): rootless Podman, through its API socket — Podman's own (libpod) REST API, over
// node:http. Written here, not taken from a library: the Docker clients (dockerode) speak the Docker API, which has
// no rootless answer and treats volumes differently, and the hopper needs six calls of the libpod API.
//
// The hopper builds every request body itself: the image is a template's or the published box image, the name is
// the box's, and the sandbox flags are fixed here. Nothing a request to the hopper carries reaches a body but a
// template's name, so an admin's UI session cannot mount the computer or grant a privilege through it.
import { request } from 'node:http';
import type { BoxContainer, BoxSpec, SandboxEngine } from '../domain/ports.ts';

const API = '/v5.0.0/libpod';
/** How long one call may take; a pull may take longer, so it has its own. */
const CALL_MS = 30_000;
const PULL_MS = 15 * 60_000;
/** How long a box may take to stop before it is killed. */
const STOP_S = 10;

interface Answer { status: number; text: string }

function call(socket: string, method: string, path: string, body?: unknown, timeoutMs = CALL_MS): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request({
      socketPath: socket, method, path: API + path, timeout: timeoutMs,
      headers: { host: 'podman', ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }) },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (d: string) => { text += d; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`podman did not answer ${method} ${path} within ${Math.round(timeoutMs / 1000)} s`)));
    req.on('error', reject);
    req.end(payload);
  });
}

/** Podman's own words for a refusal: its `message`, else the body. */
function refusal(what: string, a: Answer): Error {
  let message = a.text.trim();
  try { message = (JSON.parse(a.text) as { message?: string }).message ?? message; } catch { /* the body as it is */ }
  return new Error(`podman refused to ${what} (${a.status}): ${message}`);
}

const ok = (a: Answer): boolean => a.status >= 200 && a.status < 300;

interface ListedContainer { Names?: string[]; Labels?: Record<string, string> | null; State?: string }

/** The sandbox engine at `socket`: a Podman API socket the hopper may use. */
export function createPodmanEngine(socket: string): SandboxEngine {
  const containers = async (labels?: Record<string, string>): Promise<ListedContainer[]> => {
    const filters = labels ? `&filters=${encodeURIComponent(JSON.stringify({ label: Object.entries(labels).map(([k, v]) => `${k}=${v}`) }))}` : '';
    const a = await call(socket, 'GET', `/containers/json?all=true${filters}`);
    if (!ok(a)) throw refusal('list containers', a);
    return JSON.parse(a.text) as ListedContainer[];
  };

  return {
    async problem() {
      let a: Answer;
      try {
        a = await call(socket, 'GET', '/info');
      } catch (e) {
        return `cannot reach podman at ${socket}: ${e instanceof Error ? e.message : String(e)}`;
      }
      if (!ok(a)) return `podman at ${socket} answered ${a.status}: is it the Podman API socket?`;
      const info = JSON.parse(a.text) as { host?: { security?: { rootless?: boolean } } };
      // Rootful Podman is root on the computer: the hopper never launches through it.
      if (info.host?.security?.rootless !== true) return `podman at ${socket} is not rootless: the hopper launches sandbox boxes only through rootless Podman`;
      return undefined;
    },

    async names() {
      return new Set((await containers()).flatMap((c) => c.Names ?? []));
    },

    async list(labels) {
      return (await containers(labels)).map((c): BoxContainer => ({ name: c.Names?.[0] ?? '', labels: c.Labels ?? {}, state: c.State ?? '' }));
    },

    async launch(spec: BoxSpec) {
      const image = encodeURIComponent(spec.image);
      const exists = await call(socket, 'GET', `/images/${image}/exists`);
      if (exists.status === 404) {
        const pulled = await call(socket, 'POST', `/images/pull?reference=${image}&quiet=true`, undefined, PULL_MS);
        // The pull answers 200 and then streams its progress: an error is a line of the stream.
        const failed = pulled.text.split('\n').map((l) => { try { return (JSON.parse(l) as { error?: string }).error; } catch { return undefined; } }).find((e) => e);
        if (!ok(pulled) || failed) throw new Error(`podman could not pull ${spec.image}: ${failed ?? pulled.text.trim()}`);
      } else if (!ok(exists)) throw refusal(`look up the image ${spec.image}`, exists);
      const volume = await call(socket, 'POST', '/volumes/create', { Name: spec.volume, Label: spec.labels });
      if (!ok(volume) && volume.status !== 409) throw refusal(`make the volume ${spec.volume}`, volume);
      const created = await call(socket, 'POST', '/containers/create', {
        name: spec.name, image: spec.image, labels: spec.labels, env: spec.env,
        // The box line's sandbox flags (design.md "Joining a machine"), never a request's.
        cap_drop: ['ALL'], no_new_privileges: true, read_only_filesystem: true, read_only_tmpfs: false,
        mounts: [{ destination: '/tmp', type: 'tmpfs', source: 'tmpfs', options: ['rw', 'nosuid', 'nodev'] }],
        volumes: [{ Name: spec.volume, Dest: '/home/agent' }],
        restart_policy: 'unless-stopped',
        ...(spec.network === 'host' ? { netns: { nsmode: 'host' } } : { netns: { nsmode: 'bridge' }, networks: { [spec.network]: {} } }),
      });
      if (!ok(created)) throw refusal(`create the box ${spec.name}`, created);
      const started = await call(socket, 'POST', `/containers/${encodeURIComponent(spec.name)}/start`);
      if (!ok(started) && started.status !== 304) throw refusal(`start the box ${spec.name}`, started);
    },

    async remove(name, volume) {
      const gone = await call(socket, 'DELETE', `/containers/${encodeURIComponent(name)}?force=true&v=true&timeout=${STOP_S}`, undefined, CALL_MS + STOP_S * 1000);
      if (!ok(gone) && gone.status !== 404) throw refusal(`remove the box ${name}`, gone);
      const dropped = await call(socket, 'DELETE', `/volumes/${encodeURIComponent(volume)}?force=true`);
      if (!ok(dropped) && dropped.status !== 404) throw refusal(`remove the volume ${volume}`, dropped);
    },
  };
}
