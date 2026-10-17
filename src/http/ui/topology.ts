// The infrastructure topology on Infra (issue #1781, design.md "The infrastructure topology"): the graph of the services in
// the user's AWS accounts and Kubernetes clusters, and what is linked to what, joined from each topology source's last good
// snapshot; a read-only check's report of its sources, with an API token (scope `topology:report`); and Discover now, the
// hopper's own discovery (part 3, src/infra-plans/topology-discovery.ts). Read-only: nothing here acts on a cloud or a cluster. Registered with the infra plans' routes (`infra-plans.ts`).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { LINKS_MAX, NODES_MAX, SOURCES_MAX, type SourceReport } from '../../domain/topology.ts';
import { isPlanRefusal } from '../../infra-plans/service.ts';
import type { Operation } from '../openapi-operation.ts';
import { HttpError, parseWith } from '../errors.ts';
import { signedInOf, type TenantParts } from '../tenants.ts';
import { personOf } from './sessions.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

/** A report of the largest sources: a check with more sends more than one. */
const REPORT_BODY_LIMIT = 64 * 1024 * 1024;

/** Each source is checked by the topology's own check (`sourceReportProblem`), which says which one is not whole and why. */
export const topologyReportBody = z.strictObject({ sources: z.array(z.record(z.string(), z.unknown())).max(SOURCES_MAX) });

/** Discover now takes nothing: what it reads is what the vault's minting credentials mint for. */
export const topologyDiscoverBody = z.strictObject({});

export const TOPOLOGY_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/topology', tag: 'Infra', summary: 'Infra: the infrastructure topology', description: 'Issue #1781: the graph of the services in the user\'s AWS accounts and Kubernetes clusters, joined from each topology source\'s last good snapshot. `nodes`: each one\'s `id` (an ARN, `aws-account:<id>`, `k8s:<cluster>/<namespace>[/<kind>/<name>]`), `kind`, `name`, `account`, `region`, `cluster`, `namespace`, `aliases`, `attrs`, the `sources` that named it, and `seen` false when only a link names it. `links`: `from`, `to`, `kind` (`in`, `routes-to`, `selects`, `runs-as`, `assumes`, `can-assume`, `uses`). `sources`: each source\'s `key`, who reported it, its last good snapshot\'s time and counts, and its last read (`ok`, `error`). Not cached.', returns: '{ nodes: GraphNode[]; links: TopologyLink[]; sources: SourceView[] }' },
  { method: 'post', path: '/ui/api/topology/report', tag: 'Infra', summary: 'Report topology sources from a read-only check', description: `Issue #1781: what a read-only check found in one or more topology sources: \`sources\`, 1 to ${SOURCES_MAX}, each \`source\` (\`{ kind: "aws", account, region }\` or \`{ kind: "kubernetes", cluster }\`, the cluster node's id) with \`ok: true\`, \`nodes\` (at most ${NODES_MAX}) and \`links\` (at most ${LINKS_MAX}), or \`ok: false\` and the \`error\` that kept it from being read. A good source replaces its snapshot; a failed one keeps its last good snapshot and says why. \`infra.topology_reported\`, with the counts. Meant for an API token whose grant has the scope \`topology:report\`. Answers each source as kept. 400: a source that is not whole, or named twice, saying which and why.`, role: 'operator', body: topologyReportBody, returns: '{ sources: SourceView[] }', errors: [400] },
  { method: 'post', path: '/ui/api/topology/discover', tag: 'Infra', summary: 'Discover the infrastructure topology now', description: 'Issue #1781 part 3: the hopper reads the topology itself, as its schedule does every 6 hours. Each AWS account an `aws-account` minting credential mints for is read with a read session of its read role `hopper-read`; each cluster EKS lists there, and each cluster a `cluster` minting credential mints for, with a read token. Read calls only. What it found is reported as a read-only check reports it (reporter `topology discovery`); a source that cannot be read keeps its last good snapshot and says why. The run is a saga (`topology-discovery`), driven to its end before the answer. `state`: `done`, or `running` when a step waits for its next try or another hopper holds it; `graph`: the graph after it. Each mint is `vault.discovery_minted`. 503: no discovery in this hopper.', role: 'operator', body: topologyDiscoverBody, returns: '{ state: SagaState; error?: string; graph: TopologyGraph }', errors: [503] },
];

export function topologyReadRoutes(app: FastifyInstance, { tenant }: { tenant: (req: FastifyRequest) => TenantParts }): void {
  app.get('/api/topology', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    return tenant(req).githubProxy.topology.graph();
  });
}

export function registerTopologyRoutes(app: FastifyInstance, o: { operator: Guard; tenant: (req: FastifyRequest) => TenantParts }): void {
  app.post('/ui/api/topology/report', { ...o.operator, bodyLimit: REPORT_BODY_LIMIT }, async (req) => {
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to report topology sources');
    const b = parseWith(topologyReportBody, req.body);
    const r = o.tenant(req).githubProxy.topology.report(s.label ?? personOf(s), b.sources as unknown as SourceReport[]);
    if (isPlanRefusal(r)) throw new HttpError(r.status, r.no);
    return r;
  });
  // Discover now (part 3): the hopper's own discovery, run to its end; a stop meanwhile leaves the rest to its saga.
  app.post('/ui/api/topology/discover', o.operator, async (req) => {
    parseWith(topologyDiscoverBody, req.body ?? {});
    const r = await o.tenant(req).topologyDiscovery.discover();
    if (!r) throw new HttpError(503, 'topology discovery is not part of this hopper');
    return r;
  });
}
