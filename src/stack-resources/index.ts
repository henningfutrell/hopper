// Stack resources (issue #947, design.md "Stack resources"): one read of what every container of the hopper's stack and
// each of its sandbox boxes uses (the container meter, containers.ts; the boxes on client targets, remote.ts), of what its
// Postgres does (the store's database stats), of OpenFGA's checks (the OpenFGA meter, openfga.ts) and of the search index's
// Solr (the Solr meter, solr.ts, with the documents waiting to be indexed). Read when asked, never kept: a part that cannot
// be read says why, and the rest is still read.
import type { Clock } from '../domain/ports.ts';
import type { RuntimeKind } from '../domain/sandboxes.ts';
import type { ContainerMeter, DatabaseStats, OpenFgaMeter, RemoteBoxMeter, SolrMeter, SolrPart, StackResources } from '../domain/stack-resources.ts';
import type { StackHistoryRepository } from '../domain/stack-resources.ts';
import { createContainerMeter } from './containers.ts';
import { createStackRecorder, type StackRecorder } from './history.ts';

export { createContainerMeter } from './containers.ts';
export { createOpenFgaMeter, openFgaMetricsUrl } from './openfga.ts';
export { createRemoteBoxMeter } from './remote.ts';
export { createSolrMeter } from './solr.ts';
export { createStackRecorder, samplesOf, type StackRecorder } from './history.ts';

export const NO_METER = 'the hopper is given no container runtime socket (HOPPER_PODMAN_SOCKET, or HOPPER_DOCKER_SOCKET): it cannot read its containers. docs/deploy.md "Sandbox boxes the hopper starts" gives it one';

export const NO_OPENFGA = 'the hopper is given no OpenFGA (HOPPER_OPENFGA_URL): it has no checks to read';

export const NO_SOLR = 'the hopper is given no Solr (HOPPER_SOLR_URL): it has no search index to read';

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

/**
 * `remote`: the sandbox boxes on client targets; undefined: none are read. `solr`: the search index's Solr, and how many
 * documents wait to be indexed (every user's pending index updates); undefined: no search.
 */
export function createStackResources(o: { meter: ContainerMeter | undefined; remote?: RemoteBoxMeter; openfga: OpenFgaMeter | undefined; solr?: { meter: SolrMeter; pending: () => number } | undefined; database: DatabaseStats; clock: Clock }): StackResourcesReader {
  return {
    async read() {
      const at = o.clock.now().toISOString();
      const containers = o.meter ? o.meter.read().catch((e: unknown) => ({ problem: why(e) })) : Promise.resolve({ problem: NO_METER });
      const openfga = o.openfga ? o.openfga.read().catch((e: unknown) => ({ problem: why(e) })) : Promise.resolve({ problem: NO_OPENFGA });
      const solr: Promise<SolrPart> = o.solr
        ? o.solr.meter.read().then((r) => ({ ...r, pending: o.solr!.pending() }), (e: unknown) => ({ problem: why(e), pending: o.solr!.pending() }))
        : Promise.resolve({ problem: NO_SOLR });
      const remoteBoxes = o.remote ? o.remote.read().catch(() => []) : Promise.resolve([]);
      let postgres: StackResources['postgres'];
      try {
        postgres = o.database.read();
      } catch (e) {
        postgres = { problem: why(e) };
      }
      return { at, containers: await containers, remoteBoxes: await remoteBoxes, postgres, openfga: await openfga, solr: await solr };
    },
  };
}

/** The stack resources and the stack recorder that keeps them over time (issue #947), as the daemon makes them. */
export function createStack(o: Parameters<typeof createStackResources>[0] & { history: StackHistoryRepository; logger: { warn(line: string): void } }): { resources: StackResourcesReader; recorder: StackRecorder } {
  const resources = createStackResources(o);
  return { resources, recorder: createStackRecorder({ read: () => resources.read(), history: o.history, clock: o.clock, logger: o.logger }) };
}
