// A job's deployment expectation (issue #2775, design.md "Kept delivery tracks"): a person flips it, any number of times,
// until its deployment completes. POST /ui/api/delivery-tracks/no-deploy closes the job's kept delivery track with a
// deployment record of kind `none` (`delivery_track.no_deploy_marked`); POST /ui/api/delivery-tracks/deploy opens it
// again, its record kept, so the kept-track pass follows its change on (`delivery_track.deploy_expected`). Each flip is
// kept on the track and its record. A completed deployment locks both: a flip is refused, and a change goes to a new job.
// It changes no job, pull request or promotion: the hopper records the act.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { expectationOf, expectOf, foldTrackEvents, KEPT_TRACK_EVENTS, lockedOf, type KeptTrack } from '../../domain/kept-tracks.ts';
import type { UserStore } from '../../domain/store.ts';
import { withActs } from '../../users/delivery-holds.ts';
import type { Operation } from '../openapi-operation.ts';
import { HttpError, parseWith } from '../errors.ts';
import { signedInOf, type TenantParts } from '../tenants.ts';
import { personOf } from './sessions.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

export const expectationBody = z.strictObject({ job: z.string().min(1).max(200), note: z.string().trim().min(1).max(500).optional() });

const refusals = '404: the job has no kept track (the kept-track pass keeps it within a minute of its start). 409: its deployment completed (its record is locked), or its expectation is so already.';
export const DELIVERY_EXPECTATION_OPERATIONS: Operation[] = [
  { method: 'post', path: '/ui/api/delivery-tracks/no-deploy', tag: 'Jobs', summary: 'Mark a job no-deploy', description: `Issue #2775: a person closes the kept delivery track of \`job\` with a deployment record of kind \`none\`, outcome \`marked\`, with who and their \`note\` (\`delivery_track.no_deploy_marked\`) — for a change that is not deployed anywhere. The record stays open: a flip to deploy opens the track again. Each flip is kept in \`expectations\`. It changes no job, pull request or promotion. ${refusals}`, role: 'operator', body: expectationBody, returns: '`KeptTrack`, closed, with its `acts`', errors: [400, 404, 409] },
  { method: 'post', path: '/ui/api/delivery-tracks/deploy', tag: 'Jobs', summary: 'Expect a deployment of a job', description: `Issue #2775: a person says the change of \`job\` is to be deployed, with their \`note\` (\`delivery_track.deploy_expected\`). Its kept delivery track opens again, its \`none\` record kept with the flip, and the kept-track pass follows its change until its deployment completes, which locks the record. A job that ends with no change does not close it as \`none\` meanwhile. Each flip is kept in \`expectations\`. It changes no job, pull request or promotion. ${refusals}`, role: 'operator', body: expectationBody, returns: '`KeptTrack`, open, with its `acts`', errors: [400, 404, 409] },
];

/** The track's marks folded again from its job's events: a track a flip opens again missed the events since it closed. */
function refolded(store: UserStore, t: KeptTrack): KeptTrack {
  const marks = new Map([[t.jobId, structuredClone(t.marks)]]);
  foldTrackEvents(marks, store.events.recent(1000, [...KEPT_TRACK_EVENTS], t.jobId));
  return { ...t, marks: marks.get(t.jobId)! };
}

export function registerDeliveryExpectationRoutes(app: FastifyInstance, o: { operator: Guard; tenant: (req: FastifyRequest) => TenantParts }): void {
  for (const expect of ['none', 'deploy'] as const) {
    app.post(`/ui/api/delivery-tracks/${expect === 'none' ? 'no-deploy' : 'deploy'}`, o.operator, async (req): Promise<KeptTrack> => {
      const s = signedInOf(req);
      if (!s) throw new HttpError(401, 'sign in to change what a job deploys');
      const { store } = o.tenant(req);
      const b = parseWith(expectationBody, req.body);
      return store.tx(() => {
        const kept = store.keptTracks.get(b.job);
        if (!kept) throw new HttpError(404, `job ${b.job} has no kept delivery track`);
        if (lockedOf(kept)) throw new HttpError(409, `the deployment of job ${b.job} completed: its record is locked, so a change goes to a new job`);
        if (expect === 'none' ? kept.state === 'closed' : expectationOf(kept) === 'deploy') {
          throw new HttpError(409, `job ${b.job} ${expect === 'none' ? 'expects no deployment' : 'expects a deployment'} already`);
        }
        const by = personOf(s);
        const data = { by, ...(b.note ? { note: b.note } : {}) };
        const e = store.events.append({ type: expect === 'none' ? 'delivery_track.no_deploy_marked' : 'delivery_track.deploy_expected', jobId: b.job, data });
        const flipped = expectOf(kept.state === 'closed' ? refolded(store, kept) : kept, { expect, at: e.at, ...data });
        store.keptTracks.save([flipped]);
        return withActs(store, [flipped])[0]!;
      });
    });
  }
}
