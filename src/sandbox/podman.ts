// The Podman container runtime (issues #603, #708): rootless Podman, through its own (libpod) REST API on its socket.
// The primary runtime, and the default whenever it is reachable (src/sandbox/runtime.ts). The create body is
// src/sandbox/flags.ts's: the sandbox flags are never a request's.
import type { BuildingRuntime, ContainerInfo } from '../domain/sandboxes.ts';
import { execCalls } from './exec.ts';
import { imageCalls } from './images.ts';
import { infoOf, startCheckOf, type Inspected } from './inspected.ts';
import { libpodCreateBody, STOP_S } from './flags.ts';
import { CALL_MS, containerfileTar, labelFilter, logText, ok, refusal as refused, socketCall, streamError, type Answer, type SocketCall } from './socket-http.ts';

export const API = '/v5.0.0/libpod';
const PULL_MS = 15 * 60_000;
/** A build fetches every tool it adds (issue #716). */
const BUILD_MS = 30 * 60_000;

interface Listed { Id?: string; Names?: string[]; Image?: string; Labels?: Record<string, string> | null; State?: string }

const enc = encodeURIComponent;

export function createPodmanRuntime(socket: string, via: SocketCall = socketCall): BuildingRuntime {
  const call = (method: string, path: string, body?: unknown, timeoutMs?: number): Promise<Answer> => via(socket, method, API + path, body, timeoutMs);
  const refusal = (what: string, a: Answer): Error => refused('podman', what, a);
  const read = async (id: string): Promise<Inspected | undefined> => {
    const a = await call('GET', `/containers/${enc(id)}/json`);
    if (a.status === 404) return undefined;
    if (!ok(a)) throw refusal(`inspect the box ${id}`, a);
    return JSON.parse(a.text) as Inspected;
  };

  return {
    kind: 'podman',
    // A command in a box and a copy into it (issue #1004): only over the socket here, never through a machine's relay.
    ...(via === socketCall ? execCalls(socket, API, 'podman') : {}),
    // The images on the machine (issue #1120): only over the socket here, never through a machine's relay.
    ...(via === socketCall ? imageCalls('podman', (method, path) => call(method, path)) : {}),

    async problem() {
      let a: Answer;
      try {
        a = await call('GET', '/info');
      } catch (e) {
        return `cannot reach podman at ${socket}: ${e instanceof Error ? e.message : String(e)}`;
      }
      if (!ok(a)) return `podman at ${socket} answered ${a.status}: is it the Podman API socket?`;
      const info = JSON.parse(a.text) as { host?: { security?: { rootless?: boolean } } };
      // Rootful Podman is root on the computer: the hopper never launches through it.
      if (info.host?.security?.rootless !== true) return `podman at ${socket} is not rootless: the hopper launches sandbox boxes only through a rootless runtime`;
      return undefined;
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
      const a = await call('DELETE', `/volumes/${enc(name)}?force=true`);
      if (!ok(a) && a.status !== 404) throw refusal(`remove the volume ${name}`, a);
    },

    async create(spec) {
      const a = await call('POST', '/containers/create', libpodCreateBody(spec));
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

    async startCheck(id) {
      const c = await read(id);
      const before = startCheckOf(c);
      if (!before || c?.State?.Status !== 'running') return before;
      // Run in the box now (no timer runs it: flags.ts sets no interval); the run's output is in the inspect answer.
      const ran = await call('GET', `/containers/${enc(id)}/healthcheck`);
      if (!ok(ran)) throw refusal(`run the start check of the box ${id}`, ran);
      return startCheckOf(await read(id));
    },

    async stop(id) {
      const a = await call('POST', `/containers/${enc(id)}/stop?timeout=${STOP_S}`, undefined, CALL_MS + STOP_S * 1000);
      if (!ok(a) && a.status !== 304 && a.status !== 404) throw refusal(`stop the box ${id}`, a);
    },

    async remove(id) {
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
