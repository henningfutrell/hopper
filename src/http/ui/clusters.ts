// Settings → Clusters (issue #1766, design.md "Cluster discovery"): the cluster overrides — the config record `clusters`,
// replaced whole against the version read. Each one changes how the vault finds one cluster in the AWS accounts: its
// name in EKS, the account and the region to look in, and the role a write signs in as. Read at each mint, so a change
// applies without a restart. Least role to change: admin.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ClusterOverride, ClustersView } from '../../domain/clusters.ts';
import { clustersView, writeClusters } from '../../vault/clusters.ts';
import type { Operation } from '../openapi-operation.ts';
import { HttpError, parseWith } from '../errors.ts';
import type { TenantParts } from '../tenants.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

// Each override is checked by clustersProblem when it is written.
export const clustersBody = z.strictObject({
  clusters: z.array(z.strictObject({ name: z.string(), eksName: z.string().optional(), account: z.string().optional(), region: z.string().optional(), writeRole: z.string().optional() })),
  version: z.string().min(1),
});

export const CLUSTERS_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/clusters', tag: 'Vault', summary: 'The cluster overrides', description: 'Issue #1766: how the vault finds each cluster that has no minting credential of its own in the AWS accounts (cluster discovery). Each override names a `cluster/<name>` and, optional, its name in EKS (`eksName`), the one AWS account (`account`) and the region (`region`) to look in, and the IAM role a write signs in as (`writeRole`); and the record\'s `version`. No secret: a cluster holds none.', returns: '`ClustersView`' },
  { method: 'post', path: '/ui/api/clusters', tag: 'Vault', summary: 'Replace the cluster overrides', description: 'Issue #1766. The whole list, against the `version` read from GET /api/clusters. The next mint reads them. A cluster\'s own minting credential still wins over its override.', role: 'admin', body: clustersBody, returns: 'the new `ClustersView`', errors: [400, 409] },
];

const STATUS = { invalid: 400, conflict: 409 } as const;

export function registerClusterRoutes(app: FastifyInstance, o: { admin: Guard; tenant: (req: FastifyRequest) => TenantParts }): void {
  app.get('/api/clusters', async (req): Promise<ClustersView> => clustersView(o.tenant(req).store.config));
  app.post('/ui/api/clusters', o.admin, async (req) => {
    const { clusters, version } = parseWith(clustersBody, req.body);
    // writeClusters drops a field left out or empty.
    const r = writeClusters(o.tenant(req).store.config, clusters as ClusterOverride[], version);
    if (!r.ok) throw new HttpError(STATUS[r.code], r.error);
    return r.view;
  });
}
