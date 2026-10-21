// Which container runtime a sandbox box starts through (issue #708): decided here and nowhere else.
// - Beside the hopper (`local`): the runtime selected once at start. A runtime configured (HOPPER_SANDBOX_RUNTIME)
//   wins. Else Podman whenever it is reachable — the primary runtime —, then Docker when it is; neither reached, the
//   one given first, so a need step says why it cannot run. Kubernetes (issue #1286) only when it is configured:
//   pods in a namespace, through the Kubernetes API, with no socket.
// - On a client target: the remote runtime (remote.ts), that machine's own Podman (else Docker) through its client.
//   The box is on that machine's network.
// - With a sandbox host set (issue #2272, src/domain/sandbox-host.ts): only on the first of its machines that is online,
//   never on another one; none online is "sandbox host <name> is offline". It may name a Podman host (issue #2272,
//   podman-host.ts): the host's rootless Podman over ssh, which, as the runtime beside the hopper, takes a box's vault
//   secrets by a copy.
import { statSync } from 'node:fs';
import type { ContainerRuntime, RuntimeKind, RuntimeRelay } from '../domain/sandboxes.ts';
import type { Egress } from './egress.ts';
import { sandboxHostOffline } from '../domain/sandbox-host.ts';
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
  /** The runtime a box on `machine` runs in — a Podman host's first —; undefined: none now (no runtime here, or no such client target). */
  runtimeOf(userId: string, machine: string): ContainerRuntime | undefined;
  /**
   * Where a read-only check of the user's template runs (issue #708): beside the hopper when it is given a runtime, else
   * on the first of the user's client targets dialled in now with a runtime there. Undefined: nowhere now. `egress`: a
   * read-only box there joins its internal network and reaches out through its proxy (issue #849); only beside the hopper.
   */
  forCheck(userId: string): Promise<Placed | undefined>;
  /**
   * Where a sandbox of the user starts now, or why none can. With a sandbox host set (issue #2272): the first of its
   * machines whose runtime answers, never another; none, `offline` says so. Not set: as `forCheck`.
   */
  where(userId: string): Promise<Placed | { problem: string; offline?: true } | undefined>;
}

/**
 * Where a box starts: the machine, its runtime and network, and beside the hopper the egress of a read-only box.
 * `secrets`: it takes a step's vault secrets, by a copy — beside the hopper or on a Podman host, never on a machine of the
 * user's, which may be the job's own (issue #1875).
 */
export interface Placed { machine: string; runtime: ContainerRuntime; network: string; egress?: Egress; secrets?: true }

/** A user's Podman host named `name`: its runtime (issue #2272). Undefined: the user has none of that name. */
export type PodmanHosts = (userId: string, name: string) => ContainerRuntime | undefined;

/** `hosts`: the user's sandbox host, first first (issue #2272); empty or absent: none set. */
export function createPlacements(o: { local: ContainerRuntime | undefined; network: string; clients?: ClientTargets; egress?: Egress; hosts?: (userId: string) => readonly string[]; podmanHosts?: PodmanHosts }): Placements {
  // Made at each look: a machine that joined again under the same name has a new link key.
  const remote = (userId: string, machine: string): ContainerRuntime | undefined => {
    const target = o.clients?.(userId, machine);
    return target && createRemoteRuntime(machine, target.relay);
  };
  const beside = (runtime: ContainerRuntime): Placed => ({ machine: LOCAL, runtime, network: o.network, ...(o.egress ? { egress: o.egress } : {}), secrets: true });
  /** The first machine of the sandbox host whose runtime answers now; none: offline. */
  const onHost = async (userId: string, hosts: readonly string[]): Promise<Placed | { problem: string; offline: true }> => {
    for (const machine of hosts) {
      const podman = machine === LOCAL ? undefined : o.podmanHosts?.(userId, machine);
      const runtime = machine === LOCAL ? o.local : podman ?? (o.clients?.dialledIn(userId).includes(machine) ? remote(userId, machine) : undefined);
      if (!runtime || (await runtime.problem()) !== undefined) continue;
      return machine === LOCAL ? beside(runtime) : { machine, runtime, network: REMOTE_NETWORK, ...(podman ? { secrets: true as const } : {}) };
    }
    return { problem: sandboxHostOffline(hosts), offline: true };
  };
  const forCheck = async (userId: string): Promise<Placed | undefined> => {
    const hosts = o.hosts?.(userId) ?? [];
    if (hosts.length > 0) {
      const at = await onHost(userId, hosts);
      return 'problem' in at ? undefined : at;
    }
    if (o.local) return beside(o.local);
    for (const machine of o.clients?.dialledIn(userId) ?? []) {
      const runtime = remote(userId, machine);
      if (runtime && (await runtime.problem()) === undefined) return { machine, runtime, network: REMOTE_NETWORK };
    }
    return undefined;
  };
  return {
    local: o.local,
    runtimeOf: (userId, machine) => (machine === LOCAL ? o.local : o.podmanHosts?.(userId, machine) ?? remote(userId, machine)),
    forCheck,
    async where(userId) {
      const hosts = o.hosts?.(userId) ?? [];
      return hosts.length > 0 ? onHost(userId, hosts) : forCheck(userId);
    },
  };
}
