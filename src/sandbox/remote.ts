// The remote container runtime (issue #708): an attached machine's own rootless Podman — or Docker, when only Docker
// is there — driven through the machine's client. Its client says which runtime it has; then each call is the Podman
// or Docker adapter's own, sent down the machine's link (`POST /runtime`, src/client/runtime.ts) in place of a local
// socket, so a box on a machine is created with the same sandbox flags as one beside the hopper. The client checks
// each call again before it runs it. A machine not dialled in, or with no runtime, is a problem, never a box started.
// A build (a tools image, issue #716) is not carried: its body is a tar, and the client runs only JSON calls.
import type { ContainerRuntime, RuntimeRelay } from '../domain/sandboxes.ts';
import { createDockerRuntime } from './docker.ts';
import { createPodmanRuntime } from './podman.ts';
import type { SocketCall } from './socket-http.ts';

const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function createRemoteRuntime(machine: string, relay: RuntimeRelay): ContainerRuntime {
  const via: SocketCall = (_socket, method, path, body, timeoutMs) => relay.call({ method, path, ...(body !== undefined ? { body } : {}), ...(timeoutMs !== undefined ? { timeoutMs } : {}) });
  let inner: { kind: 'podman' | 'docker'; runtime: ContainerRuntime } | undefined;

  /** The machine's runtime, as its client names it now; throws with what is wrong. */
  const here = async (): Promise<ContainerRuntime> => {
    const which = await relay.which();
    if ('problem' in which) throw new Error(`${machine}: ${which.problem}`);
    if (inner?.kind !== which.kind) inner = { kind: which.kind, runtime: which.kind === 'podman' ? createPodmanRuntime(machine, via) : createDockerRuntime(machine, via) };
    return inner.runtime;
  };
  const known = (): Promise<ContainerRuntime> => (inner ? Promise.resolve(inner.runtime) : here());

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
    build: async () => { throw new Error(`${machine}: a box with tools starts only beside the hopper for now: the tools image is not built on a client target`); },
    createVolume: async (name, labels) => (await known()).createVolume(name, labels),
    removeVolume: async (name) => (await known()).removeVolume(name),
    create: async (spec) => (await known()).create(spec),
    start: async (id) => (await known()).start(id),
    wait: async () => { throw new Error(`${machine}: the read-only check runs only beside the hopper for now`); },
    logs: async () => { throw new Error(`${machine}: the read-only check runs only beside the hopper for now`); },
    inspect: async (id) => (await known()).inspect(id),
    startCheck: async (id) => (await known()).startCheck(id),
    stop: async (id) => (await known()).stop(id),
    remove: async (id) => (await known()).remove(id),
    list: async (labels) => (await known()).list(labels),
  };
}
