// The UI session's actions on one job: cancel, approve, operator-led, reject, run again, rework (issue #724), park and re-queue
// (issue #501), end its own wait (issue #483), send it a note (issue #997), dismiss — or many at once (issue #1123) —, mark cleaned up; for a job held because its item changed since
// the snapshot (issue #662), keep the original text, or accept the new text — the owner only, as Access decides; quarantine
// a job, and lift it (issue #655). Least role: operator.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { HttpError, parseWith } from '../errors.ts';
import { EngineError } from '../../engine/errors.ts';
import type { TenantParts } from '../tenants.ts';
import { cancelBody, dismissManyBody, endWaitBody, noteBody, rejectBody, requeueBody, reworkBody } from './job-bodies.ts';
import type { Access } from '../../authz/service.ts';
import { signedInOf } from '../tenants.ts';
import { actingOf } from './sessions.ts';
import type { Operation } from '../openapi-operation.ts';

const idParams = z.object({ id: z.string() });
const GIVE_BACK_STATUS = { not_found: 404, conflict: 409 } as const;

export function registerJobActionRoutes(app: FastifyInstance, o: {
  operator: { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };
  tenant: (req: FastifyRequest) => TenantParts;
  access: Pick<Access, 'decideTextAcceptance'>;
}): void {
  const signedIn = (req: FastifyRequest) => {
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to act on a changed item');
    return s;
  };
  const signedInTo = (req: FastifyRequest, act: string) => {
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, `sign in to ${act}`);
    return s;
  };
  const signedInWith = (req: FastifyRequest) => {
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to send a note');
    return s;
  };
  // The person's reason (issue #1460) is the cancel's note: its reason stays `cancelled in UI`, a cancel on purpose.
  app.post('/ui/api/jobs/:id/cancel', o.operator, async (req) =>
    o.tenant(req).engine.cancel(parseWith(idParams, req.params).id, 'cancelled in UI', parseWith(cancelBody, req.body ?? {}).reason || undefined));
  app.post('/ui/api/jobs/:id/approve', o.operator, async (req) => o.tenant(req).engine.approve(parseWith(idParams, req.params).id));
  app.post('/ui/api/jobs/:id/operator-led', o.operator, async (req) => o.tenant(req).engine.claimByOperator(parseWith(idParams, req.params).id));
  app.post('/ui/api/jobs/:id/reject', o.operator, async (req) => o.tenant(req).engine.reject(parseWith(idParams, req.params).id, parseWith(rejectBody, req.body ?? {}).reason));
  // Run again and Rework answer once their checks pass (issue #1194): 202, the give-back running; the new job follows.
  const giveBack = (req: FastifyRequest, reply: FastifyReply, act: { kind: 'rerun' } | { kind: 'rework'; notes: string }) => {
    const s = signedInOf(req);
    const r = o.tenant(req).registry.giveBack(parseWith(idParams, req.params).id, act, s ? actingOf(s) : undefined);
    if (!r.ok) throw new HttpError(GIVE_BACK_STATUS[r.reason], r.message);
    return reply.code(202).send({ jobId: r.jobId, giveBack: r.giveBack });
  };
  app.post('/ui/api/jobs/:id/rerun', o.operator, async (req, reply) => giveBack(req, reply, { kind: 'rerun' }));
  app.post('/ui/api/jobs/:id/rework', o.operator, async (req, reply) => giveBack(req, reply, { kind: 'rework', notes: parseWith(reworkBody, req.body ?? {}).notes }));
  app.post('/ui/api/jobs/:id/park', o.operator, async (req) => o.tenant(req).engine.park(parseWith(idParams, req.params).id));
  app.post('/ui/api/jobs/:id/requeue', o.operator, async (req) => o.tenant(req).engine.requeue(parseWith(idParams, req.params).id, parseWith(requeueBody, req.body ?? {})));
  app.post('/ui/api/jobs/:id/end-wait', o.operator, async (req) => {
    const { note } = parseWith(endWaitBody, req.body ?? {});
    return o.tenant(req).engine.endWait(parseWith(idParams, req.params).id, note || undefined);
  });
  // A note to a job (issue #997): queued on it until its session gets it, by whoever sent it, through the UI or an API token.
  app.post('/ui/api/jobs/:id/notes', o.operator, async (req) => {
    const { text } = parseWith(noteBody, req.body ?? {});
    return o.tenant(req).engine.addNote(parseWith(idParams, req.params).id, text, actingOf(signedInWith(req)));
  });
  app.post('/ui/api/jobs/:id/keep-original', o.operator, async (req) =>
    o.tenant(req).engine.keepOriginalText(parseWith(idParams, req.params).id, actingOf(signedIn(req))));
  app.post('/ui/api/jobs/:id/accept-new-text', o.operator, async (req) => {
    const s = signedIn(req);
    const t = o.tenant(req);
    const job = t.store.jobs.get(parseWith(idParams, req.params).id);
    if (!job) throw new HttpError(404, `job ${parseWith(idParams, req.params).id} not found`);
    if (!job.textChange || !job.source) throw new HttpError(409, `job ${job.id} is not held for a changed item`);
    // The item is the hopper's user's whose jobs these are: Access decides whether the person signed in may accept for them.
    const d = await o.access.decideTextAcceptance(s.userId, { ownerId: s.userId, key: job.source.key });
    if (!d.allowed) throw new HttpError(403, `accepting the new text is refused: ${d.reason}`);
    return t.engine.acceptNewText(job.id, actingOf(s));
  });
  // Quarantine (issue #655): held, and its proxy token opens no door; lifted to the level it had. Who acted is kept.
  app.post('/ui/api/jobs/:id/quarantine', o.operator, async (req) =>
    o.tenant(req).engine.quarantine(parseWith(idParams, req.params).id, actingOf(signedInTo(req, 'quarantine a job'))));
  app.post('/ui/api/jobs/:id/unquarantine', o.operator, async (req) =>
    o.tenant(req).engine.liftQuarantine(parseWith(idParams, req.params).id, actingOf(signedInTo(req, 'lift a quarantine'))));
  // Issue #655 part 4: a person approves the trust of a job Jev's trust check lowered.
  app.post('/ui/api/jobs/:id/approve-trust', o.operator, async (req) =>
    o.tenant(req).engine.approveTrust(parseWith(idParams, req.params).id, actingOf(signedInTo(req, 'approve a job\'s trust'))));
  app.post('/ui/api/jobs/:id/dismiss', o.operator, async (req) => o.tenant(req).engine.dismiss(parseWith(idParams, req.params).id));
  // Many at once (issue #1123): each as one Dismiss, a refusal kept with why; or every failed job nothing waits on any more.
  app.post('/ui/api/jobs/dismiss', o.operator, async (req) => {
    const body = parseWith(dismissManyBody, req.body ?? {});
    const t = o.tenant(req);
    if (body.superseded) return { dismissed: t.failures.dismissStale(), refused: [] };
    const dismissed: string[] = [];
    const refused: { id: string; why: string }[] = [];
    for (const id of body.jobIds ?? []) {
      try {
        t.engine.dismiss(id);
        dismissed.push(id);
      } catch (e) {
        if (!(e instanceof EngineError)) throw e;
        refused.push({ id, why: e.message });
      }
    }
    return { dismissed, refused };
  });
  app.post('/ui/api/jobs/:id/cleaned-up', o.operator, async (req) => o.tenant(req).engine.markCleanedUp(parseWith(idParams, req.params).id));
}

