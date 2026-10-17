// GET /api/resources (issue #947, design.md "Stack resources"): what every container of the hopper's stack and each of
// its sandbox boxes uses now, labelled by its service, what its Postgres does, OpenFGA's checks and Solr's queries and index. An instance read: the hopper's admin
// (issue #240), or loopback without a session. Read when asked; nothing is kept. GET /api/resources/history: the stack's
// resource graph from the stack samples the stack recorder keeps (design.md "Stack resources over time"), the same query and
// step as the machines' resource graph; the same instance read. GET /api/process (issue #1383): the hopper's own process —
// its memory and its event loop's delay and use over the last minute; the same instance read. GET /api/telemetry (issue
// #1486, design.md "Telemetry summary"): the slowest actions, the job spans and the GitHub calls; the same instance read.
import type { FastifyInstance } from 'fastify';
import type { Clock } from '../domain/ports.ts';
import { STACK_HISTORY_RETENTION_DAYS, TELEMETRY_SUMMARY_SAMPLES, TELEMETRY_SUMMARY_TOP, type StackHistory, type StackHistoryRepository, type StackResources, type TelemetrySummary } from '../domain/types.ts';
import type { StackResourcesReader } from '../stack-resources/index.ts';
import type { ProcessReading } from './event-loop.ts';
import { assertInstanceRead, type InstanceAdmin } from './instance-admin.ts';
import type { Operation } from './openapi-operation.ts';
import { resourceGraphRange } from './machine-history.ts';
import { usageHistoryQuery } from './usage-history.ts';

export const STACK_RESOURCE_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/resources', tag: 'Machines and usage', summary: 'Stack resources: every container, Postgres, OpenFGA and Solr, now', description: 'Issue #947: one read of the hopper\'s own stack, labelled by service. `containers`: each container of the hopper\'s compose project (`group` `stack`, `service` its compose service) and each sandbox box this hopper started (`group` `sandbox`, `service` its container name), as the container runtime says through the socket sandbox boxes start through — `state`, `health`, `startedAt`, `restarts`, `cpuCores` (cores busy since the read before; none at a first read), `cpuLimitCores`, `memUsedBytes` (less the page cache it could drop), `memLimitBytes` (none: no limit), `netRxBytes`/`netTxBytes` and `diskReadBytes`/`diskWriteBytes` since it started, `layerBytes`, `volumes` with their size; or `problem` when the hopper has no runtime socket or the runtime does not answer. `remoteBoxes`: per client target that holds a sandbox box of this hopper (`machine`), its boxes there with the same readings (`group` `sandbox`, `machine`, `service` `<machine>/<container name>`; no `layerBytes` or volume sizes), read through the machine\'s client from its own runtime; or `problem` when it is no client target now, has no runtime, or does not answer. `postgres`: `connections` (`active`, `total`, `max`), `databaseBytes`, `cacheHitFrac` since the statistics were reset, `locksWaiting`, `longTransactions` (open over 5 minutes), `oldestTransactionS`, and `statements` (`calls`, `meanMs` from pg_stat_statements, or `problem`); or `problem`. `openfga`: OpenFGA\'s checks since it started, from its own metrics endpoint (the API\'s host, port 2112) — `checks`, `errors` (any gRPC code but OK), `meanMs` (none before a check); or `problem` when the hopper has no OpenFGA (HOPPER_OPENFGA_URL) or its metrics do not answer. `solr`: the search index\'s Solr, from its own metrics API beside HOPPER_SOLR_URL — `queries` and `errors` (requests to the core\'s `/select`, since the core was loaded), `meanMs` and `p95Ms` (Solr\'s timer, the last minutes weighed most; none before a query), `docs`, `indexBytes`, and `pending`: the documents waiting to be indexed (every user\'s pending index updates); or `problem` when its metrics do not answer, still with `pending`; with no Solr set up, only `problem`. An instance read: 403 for a session that is not the hopper\'s admin. Not cached.', returns: '`StackResources`', errors: [403] },
  { method: 'get', path: '/api/resources/history', tag: 'Machines and usage', summary: 'Stack resources over time: the stack\'s resource graph', description: 'Issue #947: the stack samples the hopper keeps every minute, per service (`service`, `group` `stack` or `sandbox`; a box on a client target is `<machine>/<container name>`) and metric, each a share 0..1: `cpu` (a running container\'s CPU cores busy, of its CPU quota, else of the cores it sees), `memory` (its memory in use, of its limit, else of the computer\'s), `connections` (Postgres\'s connections, of `max_connections`, service `postgres`) and `check-errors` (the share of OpenFGA\'s checks that failed since the record before, service `openfga`). Per graph step the peak, and the gaps where the service gave no sample. `range` (a preset) or `from` and `to`; default the last day; the graph step as GET /api/machines/history\'s. `retentionDays`: how long stack samples are kept (30). An instance read: 403 for a session that is not the hopper\'s admin.', query: usageHistoryQuery, returns: '`StackHistory`', errors: [400, 403] },
  { method: 'get', path: '/api/process', tag: 'Machines and usage', summary: 'The hopper\'s process: memory and event loop', description: 'Issue #1383: the hopper\'s own process now, so memory growth and a slow event loop show before a stall. `uptimeS`. `memory`, in MiB: `rssMb` (resident), `heapUsedMb`, `heapTotalMb`, `externalMb`, `arrayBuffersMb`. `eventLoop`, over the last minute (`windowS`; shorter in the first minute, and the minute going on when it held the loop longer): `delayMs` (`mean`, `p50`, `p99`, `max`: how late its timers ran) and `utilization` (0..1, the share of the time it ran code). A stall itself is on GET /api/health (`eventLoopStall`). An instance read: 403 for a session that is not the hopper\'s admin. Not cached.', returns: '`ProcessReading`', errors: [403] },
  { method: 'get', path: '/api/telemetry', tag: 'Machines and usage', summary: 'The telemetry summary: the slowest actions, job spans and GitHub calls', description: `Issue #1486: the most useful numbers of the hopper's telemetry, kept in its own process since it started (\`since\`), whether or not it exports them (\`exporting\`: the launch's OTEL_* variables name an exporter). Each list holds a name, its \`count\` since the start, and \`meanMs\`, \`p95Ms\` and \`maxMs\` over its last ${TELEMETRY_SUMMARY_SAMPLES} samples. \`actions\`: the requests that change something (not GET or HEAD), by method and route template, the slowest p95 first, at most ${TELEMETRY_SUMMARY_TOP}. \`jobSpans\`: each kind of job span that ended (\`queue\`, \`run\`, \`question\`, \`wait\`, \`park\`, \`sandbox\`, \`pull_request\`), timed by its events, and each job step (\`worktree\`, \`follow\`, \`base_merge\`, \`tend\`, issue #1486 part 7; \`need_box\`, part 9), timed as it ran, and each landing batch run (\`deploy\`, part 9), the slowest p95 first. \`github\`: the GitHub calls by method and route template, the most called first, at most ${TELEMETRY_SUMMARY_TOP}, each with \`cacheHits\` (a conditional request answered 304 from the cache) and \`errors\` (no answer, or 400 or more); \`githubCalls\` and \`githubCacheHits\` count every call. Names only: never a URL, an id or a value. In memory: a restart starts it again. An instance read: 403 for a session that is not the hopper's admin. Not cached.`, returns: '`TelemetrySummary`', errors: [403] },
];

