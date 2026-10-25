// A person's delivery hold and its release (issue #2775 part 8, design.md "Part 8: the hold and release routes"): POST
// /ui/api/delivery-tracks/hold puts a delivery hold on it at the step it is in — a pause (`owner` `hopper`), or ownership
// taken (`owner` `person`) —, and POST /ui/api/delivery-tracks/release lets it go on, or hands it back. Only an act the
// step allows (`allowedActs`) is taken; a refused act appends no event and leaves the track as it was. A release lets a
// merge or a promotion go on, so it is a box action (`BOX_ACTIONS`). The step's own owner reads the hold from its event
// (part 7); the route keeps the act on the job's kept track too, so its answer shows it at once.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { KeptTrack } from '../../domain/kept-tracks.ts';
import { withIntervention } from '../../domain/track-interventions.ts';
import { jobHold, withActs } from '../../users/delivery-holds.ts';
import type { Operation } from '../openapi-operation.ts';
import { HttpError, parseWith } from '../errors.ts';
import { signedInOf, type TenantParts } from '../tenants.ts';
import { personOf } from './sessions.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

const job = z.string().min(1).max(200);
const reason = z.string().trim().min(1).max(500).optional();
export const holdBody = z.strictObject({ job, owner: z.enum(['hopper', 'person']).optional(), reason });
export const releaseBody = z.strictObject({ job, reason });

const refusals = '404: the job has no kept track (the kept-track pass keeps it within a minute of its start). 409: its step does not allow the act (a closed track; a queued or coding change, which Park and Pick up reach; a held change takes only a release), with the reason. A refused act changes nothing.';
export const DELIVERY_HOLD_OPERATIONS: Operation[] = [
  { method: 'post', path: '/ui/api/delivery-tracks/hold', tag: 'Jobs', summary: 'Hold a job\'s change, or take ownership of it', description: `Issue #2775 part 8: a person puts a delivery hold on the change of \`job\` at the step it is in, with their \`reason\` (\`delivery_track.held\`). \`owner\` \`hopper\` (the default) holds it: the step's own owner — yolo mode, the batch runner, the stable move — keeps it but does not act on it. \`owner\` \`person\`: the person takes ownership of it, and the step's owner does not act on it until they hand it back. It stops no job and no batch run in progress. Kept on its kept delivery track as an intervention. ${refusals}`, role: 'operator', body: holdBody, returns: '`KeptTrack`, with its `hold` and `acts`', errors: [400, 404, 409] },
  { method: 'post', path: '/ui/api/delivery-tracks/release', tag: 'Jobs', summary: 'Release a job\'s change: resume it, or hand it back', description: `Issue #2775 part 8: a person releases the delivery hold of the change of \`job\`, with their \`reason\` (\`delivery_track.released\`): the step's own owner acts on it again at its next pass. A box action: it lets a merge or a promotion go on. Kept on its kept delivery track as an intervention. ${refusals}`, role: 'operator', body: releaseBody, returns: '`KeptTrack`, with its `acts`', errors: [400, 404, 409] },
];

export function registerDeliveryHoldRoutes(app: FastifyInstance, o: { operator: Guard; tenant: (req: FastifyRequest) => TenantParts }): void {
  for (const act of ['hold', 'release'] as const) {
    app.post(`/ui/api/delivery-tracks/${act}`, o.operator, async (req): Promise<KeptTrack> => {
      const s = signedInOf(req);
      if (!s) throw new HttpError(401, 'sign in to hold or release a job\'s change');
      const { store } = o.tenant(req);
      const b = act === 'hold' ? parseWith(holdBody, req.body) : parseWith(releaseBody, req.body);
      const owner = 'owner' in b && b.owner === 'person' ? 'person' : 'hopper';
      return store.tx(() => {
        const kept = store.keptTracks.get(b.job);
        if (!kept) throw new HttpError(404, `job ${b.job} has no kept delivery track`);
        // The hold as its events say now: the pass keeps it on the track only at its next run.
        const hold = jobHold(store, b.job);
        const { hold: _kept, ...unheld } = kept;
        const [now] = withActs(store, [hold ? { ...unheld, hold } : unheld]);
        const wanted = act === 'release' ? 'release' : owner === 'person' ? 'take_ownership' : 'hold';
        if (!now!.acts!.includes(wanted)) {
          throw new HttpError(409, kept.state !== 'open' ? `the delivery track of job ${b.job} is closed`
            : hold ? `the change of job ${b.job} is held already: it takes only a release`
            : act === 'release' ? `the change of job ${b.job} is not held` : `the ${kept.current.step} step of job ${b.job} allows no hold: ${now!.acts!.join(', ') || 'no act'} reaches it now`);
        }
        const data = { by: personOf(s), step: kept.current.step, ...(act === 'hold' ? { owner } : {}), ...(b.reason ? { reason: b.reason } : {}) };
        const e = store.events.append({ type: act === 'hold' ? 'delivery_track.held' : 'delivery_track.released', jobId: b.job, data });
        const { acts: _acts, ...track } = withIntervention(now!, e);
        store.keptTracks.save([track]);
        return withActs(store, [track])[0]!;
      });
    });
  }
}