/** The API reference's entries for a job's notes (issue #997). */
export const JOB_NOTE_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/jobs/:id/notes', tag: 'Jobs', summary: 'A job\'s notes', description: 'The notes people sent the job (issue #997), oldest first: each with its `text`, who sent it (`by`), how (`via`: `ui`, `api` or `cli`), when (`at`) and its `state` — `queued` (its session has not got it yet), `delivered` (`delivery`: `start`, `turn` or `resume`, and `deliveredAt`), or `carried` to a new job of its item (`carriedTo`; that job\'s copy names `carriedFrom`). The same as the job\'s `notes`.', returns: '`{ notes: JobNote[] }`', errors: [404] },
  { method: 'post', path: '/ui/api/jobs/:id/notes', tag: 'Jobs', summary: 'Send a note to a job', description: 'Issue #997: a note to a job that may still run — queued, held, running, on a question, on its own wait, parked, or failed as the newest job of its item. It is kept on the job (`notes`, in the store: it outlives a restart) as `queued`, and typed into the job\'s agent session where the session can read text: at the next turn boundary while it runs (Claude ready and its turn over; never mid-turn, never over a dialog, never in place of a question or a report — then it goes with the answer), in its task as it starts, or after the answer it resumes with. A note does not end a wait or a hold: the job gets it when it goes on. A new job of its item (run again, rework, I fixed it) carries the notes never delivered. The herdr-claude executor types notes in at a turn boundary; a print-mode agent (cursor-agent) gets them only as it starts or resumes; another executor leaves them queued. `job.note_added`, then `job.note_delivered` or `job.note_carried`. A box action. 400: no text, or more than 4000 characters. 409: the job ended (finished, cancelled, rejected, operator-led), or it failed and a newer job of its item exists.', role: 'operator', body: noteBody, returns: 'the `JobNote`', errors: [400, 404, 409] },
];

/** The API reference's entry for Dismiss many (issue #1123). */
export const JOB_DISMISS_OPERATIONS: Operation[] = [
  { method: 'post', path: '/ui/api/jobs/dismiss', tag: 'Jobs', summary: 'Dismiss many locked entries', description: 'Issue #1123. `jobIds`: each failed job named is dismissed as `POST /ui/api/jobs/:id/dismiss` dismisses one; a job that cannot be is kept in `refused`, with why. `superseded: true`: every failed job nothing waits on any more, not yet dismissed, is dismissed now (`job.dismissed` `by` `superseded`: a newer job of its item exists; `item_closed`: its item is closed at its source, done or dropped), its open hand-off closed the same way. The hopper does this by itself too, at each new job, item close and failure sweep: this is for what it has not reached yet. Send one of the two. 400: neither, both, or more than 1000 ids.', role: 'operator', body: dismissManyBody, returns: '`{ dismissed: string[], refused: [{ id, why }] }`', errors: [400] },
];
