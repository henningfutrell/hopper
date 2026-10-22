// The Podman container runtime (issues #603, #708): rootless Podman, through its own (libpod) REST API on its socket.
// The primary runtime, and the default whenever it is reachable (src/sandbox/runtime.ts); a Podman host's over ssh (issue
// #2272, podman-host.ts) is this adapter on an ssh stream in place of the socket. The create body is
// src/sandbox/flags.ts's: the sandbox flags are never a request's.
import type { BuildingRuntime, ContainerInfo } from '../domain/sandboxes.ts';
import { pipeCall } from './box-pipe.ts';
import { copyInCall } from './copy-in.ts';
import { imageCalls } from './images.ts';
import { infoOf, type Inspected } from './inspected.ts';
import { libpodCreateBody, STOP_S } from './flags.ts';
import { notASandbox, sandboxLabelled } from './owned.ts';
import { CALL_MS, containerfileTar, labelFilter, logText, ok, refusal as refused, socketCall, socketName, streamError, type Answer, type RuntimeSocket, type SocketCall } from './socket-http.ts';

export const API = '/v5.0.0/libpod';
const PULL_MS = 15 * 60_000;
/** A build fetches every tool it adds (issue #716). */
const BUILD_MS = 30 * 60_000;

interface Listed { Id?: string; Names?: string[]; Image?: string; Labels?: Record<string, string> | null; State?: string }

const enc = encodeURIComponent;

/** What the hopper reads of libpod /info: whether it is rootless, and the computer's CPUs and memory (issue #2272). */
export interface PodmanInfo {
  host?: {
    security?: { rootless?: boolean };
    cpus?: number;
    memTotal?: number;
    memFree?: number;
    cpuUtilization?: { userPercent?: number; systemPercent?: number; idlePercent?: number };
  };
}

