// Which container runtime the hopper starts sandbox boxes through (issue #708): decided here and nowhere else, once at
// start. A runtime configured (HOPPER_SANDBOX_RUNTIME) wins. Else Podman whenever it is reachable — the primary
// runtime —, then Docker when it is; neither reached, the one given first, so Add machine says why it cannot start one.
import type { ContainerRuntime, RuntimeKind } from '../domain/sandboxes.ts';
import { createDockerRuntime } from './docker.ts';
import { createPodmanRuntime } from './podman.ts';

export interface RuntimeChoice {
  podmanSocket?: string;
  dockerSocket?: string;
  /** HOPPER_SANDBOX_RUNTIME. */
  runtime?: RuntimeKind;
}

/** Undefined: no runtime socket is given, so the hopper starts no box. Throws when a configured runtime has no socket. */
export async function selectRuntime(o: RuntimeChoice): Promise<ContainerRuntime | undefined> {
  const podman = o.podmanSocket ? createPodmanRuntime(o.podmanSocket) : undefined;
  const docker = o.dockerSocket ? createDockerRuntime(o.dockerSocket) : undefined;
  if (o.runtime) {
    const chosen = o.runtime === 'podman' ? podman : docker;
    if (!chosen) throw new Error(`HOPPER_SANDBOX_RUNTIME=${o.runtime} needs HOPPER_${o.runtime.toUpperCase()}_SOCKET`);
    return chosen;
  }
  for (const rt of [podman, docker]) if (rt && (await rt.problem()) === undefined) return rt;
  return podman ?? docker;
}
