// GET /api/resources (issue #947, design.md "Stack resources"): what every container of the hopper's stack and each of
// its sandbox boxes uses now, labelled by its service, what its Postgres does, and OpenFGA's checks. An instance read: the hopper's admin
// (issue #240), or loopback without a session. Read when asked; nothing is kept.
import type { FastifyInstance } from 'fastify';
import type { StackResources } from '../domain/types.ts';
import type { StackResourcesReader } from '../stack-resources/index.ts';
import { assertInstanceRead, type InstanceAdmin } from './instance-admin.ts';
import type { Operation } from './openapi-operation.ts';

export const STACK_RESOURCE_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/resources', tag: 'Machines and usage', summary: 'Stack resources: every container, Postgres and OpenFGA, now', description: 'Issue #947: one read of the hopper\'s own stack, labelled by service. `containers`: each container of the hopper\'s compose project (`group` `stack`, `service` its compose service) and each sandbox box this hopper started (`group` `sandbox`, `service` its container name), as the container runtime says through the socket sandbox boxes start through — `state`, `health`, `startedAt`, `restarts`, `cpuCores` (cores busy since the read before; none at a first read), `cpuLimitCores`, `memUsedBytes` (less the page cache it could drop), `memLimitBytes` (none: no limit), `netRxBytes`/`netTxBytes` and `diskReadBytes`/`diskWriteBytes` since it started, `layerBytes`, `volumes` with their size; or `problem` when the hopper has no runtime socket or the runtime does not answer. `postgres`: `connections` (`active`, `total`, `max`), `databaseBytes`, `cacheHitFrac` since the statistics were reset, `locksWaiting`, `longTransactions` (open over 5 minutes), `oldestTransactionS`, and `statements` (`calls`, `meanMs` from pg_stat_statements, or `problem`); or `problem`. `openfga`: OpenFGA\'s checks since it started, from its own metrics endpoint (the API\'s host, port 2112) — `checks`, `errors` (any gRPC code but OK), `meanMs` (none before a check); or `problem` when the hopper has no OpenFGA (HOPPER_OPENFGA_URL) or its metrics do not answer. An instance read: 403 for a session that is not the hopper\'s admin. Not cached.', returns: '`StackResources`', errors: [403] },
];

export function stackResourceRoutes(app: FastifyInstance, o: { stackResources: StackResourcesReader; instanceAdmin: InstanceAdmin }): void {
  app.get('/api/resources', async (req, reply): Promise<StackResources> => {
    assertInstanceRead(req, o.instanceAdmin, 'read the stack resources');
    void reply.header('cache-control', 'no-store');
    return o.stackResources.read();
  });
}
