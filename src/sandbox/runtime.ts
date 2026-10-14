// Which container runtime a sandbox box starts through (issue #708): decided here and nowhere else.
// - Beside the hopper (`local`): the runtime selected once at start. A runtime configured (HOPPER_SANDBOX_RUNTIME)
//   wins. Else Podman whenever it is reachable — the primary runtime —, then Docker when it is; neither reached, the
//   one given first, so Add machine says why it cannot start one.
// - On a client target: the remote runtime (remote.ts), that machine's own Podman (else Docker) through its client.
//   The box is on that machine's network and dials the hopper where the machine's client did: an address the client
//   proved by dialling in on it (issue #695).
import { statSync } from 'node:fs';
import type { ContainerRuntime, RuntimeKind, RuntimeRelay } from '../domain/sandboxes.ts';
import { createDockerRuntime } from './docker.ts';
import { LaunchRefused } from './launch.ts';
import { createPodmanRuntime } from './podman.ts';
import { createRemoteRuntime } from './remote.ts';

export interface RuntimeChoice {
  podmanSocket?: string;
  dockerSocket?: string;
  /** HOPPER_SANDBOX_RUNTIME. */
  runtime?: Exclude<RuntimeKind, 'remote'>;
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
export const NO_RUNTIME = 'the hopper is given no container runtime socket (HOPPER_PODMAN_SOCKET, or HOPPER_DOCKER_SOCKET): it cannot start sandbox boxes itself. docs/deploy.md "Sandbox boxes the hopper starts"';

/** A user's client target named `machine`: its runtime relay, and the hopper's URL as it dialled in. Undefined: none. */
export interface ClientTargets {
  (userId: string, machine: string): { relay: RuntimeRelay; dialled(): string | undefined } | undefined;
  /** The names of the user's client targets dialled in now. */
  dialledIn(userId: string): string[];
}

/** Where a box runs, and how it is made there. */
export interface Placement { machine: string; runtime: ContainerRuntime; network: string; joinUrl: string }

export interface Placements {
  /** The runtime beside the hopper; undefined: none is given. */
  readonly local: ContainerRuntime | undefined;
  /**
   * Where a box of the user's launch runs: `machine` absent or `local`, beside the hopper; else that client target.
   * Throws LaunchRefused for a machine that is no client target (400) or cannot take a box now (409), else an Error.
   */
  place(userId: string, machine?: string): Promise<Placement>;
  /** The runtime a recorded box runs in, and where a box there dials the hopper; undefined: none now (no runtime here, or no such client target). */
  runtimeOf(userId: string, machine: string): { runtime: ContainerRuntime; joinUrl: string } | undefined;
  /**
   * Where a read-only check of the user's template runs (issue #708): beside the hopper when it is given a runtime, else
   * on the first of the user's client targets dialled in now with a runtime there. Undefined: nowhere now.
   */
  forCheck(userId: string): Promise<{ machine: string; runtime: ContainerRuntime; network: string } | undefined>;
}

/**
 * `joinUrl`: where a box beside the hopper dials it, as configured; `address`, when given, sets it at each launch from
 * what the runtime says of the hopper (address.ts).
 */
export function createPlacements(o: { local: ContainerRuntime | undefined; network: string; joinUrl: () => string; address?: (runtime: ContainerRuntime) => Promise<string>; clients?: ClientTargets }): Placements {
  // Made at each look: a machine that joined again under the same name has a new link key.
  const remote = (userId: string, machine: string): { runtime: ContainerRuntime; dialled(): string | undefined } | undefined => {
    const target = o.clients?.(userId, machine);
    return target && { runtime: createRemoteRuntime(machine, target.relay), dialled: target.dialled };
  };
  return {
    local: o.local,
    async place(userId, machine) {
      if (machine === undefined || machine === LOCAL) {
        if (!o.local) throw new Error(NO_RUNTIME);
        const problem = await o.local.problem();
        if (problem) throw new Error(problem);
        return { machine: LOCAL, runtime: o.local, network: o.network, joinUrl: o.address ? await o.address(o.local) : o.joinUrl() };
      }
      const target = remote(userId, machine);
      if (!target) throw new LaunchRefused(400, `no client target ${machine}: a sandbox box starts on the computer the hopper runs on, or on a machine that joined with Add machine`);
      const problem = await target.runtime.problem();
      if (problem) throw new LaunchRefused(409, problem);
      const joinUrl = target.dialled();
      if (!joinUrl) throw new LaunchRefused(409, `${machine} has not dialled in since the hopper started: its box would not know where the hopper is`);
      return { machine, runtime: target.runtime, network: REMOTE_NETWORK, joinUrl };
    },
    runtimeOf(userId, machine) {
      if (machine === LOCAL) return o.local && { runtime: o.local, joinUrl: o.joinUrl() };
      const target = remote(userId, machine);
      return target && { runtime: target.runtime, joinUrl: target.dialled() ?? '' };
    },
    async forCheck(userId) {
      if (o.local) return { machine: LOCAL, runtime: o.local, network: o.network };
      for (const machine of o.clients?.dialledIn(userId) ?? []) {
        const target = remote(userId, machine);
        if (target && (await target.runtime.problem()) === undefined) return { machine, runtime: target.runtime, network: REMOTE_NETWORK };
      }
      return undefined;
    },
  };
}
