// The kept delivery tracks and the deployment records (issue #2775, design.md "Kept delivery tracks"): GET
// /api/delivery-tracks, each job's track as the kept-track pass kept it — every step it started and ended, where it is
// and what it waits on, its deployment record once closed —; GET /api/deployments, the deployment records on their own.
// Read only.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { DeliveryTracksView, DeploymentsView } from '../domain/kept-tracks.ts';
import { KEPT_TRACKS_EVERY_MS } from '../engine/kept-tracks.ts';
import { parseWith } from './errors.ts';
import type { Operation } from './openapi-operation.ts';
import type { TenantParts } from './tenants.ts';

const repo = z.string().regex(/^[\w.-]+\/[\w.-]+$/);
const limit = z.coerce.number().int().min(1).max(1000).optional();

export const deliveryTrackQuery = z.strictObject({ job: z.string().min(1).max(200).optional(), repo: repo.optional(), state: z.enum(['open', 'closed']).optional(), limit });
export const deploymentQuery = z.strictObject({
  job: z.string().min(1).max(200).optional(), repo: repo.optional(), target: z.string().min(1).max(100).optional(), kind: z.enum(['deploy', 'none']).optional(), limit,
});

export const DELIVERY_TRACK_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/delivery-tracks', tag: 'Jobs', summary: 'Each job\'s kept delivery track: every step, where it is and what it waits on', description: `The kept delivery tracks (issue #2775). Every ${KEPT_TRACKS_EVERY_MS / 1000} seconds the kept-track pass folds the new events into each job's track, from its \`job.queued\` on: \`steps\`, every delivery step it started, with its end once it ended; \`current\`, the step it is in, \`since\` when, its \`blocker\` and \`waitingOn\` in plain words — a change merged on the landing branch but not promoted is in \`landing_checks\`, not done —; \`state\` \`open\` until it closes with its one \`deployment\` record (\`closedAt\`). A closed track is final. Filters: \`job\`, \`repo\` (\`owner/name\`), \`state\`, \`limit\` (default 1000); newest first. 400: a bad query.`, query: deliveryTrackQuery, returns: '`DeliveryTracksView` `{ tracks: KeptTrack[] }`', errors: [400] },
  { method: 'get', path: '/api/deployments', tag: 'Jobs', summary: 'The deployment records: one per job whose kept track closed', description: 'The deployment records (issue #2775): each job\'s one record, made when its kept delivery track closed. `kind` `deploy`: its change was delivered — `artifact` (its pull request), `target` (`production`), `expected` (`delivered`) and `observed`, each delivery step it went through. `kind` `none`: no deployment expected — `source` (its issue, else its source\'s name) and `outcome` (`status`: the job\'s end, `pull_request_closed`, or `marked` by a person, with `by` and `note`; `report`: `research` or `proposal`). Filters: `job`, `repo`, `target`, `kind`, `limit` (default 1000); newest first. 400: a bad query.', query: deploymentQuery, returns: '`DeploymentsView` `{ deployments: DeploymentRecord[] }`', errors: [400] },
];

export function deliveryTrackRoutes(app: FastifyInstance, o: { tenant: (req: FastifyRequest) => TenantParts }): void {
  app.get('/api/delivery-tracks', async (req): Promise<DeliveryTracksView> => {
    const q = parseWith(deliveryTrackQuery, req.query);
    return { tracks: o.tenant(req).store.keptTracks.list(q) };
  });
  app.get('/api/deployments', async (req): Promise<DeploymentsView> => {
    const q = parseWith(deploymentQuery, req.query);
    return { deployments: o.tenant(req).store.keptTracks.deployments(q) };
  });
}