export function stackHistory(history: StackHistoryRepository, query: unknown, now: Date): StackHistory {
  const { view, ...h } = resourceGraphRange(query, now);
  return {
    view, from: h.from.toISOString(), to: h.to.toISOString(), stepMs: h.stepMs, retentionDays: STACK_HISTORY_RETENTION_DAYS,
    series: history.series(h),
  };
}

export function stackResourceRoutes(app: FastifyInstance, o: { stackResources: StackResourcesReader; history: StackHistoryRepository; instanceAdmin: InstanceAdmin; clock: Clock; process: () => ProcessReading; telemetry: () => TelemetrySummary }): void {
  app.get('/api/process', async (req, reply): Promise<ProcessReading> => {
    assertInstanceRead(req, o.instanceAdmin, 'read the hopper\'s process');
    void reply.header('cache-control', 'no-store');
    return o.process();
  });
  app.get('/api/telemetry', async (req, reply): Promise<TelemetrySummary> => {
    assertInstanceRead(req, o.instanceAdmin, 'read the telemetry summary');
    void reply.header('cache-control', 'no-store');
    return o.telemetry();
  });
  app.get('/api/resources', async (req, reply): Promise<StackResources> => {
    assertInstanceRead(req, o.instanceAdmin, 'read the stack resources');
    void reply.header('cache-control', 'no-store');
    return o.stackResources.read();
  });
  app.get('/api/resources/history', async (req): Promise<StackHistory> => {
    assertInstanceRead(req, o.instanceAdmin, 'read the stack resources');
    return stackHistory(o.history, req.query, o.clock.now());
  });
}
