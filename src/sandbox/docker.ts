// The Docker container runtime (issue #708): the Docker Engine API over its socket, never the docker CLI (the hopper's
// image has none). Rootless Docker only, as Podman: a rootful daemon is root on the computer. The create body is
// src/sandbox/flags.ts's.
import type { BuildingRuntime, ContainerInfo } from '../domain/sandboxes.ts';
import { pipeCall } from './box-pipe.ts';
import { copyInCall } from './copy-in.ts';
import { imageCalls } from './images.ts';
import { infoOf, type Inspected } from './inspected.ts';
import { dockerCreateBody, STOP_S } from './flags.ts';
import { notASandbox, sandboxLabelled } from './owned.ts';
import { CALL_MS, containerfileTar, labelFilter, logText, ok, refusal as refused, socketCall, streamError, type Answer, type SocketCall } from './socket-http.ts';

/** Docker Engine 20.10 and later answer this version. */
export const API = '/v1.41';
const PULL_MS = 15 * 60_000;
/** A build fetches every tool it adds (issue #716). */
const BUILD_MS = 30 * 60_000;

interface Listed { Id?: string; Names?: string[]; Image?: string; Labels?: Record<string, string> | null; State?: string }

const enc = encodeURIComponent;
/** Docker names a container `/name`. */
const bare = (name: string | undefined): string => (name ?? '').replace(/^\//, '');

export function createDockerRuntime(socket: string, via: SocketCall = socketCall): BuildingRuntime {
  const call = (method: string, path: string, body?: unknown, timeoutMs?: number): Promise<Answer> => via(socket, method, API + path, body, timeoutMs);
  const refusal = (what: string, a: Answer): Error => refused('docker', what, a);
  const readImage = (image: string): Promise<Answer> => call('GET', `/images/${enc(image)}/json`);
  const read = async (id: string): Promise<Inspected | undefined> => {
    const a = await call('GET', `/containers/${enc(id)}/json`);
    if (a.status === 404) return undefined;
    if (!ok(a)) throw refusal(`inspect the box ${id}`, a);
    return JSON.parse(a.text) as Inspected;
  };

  // Over the socket the hopper stops and removes only what carries a sandbox label (owned.ts, issue #1371); through a
  // machine's relay its client holds the same line at its end (src/client/runtime.ts).
  const guarded = via === socketCall;
  /** Whether the box is there; refused when it carries no sandbox label. */
  const boxThere = async (id: string): Promise<boolean> => {
    if (!guarded) return true;
    const c = await read(id);
    if (c && !sandboxLabelled(c.Config?.Labels)) throw notASandbox(`box ${id}`);
    return c !== undefined;
  };
  /** Whether the volume is there; refused when it carries no sandbox label. */
  const volumeThere = async (name: string): Promise<boolean> => {
    if (!guarded) return true;
    const a = await call('GET', `/volumes/${enc(name)}`);
    if (a.status === 404) return false;
    if (!ok(a)) throw refusal(`inspect the volume ${name}`, a);
    if (!sandboxLabelled((JSON.parse(a.text) as { Labels?: Record<string, string> | null }).Labels)) throw notASandbox(`volume ${name}`);
    return true;
  };

  return {
    kind: 'docker',
    // A command in a box and a copy into it (issue #1004): only over the socket here, never through a machine's relay.
    ...(via === socketCall ? { ...copyInCall(socket, API, 'docker'), ...pipeCall(socket, API, 'docker') } : {}),
    // The images on the machine (issue #1120), over the socket here or through a machine's relay (issue #1202).
    ...imageCalls('docker', (method, path) => call(method, path)),

    async problem() {
      let a: Answer;
      try {
        a = await call('GET', '/info');
      } catch (e) {
        return `cannot reach docker at ${socket}: ${e instanceof Error ? e.message : String(e)}`;
      }
      if (!ok(a)) return `docker at ${socket} answered ${a.status}: is it the Docker API socket?`;
      const info = JSON.parse(a.text) as { SecurityOptions?: string[] };
      if (!(info.SecurityOptions ?? []).includes('name=rootless')) return `docker at ${socket} is not rootless: the hopper launches sandbox boxes only through a rootless runtime`;
      return undefined;
    },

    async pull(image) {
      let read = await readImage(image);
      if (read.status === 404) {
        const pulled = await call('POST', `/images/create?fromImage=${enc(image)}`, undefined, PULL_MS);
        const failed = streamError(pulled.text);
        if (!ok(pulled) || failed) throw new Error(`docker could not pull ${image}: ${failed ?? pulled.text.trim()}`);
        read = await readImage(image);
      }
      if (!ok(read)) throw refusal(`read the image ${image}`, read);
      const img = JSON.parse(read.text) as { Id?: string; Config?: { User?: string } };
      return { user: img.Config?.User ?? '', ...(img.Id ? { id: img.Id } : {}) };
    },

    async build(tag, containerfile) {
      const read = await readImage(tag);
      if (ok(read)) return;
      if (read.status !== 404) throw refusal(`read the image ${tag}`, read);
      const built = await call('POST', `/build?t=${enc(tag)}&dockerfile=Containerfile&rm=1`, containerfileTar(containerfile), BUILD_MS);
      const failed = streamError(built.text);
      if (!ok(built) || failed) throw new Error(`docker could not build ${tag}: ${failed ?? built.text.trim()}`);
    },

    async createVolume(name, labels) {
      // Docker answers 201 for a volume that exists too, and keeps it as it is: ask first, to say whether it made one.
      if (ok(await call('GET', `/volumes/${enc(name)}`))) return false;
      const a = await call('POST', '/volumes/create', { Name: name, Labels: labels });
      if (!ok(a)) throw refusal(`make the volume ${name}`, a);
      return true;
    },

    async removeVolume(name) {
      if (!(await volumeThere(name))) return;
      const a = await call('DELETE', `/volumes/${enc(name)}?force=true`);
      if (!ok(a) && a.status !== 404) throw refusal(`remove the volume ${name}`, a);
    },

    // The volumes (issue #1371): over the socket, and through a machine's relay, whose client carries the list.
    async listVolumes(labels) {
      const a = await call('GET', `/volumes?${labelFilter(labels).slice(1)}`);
      if (!ok(a)) throw refusal('list volumes', a);
      return ((JSON.parse(a.text) as { Volumes?: { Name?: string }[] | null }).Volumes ?? []).map((v) => v.Name ?? '').filter((n) => n !== '');
    },

    async create(spec) {
      const a = await call('POST', `/containers/create?name=${enc(spec.name)}`, dockerCreateBody(spec, { fileLog: guarded }));
      if (!ok(a)) throw refusal(`create the box ${spec.name}`, a);
      return String((JSON.parse(a.text) as { Id: string }).Id);
    },

    async start(id) {
      const a = await call('POST', `/containers/${enc(id)}/start`);
      if (!ok(a) && a.status !== 304) throw refusal(`start the box ${id}`, a);
    },

    async wait(id, timeoutMs) {
      const a = await call('POST', `/containers/${enc(id)}/wait`, undefined, timeoutMs);
      if (!ok(a)) throw refusal(`wait for the box ${id}`, a);
      return Number((JSON.parse(a.text) as { StatusCode?: number }).StatusCode ?? -1);
    },

    async logs(id) {
      const a = await call('GET', `/containers/${enc(id)}/logs?stdout=1&stderr=1`);
      if (!ok(a)) throw refusal(`read what the box ${id} wrote`, a);
      return logText(a.bytes ?? Buffer.from(a.text, 'utf8'));
    },

    async inspect(id) {
      const c = await read(id);
      return c && infoOf(c, id);
    },

    // Docker runs it on its own interval (flags.ts): the last run.

    async stop(id) {
      if (!(await boxThere(id))) return;
      const a = await call('POST', `/containers/${enc(id)}/stop?t=${STOP_S}`, undefined, CALL_MS + STOP_S * 1000);
      if (!ok(a) && a.status !== 304 && a.status !== 404) throw refusal(`stop the box ${id}`, a);
    },

    async remove(id) {
      if (!(await boxThere(id))) return;
      const a = await call('DELETE', `/containers/${enc(id)}?force=true`, undefined, CALL_MS + STOP_S * 1000);
      if (!ok(a) && a.status !== 404) throw refusal(`remove the box ${id}`, a);
    },

    async list(labels) {
      const a = await call('GET', `/containers/json?all=true${labelFilter(labels)}`);
      if (!ok(a)) throw refusal('list containers', a);
      return (JSON.parse(a.text) as Listed[]).map((c): ContainerInfo => ({ id: c.Id ?? '', name: bare(c.Names?.[0]), image: c.Image ?? '', labels: c.Labels ?? {}, state: c.State ?? '' }));
    },
  };
}
