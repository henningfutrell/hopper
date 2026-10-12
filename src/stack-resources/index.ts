// Stack resources (issue #947, design.md "Stack resources"): one read of what every container of the hopper's stack and
// each of its sandbox boxes uses (the container meter, containers.ts) and of what its Postgres does (the store's
// database stats). Read when asked, never kept: a part that cannot be read says why, and the rest is still read.
import type { Clock } from '../domain/ports.ts';
import type { RuntimeKind } from '../domain/sandboxes.ts';
import type { ContainerMeter, DatabaseStats, StackResources } from '../domain/stack-resources.ts';
import { createContainerMeter } from './containers.ts';

export { createContainerMeter } from './containers.ts';

export const NO_METER = 'the hopper is given no container runtime socket (HOPPER_PODMAN_SOCKET, or HOPPER_DOCKER_SOCKET): it cannot read its containers. docs/deploy.md "Sandbox boxes the hopper starts" gives it one';

const why = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * The container meter on the socket sandbox boxes start through: the Docker one when HOPPER_SANDBOX_RUNTIME says docker,
 * else the Podman one, else the Docker one; undefined: none is given. `self`: the hopper's own container (its host name),
 * absent when it is not in one.
 */
export function meterFor(o: { config: { podmanSocket?: string; dockerSocket?: string; sandboxRuntime?: RuntimeKind }; instanceId: string; self: string | undefined }): ContainerMeter | undefined {
  const { podmanSocket, dockerSocket, sandboxRuntime } = o.config;
  const socket = sandboxRuntime === 'docker' ? dockerSocket : sandboxRuntime === 'podman' ? podmanSocket : podmanSocket ?? dockerSocket;
  return socket ? createContainerMeter({ socket, self: o.self ?? '', instanceId: o.instanceId }) : undefined;
}

export interface StackResourcesReader {
  read(): Promise<StackResources>;
}

export function createStackResources(o: { meter: ContainerMeter | undefined; database: DatabaseStats; clock: Clock }): StackResourcesReader {
  return {
    async read() {
      const at = o.clock.now().toISOString();
      const containers = o.meter ? o.meter.read().catch((e: unknown) => ({ problem: why(e) })) : Promise.resolve({ problem: NO_METER });
      let postgres: StackResources['postgres'];
      try {
        postgres = o.database.read();
      } catch (e) {
        postgres = { problem: why(e) };
      }
      return { at, containers: await containers, postgres };
    },
  };
}
