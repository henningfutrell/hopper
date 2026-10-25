// The no-deploy mark (issue #2775, design.md "Kept delivery tracks"): POST /ui/api/delivery-tracks/no-deploy, a person's
// act that closes a job's open kept delivery track with a deployment record of kind `none`, recorded as
// `delivery_track.no_deploy_marked`. It changes no job, pull request or promotion: the hopper records the act.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { noDeployOf, type KeptTrack } from '../../domain/kept-tracks.ts';
import type { Operation } from '../openapi-operation.ts';
import { HttpError, parseWith } from '../errors.ts';
import { signedInOf, type TenantParts } from '../tenants.ts';
import { personOf } from './sessions.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

export const noDeployBody = z.strictObject({ job: z.string().min(1).max(200), note: z.string().trim().min(1).max(500).optional() });

export const DELIVERY_NO_DEPLOY_OPERATIONS: Operation[] = [
  { method: 'post', path: '/ui/api/delivery-tracks/no-deploy', tag: 'Jobs', summary: 'Mark a job no-deploy', description: 'Issue #2775: a person closes the open kept delivery track of `job` with a deployment record of kind `none`, outcome `marked`, with who and their `note` (`delivery_track.no_deploy_marked`) — for a change that is not deployed anywhere. A closed track is final. It changes no job, pull request or promotion. 404: the job has no kept track (the kept-track pass keeps it within a minute of its start). 409: its track is closed already.', role: 'operator', body: noDeployBody, returns: '`KeptTrack`, closed', errors: [400, 404, 409] },
];

export function registerDeliveryNoDeployRoutes(app: FastifyInstance, o: { operator: Guard; tenant: (req: FastifyRequest) => TenantParts }): void {
  app.post('/ui/api/delivery-tracks/no-deploy', o.operator, async (req): Promise<KeptTrack> => {
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to mark a job no-deploy');
    const { store } = o.tenant(req);
    const b = parseWith(noDeployBody, req.body);
    return store.tx(() => {
      const kept = store.keptTracks.get(b.job);
      if (!kept) throw new HttpError(404, `job ${b.job} has no kept delivery track`);
      if (kept.state === 'closed') throw new HttpError(409, `the delivery track of job ${b.job} is closed already`);
      const by = personOf(s);
      const e = store.events.append({ type: 'delivery_track.no_deploy_marked', jobId: b.job, data: { by, ...(b.note ? { note: b.note } : {}) } });
      const closed = noDeployOf(kept, { by, at: e.at, ...(b.note ? { note: b.note } : {}) });
      store.keptTracks.save([closed]);
      return closed;
    });
  });
}
