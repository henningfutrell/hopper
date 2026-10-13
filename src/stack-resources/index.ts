// Stack resources (issue #947, design.md "Stack resources"): one read of what every container of the hopper's stack and
// each of its sandbox boxes uses (the container meter, containers.ts), of what its Postgres does (the store's database
// stats) and of OpenFGA's checks (the OpenFGA meter, openfga.ts). Read when asked, never kept: a part that cannot be read says why, and the rest is still read.
import type { Clock } from '../domain/ports.ts';
import type { RuntimeKind } from '../domain/sandboxes.ts';
import type { ContainerMeter, DatabaseStats, OpenFgaMeter, StackResources } from '../domain/stack-resources.ts';
import type { StackHistoryRepository } from '../domain/stack-resources.ts';
import { createContainerMeter } from './containers.ts';
import { createStackRecorder, type StackRecorder } from './history.ts';

export { createContainerMeter } from './containers.ts';
export { createOpenFgaMeter, openFgaMetricsUrl } from './openfga.ts';
export { createStackRecorder, samplesOf, type StackRecorder } from './history.ts';

export const NO_METER = 'the hopper is given no container runtime socket (HOPPER_PODMAN_SOCKET, or HOPPER_DOCKER_SOCKET): it cannot read its containers. docs/deploy.md "Sandbox boxes the hopper starts" gives it one';

export const NO_OPENFGA = 'the hopper is given no OpenFGA (HOPPER_OPENFGA_URL): it has no checks to read';

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

export function createStackResources(o: { meter: ContainerMeter | undefined; openfga: OpenFgaMeter | undefined; database: DatabaseStats; clock: Clock }): StackResourcesReader {
  return {
    async read() {
      const at = o.clock.now().toISOString();
      const containers = o.meter ? o.meter.read().catch((e: unknown) => ({ problem: why(e) })) : Promise.resolve({ problem: NO_METER });
      const openfga = o.openfga ? o.openfga.read().catch((e: unknown) => ({ problem: why(e) })) : Promise.resolve({ problem: NO_OPENFGA });
      let postgres: StackResources['postgres'];
      try {
        postgres = o.database.read();
      } catch (e) {
        postgres = { problem: why(e) };
      }
      return { at, containers: await containers, postgres, openfga: await openfga };
    },
  };
}

/** The stack resources and the stack recorder that keeps them over time (issue #947), as the daemon makes them. */
export function createStack(o: Parameters<typeof createStackResources>[0] & { history: StackHistoryRepository; logger: { warn(line: string): void } }): { resources: StackResourcesReader; recorder: StackRecorder } {
  const resources = createStackResources(o);
  return { resources, recorder: createStackRecorder({ read: () => resources.read(), history: o.history, clock: o.clock, logger: o.logger }) };
}