/** libpod /info, or why boxes cannot be launched through this Podman: not reached, not its API, or rootful. */
export async function podmanInfo(socket: RuntimeSocket, via: SocketCall = socketCall, timeoutMs?: number): Promise<{ info: PodmanInfo } | { problem: string }> {
  const at = socketName(socket);
  let a: Answer;
  try {
    a = await via(socket, 'GET', `${API}/info`, undefined, timeoutMs);
  } catch (e) {
    return { problem: `cannot reach podman ${typeof socket === 'string' ? 'at' : 'on'} ${at}: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!ok(a)) return { problem: `podman at ${at} answered ${a.status}: is it the Podman API socket?` };
  const info = JSON.parse(a.text) as PodmanInfo;
  // Rootful Podman is root on the computer: the hopper never launches through it.
  if (info.host?.security?.rootless !== true) return { problem: `podman at ${at} is not rootless: the hopper launches sandbox boxes only through a rootless runtime` };
  return { info };
}

export function createPodmanRuntime(socket: RuntimeSocket, via: SocketCall = socketCall): BuildingRuntime {
  const call = (method: string, path: string, body?: unknown, timeoutMs?: number): Promise<Answer> => via(socket, method, API + path, body, timeoutMs);
  const refusal = (what: string, a: Answer): Error => refused('podman', what, a);
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
    const a = await call('GET', `/volumes/${enc(name)}/json`);
    if (a.status === 404) return false;
    if (!ok(a)) throw refusal(`inspect the volume ${name}`, a);
    if (!sandboxLabelled((JSON.parse(a.text) as { Labels?: Record<string, string> | null }).Labels)) throw notASandbox(`volume ${name}`);
    return true;
  };

  return {
    kind: 'podman',
    // A command in a box and a copy into it (issue #1004): only over the socket here, never through a machine's relay.
    ...(via === socketCall ? { ...copyInCall(socket, API, 'podman'), ...pipeCall(socket, API, 'podman') } : {}),
    // The images on the machine (issue #1120), over the socket here or through a machine's relay (issue #1202).
    ...imageCalls('podman', (method, path) => call(method, path)),

    async problem() {
      const r = await podmanInfo(socket, via);
      return 'problem' in r ? r.problem : undefined;
    },

    async pull(image) {
      const exists = await call('GET', `/images/${enc(image)}/exists`);
      if (exists.status === 404) {
        const pulled = await call('POST', `/images/pull?reference=${enc(image)}&quiet=true`, undefined, PULL_MS);
        const failed = streamError(pulled.text);
        if (!ok(pulled) || failed) throw new Error(`podman could not pull ${image}: ${failed ?? pulled.text.trim()}`);
      } else if (!ok(exists)) throw refusal(`look up the image ${image}`, exists);
      const read = await call('GET', `/images/${enc(image)}/json`);
      if (!ok(read)) throw refusal(`read the image ${image}`, read);
      const img = JSON.parse(read.text) as { Id?: string; Config?: { User?: string } };
      return { user: img.Config?.User ?? '', ...(img.Id ? { id: img.Id } : {}) };
    },

    async build(tag, containerfile) {
      const exists = await call('GET', `/images/${enc(tag)}/exists`);
      if (ok(exists)) return;
      if (exists.status !== 404) throw refusal(`look up the image ${tag}`, exists);
      const built = await call('POST', `/build?t=${enc(tag)}&dockerfile=Containerfile&layers=true&rm=true`, containerfileTar(containerfile), BUILD_MS);
      const failed = streamError(built.text);
      if (!ok(built) || failed) throw new Error(`podman could not build ${tag}: ${failed ?? built.text.trim()}`);
    },

    async createVolume(name, labels) {
      const a = await call('POST', '/volumes/create', { Name: name, Label: labels });
      if (a.status === 409) return false;
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
      const a = await call('GET', `/volumes/json?${labelFilter(labels).slice(1)}`);
      if (!ok(a)) throw refusal('list volumes', a);
      return ((JSON.parse(a.text) as { Name?: string }[] | null) ?? []).map((v) => v.Name ?? '').filter((n) => n !== '');
    },

    async create(spec) {
      const a = await call('POST', '/containers/create', libpodCreateBody(spec, { fileLog: guarded }));
      if (!ok(a)) throw refusal(`create the box ${spec.name}`, a);
      return String((JSON.parse(a.text) as { Id: string }).Id);
    },

    async start(id) {
      const a = await call('POST', `/containers/${enc(id)}/start`);
      if (!ok(a) && a.status !== 304) throw refusal(`start the box ${id}`, a);
    },

    async wait(id, timeoutMs) {
      const a = await call('POST', `/containers/${enc(id)}/wait?condition=exited&condition=stopped`, undefined, timeoutMs);
      if (!ok(a)) throw refusal(`wait for the box ${id}`, a);
      return Number(a.text.trim());
    },

    async logs(id) {
      const a = await call('GET', `/containers/${enc(id)}/logs?stdout=true&stderr=true`);
      if (!ok(a)) throw refusal(`read what the box ${id} wrote`, a);
      return logText(a.bytes ?? Buffer.from(a.text, 'utf8'));
    },

    async inspect(id) {
      const c = await read(id);
      return c && infoOf(c, id);
    },

    async stop(id) {
      if (!(await boxThere(id))) return;
      const a = await call('POST', `/containers/${enc(id)}/stop?timeout=${STOP_S}`, undefined, CALL_MS + STOP_S * 1000);
      if (!ok(a) && a.status !== 304 && a.status !== 404) throw refusal(`stop the box ${id}`, a);
    },

    async remove(id) {
      if (!(await boxThere(id))) return;
      const a = await call('DELETE', `/containers/${enc(id)}?force=true&timeout=${STOP_S}`, undefined, CALL_MS + STOP_S * 1000);
      if (!ok(a) && a.status !== 404) throw refusal(`remove the box ${id}`, a);
    },

    async list(labels) {
      const a = await call('GET', `/containers/json?all=true${labelFilter(labels)}`);
      if (!ok(a)) throw refusal('list containers', a);
      return (JSON.parse(a.text) as Listed[]).map((c): ContainerInfo => ({ id: c.Id ?? '', name: c.Names?.[0] ?? '', image: c.Image ?? '', labels: c.Labels ?? {}, state: c.State ?? '' }));
    },
  };
}
