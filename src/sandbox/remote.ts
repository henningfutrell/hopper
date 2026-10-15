// The remote container runtime (issue #708): an attached machine's own rootless Podman — or Docker, when only Docker
// is there — driven through the machine's client. Its client says which runtime it has; then each call is the Podman
// or Docker adapter's own, sent down the machine's link (`POST /runtime`, src/client/runtime.ts) in place of a local
// socket, so a box on a machine is created with the same sandbox flags as one beside the hopper. The client checks
// each call again before it runs it. A machine not dialled in, or with no runtime, is a problem, never a box started.
// A build (a tools image, issue #716) carries its context, a tar, in base64; the box then runs the image built there.
// A check box (the read-only check, issue #716) runs there too: its end is awaited, and its output comes back in base64,
// as the bytes the runtime sent (libpod frames them).
import type { BuildingRuntime, RuntimeRelay } from '../domain/sandboxes.ts';
import { createDockerRuntime } from './docker.ts';
import { createPodmanRuntime } from './podman.ts';
import type { SocketCall } from './socket-http.ts';

const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** A socket call carried down a machine's link to its client, in place of a local socket: the adapters' calls, and the container meter's (issue #947). */
export const relayCall = (relay: RuntimeRelay): SocketCall => async (_socket, method, path, body, timeoutMs) => {
  const a = await relay.call({
    method, path,
    ...(Buffer.isBuffer(body) ? { tar: body.toString('base64') } : body !== undefined ? { body } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
  return { status: a.status, text: a.text, ...(a.base64 !== undefined ? { bytes: Buffer.from(a.base64, 'base64') } : {}) };
};

export function createRemoteRuntime(machine: string, relay: RuntimeRelay): BuildingRuntime {
  const via = relayCall(relay);
  let inner: { kind: 'podman' | 'docker'; runtime: BuildingRuntime } | undefined;

  /** The machine's runtime, as its client names it now; throws with what is wrong. */
  const here = async (): Promise<BuildingRuntime> => {
    const which = await relay.which();
    if ('problem' in which) throw new Error(`${machine}: ${which.problem}`);
    if (inner?.kind !== which.kind) inner = { kind: which.kind, runtime: which.kind === 'podman' ? createPodmanRuntime(machine, via) : createDockerRuntime(machine, via) };
    return inner.runtime;
  };
  const known = (): Promise<BuildingRuntime> => (inner ? Promise.resolve(inner.runtime) : here());

  return {
    kind: 'remote',
    async problem() {
      try {
        return await (await here()).problem();
      } catch (e) {
        return reason(e);
      }
    },
    pull: async (image) => (await known()).pull(image),
    build: async (tag, containerfile) => (await known()).build(tag, containerfile),
    createVolume: async (name, labels) => (await known()).createVolume(name, labels),
    removeVolume: async (name) => (await known()).removeVolume(name),
    listVolumes: async (labels) => (await known()).listVolumes(labels),
    create: async (spec) => (await known()).create(spec),
    start: async (id) => (await known()).start(id),
    wait: async (id, timeoutMs) => (await known()).wait(id, timeoutMs),
    logs: async (id) => (await known()).logs(id),
    inspect: async (id) => (await known()).inspect(id),
    startCheck: async (id) => (await known()).startCheck(id),
    stop: async (id) => (await known()).stop(id),
    remove: async (id) => (await known()).remove(id),
    list: async (labels) => (await known()).list(labels),
  };
}
