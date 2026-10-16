// Which container runtime a sandbox box starts through (issue #708): decided here and nowhere else.
// - Beside the hopper (`local`): the runtime selected once at start. A runtime configured (HOPPER_SANDBOX_RUNTIME)
//   wins. Else Podman whenever it is reachable — the primary runtime —, then Docker when it is; neither reached, the
//   one given first, so a need step says why it cannot run. Kubernetes (issue #1286) only when it is configured:
//   pods in a namespace, through the Kubernetes API, with no socket.
// - On a client target: the remote runtime (remote.ts), that machine's own Podman (else Docker) through its client.
//   The box is on that machine's network.
import { statSync } from 'node:fs';
import type { ContainerRuntime, RuntimeKind, RuntimeRelay } from '../domain/sandboxes.ts';
import { createDockerRuntime } from './docker.ts';
import { createKubernetesRuntime } from './kubernetes.ts';
import { createPodmanRuntime } from './podman.ts';
import { createRemoteRuntime } from './remote.ts';

export interface RuntimeChoice {
  podmanSocket?: string;
  dockerSocket?: string;
  /** HOPPER_SANDBOX_RUNTIME. */
  runtime?: Exclude<RuntimeKind, 'remote'>;
  /**
   * For `kubernetes`: the namespace of the boxes (unset: the hopper's own), the hopper's pods' labels, its port, the
   * boxes' PriorityClass, and the most CPU and memory a box gets.
   */
  kubernetes?: { namespace?: string; hopperLabels: Record<string, string>; port: number; priorityClass?: string; most?: { cpus?: number; memoryMb?: number } };
}

/**
 * `path`, unless something that is no socket is there: compose.yaml mounts /dev/null at the socket's path when the computer
 * has no Podman socket (issue #1157), and that is no socket given. Nothing there is still a socket given: its runtime says
 * it cannot reach it.
 */
export function givenSocket(path: string | undefined): string | undefined {
  if (!path) return undefined;
  try {
    return statSync(path).isSocket() ? path : undefined;
  } catch {
    return path;
  }
}

/** Undefined: no runtime socket is given, so the hopper starts no box. Throws when a configured runtime has no socket. */
export async function selectRuntime(o: RuntimeChoice): Promise<ContainerRuntime | undefined> {
  if (o.runtime === 'kubernetes') {
    if (!o.kubernetes) throw new Error('HOPPER_SANDBOX_RUNTIME=kubernetes needs the hopper\'s labels and port');
    // Loaded only here: a hopper on a socket never loads the Kubernetes client.
    const { createKubeApi } = await import('./kubernetes-api.ts');
    const { api, ownNamespace } = createKubeApi(o.kubernetes.namespace);
    return createKubernetesRuntime({ api, hopper: { namespace: ownNamespace, labels: o.kubernetes.hopperLabels, port: o.kubernetes.port }, ...(o.kubernetes.priorityClass !== undefined ? { priorityClass: o.kubernetes.priorityClass } : {}), ...(o.kubernetes.most ? { most: o.kubernetes.most } : {}) });
  }
  const podmanSocket = givenSocket(o.podmanSocket), dockerSocket = givenSocket(o.dockerSocket);
  const podman = podmanSocket ? createPodmanRuntime(podmanSocket) : undefined;
  const docker = dockerSocket ? createDockerRuntime(dockerSocket) : undefined;
  if (o.runtime) {
    const chosen = o.runtime === 'podman' ? podman : docker;
    if (!chosen) throw new Error(`HOPPER_SANDBOX_RUNTIME=${o.runtime} needs HOPPER_${o.runtime.toUpperCase()}_SOCKET`);
    return chosen;
  }
  for (const rt of [podman, docker]) if (rt && (await rt.problem()) === undefined) return rt;
  return podman ?? docker;
}

/** The machine a box beside the hopper is recorded on. */
export const LOCAL = 'local';
/** A box on a client target shares that machine's network: it reaches the hopper as the machine's client does. */
export const REMOTE_NETWORK = 'host';
/** A hopper in a Kubernetes pod (issue #1289): no socket is a fault to fix there; sandbox boxes do not run in the cluster yet (issue #1281). */
export const NO_RUNTIME_IN_CLUSTER = 'the hopper runs in a Kubernetes cluster: it starts no sandbox box beside itself there';
export const NO_RUNTIME = 'the hopper is given no container runtime socket (HOPPER_PODMAN_SOCKET, or HOPPER_DOCKER_SOCKET): it cannot start sandboxes itself. docs/deploy.md "Sandboxes the hopper starts"';

/** A user's client target named `machine`: its runtime relay. Undefined: none. */
export interface ClientTargets {
  (userId: string, machine: string): { relay: RuntimeRelay } | undefined;
  /** The names of the user's client targets dialled in now. */
  dialledIn(userId: string): string[];
  /** Every user's client targets dialled in now (issue #1349): where the sweeps look for boxes left there. */
  allDialledIn(): { userId: string; machine: string }[];
  /**
   * Whether the user has a client target named `machine` now, dialled in or not (issue #1349): a sandbox run on one that
   * is no longer there is closed, as no runtime is there to say its box went.
   */
  known(userId: string, machine: string): boolean;
}

export interface Placements {
  /** The runtime beside the hopper; undefined: none is given. */
  readonly local: ContainerRuntime | undefined;
  /** The runtime a box on `machine` runs in; undefined: none now (no runtime here, or no such client target). */
  runtimeOf(userId: string, machine: string): ContainerRuntime | undefined;
  /**
   * Where a read-only check of the user's template runs (issue #708): beside the hopper when it is given a runtime, else
   * on the first of the user's client targets dialled in now with a runtime there. Undefined: nowhere now.
   */
  forCheck(userId: string): Promise<{ machine: string; runtime: ContainerRuntime; network: string } | undefined>;
}

export function createPlacements(o: { local: ContainerRuntime | undefined; network: string; clients?: ClientTargets }): Placements {
  // Made at each look: a machine that joined again under the same name has a new link key.
  const remote = (userId: string, machine: string): ContainerRuntime | undefined => {
    const target = o.clients?.(userId, machine);
    return target && createRemoteRuntime(machine, target.relay);
  };
  return {
    local: o.local,
    runtimeOf: (userId, machine) => (machine === LOCAL ? o.local : remote(userId, machine)),
    async forCheck(userId) {
      if (o.local) return { machine: LOCAL, runtime: o.local, network: o.network };
      for (const machine of o.clients?.dialledIn(userId) ?? []) {
        const runtime = remote(userId, machine);
        if (runtime && (await runtime.problem()) === undefined) return { machine, runtime, network: REMOTE_NETWORK };
      }
      return undefined;
    },
  };
}
