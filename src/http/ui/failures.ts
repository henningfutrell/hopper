// The UI session's actions on failures (issue #509): resolve a problem, release its held jobs, run a surfaced
// failure's job again, resolve a hand-off (issues #516, #551), push or discard work not pushed, a stuck cause's bulk
// action (issue #1010) (operator); the failures settings and the known causes a person names (admin). Each refuses
// with the reason the Failures view reads from `actions`, so the view offers only what is taken.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { FAILURE_DECISIONS, FAILURE_SETTING_BOUNDS, HANDOFF_RESOLUTIONS, STUCK_BULK } from '../../domain/types.ts';
import type { FailureAction } from '../../failures/index.ts';
import { pushKeptWork } from '../../failures/kept-work.ts';
import { actOnStuck } from '../../failures/stuck.ts';
import { HttpError, parseWith } from '../errors.ts';
import type { Operation } from '../openapi-operation.ts';
import { signedInOf, type TenantParts } from '../tenants.ts';
import { actingOf } from './sessions.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

const idParams = z.object({ id: z.string() });
const int = (k: keyof typeof FAILURE_SETTING_BOUNDS) => z.number().int().min(FAILURE_SETTING_BOUNDS[k].min).max(FAILURE_SETTING_BOUNDS[k].max).optional();
/** Any of the settings; one left out keeps its value. */
export const failureSettingsBody = z.strictObject({
  maxAttempts: int('maxAttempts'), backoffSec: int('backoffSec'),
  backoffFactor: z.number().min(FAILURE_SETTING_BOUNDS.backoffFactor.min).max(FAILURE_SETTING_BOUNDS.backoffFactor.max).optional(),
  backoffMaxSec: int('backoffMaxSec'), groupThreshold: int('groupThreshold'), groupWindowMin: int('groupWindowMin'), retentionDays: int('retentionDays'),
  handoffRetentionDays: int('handoffRetentionDays'), handoffNotify: z.boolean().optional(), activeWindowMin: int('activeWindowMin'),
  auto: z.strictObject({ retry: z.boolean().optional(), hold: z.boolean().optional(), redirect: z.boolean().optional(), continue: z.boolean().optional() }).optional(),
}).refine((b) => Object.values(b).some((v) => v !== undefined), { message: 'name at least one setting' });
const signature = z.string().regex(/^[0-9a-f]{12}$/, 'signature must be 12 hex digits');
export const failureCauseBody = z.strictObject({
  // Continue is the timed-out cause's alone (issue #630): it needs a timeout's liveness.
  signature, name: z.string().trim().min(1).max(80), description: z.string().trim().max(500).default(''), decision: z.enum(FAILURE_DECISIONS.filter((d) => d !== 'continue')),
});
export const failureForgetBody = z.strictObject({ signature });
const NOTE_MAX = 4000;
/**
 * A hand-off's resolution (issue #551): the action, a note — Won't do says why —, and for Done by hand a link to the
 * work. The note and the link are written to the job's item at its source.
 */
export const handoffResolveBody = z.strictObject({
  action: z.enum(HANDOFF_RESOLUTIONS),
  note: z.string().trim().max(NOTE_MAX).optional(),
  link: z.url({ protocol: /^https?$/, error: 'link must be an http or https URL' }).max(2000).optional(),
}).refine((b) => b.action !== 'wont_do' || (b.note ?? '') !== '', { message: 'Won\'t do says why: give a note', path: ['note'] })
  .refine((b) => b.link === undefined || b.action === 'done_by_hand', { message: 'only Done by hand takes a link', path: ['link'] });

/** Push it on work not pushed (issue #1010): a note, if any, told to the job that goes on. */
export const keptWorkPushBody = z.strictObject({ note: z.string().trim().max(NOTE_MAX).optional() });

/** Push it and Discard on work not pushed (issue #1010), as the OpenAPI document lists them. */
export const KEPT_WORK_OPERATIONS: Operation[] = [
  { method: 'post', path: '/ui/api/failures/kept-work/:id/push', tag: 'Failures', summary: 'Push work not pushed', description: 'Work not pushed (issue #1010): a failed job whose reap kept work in its scratch dir — uncommitted, or commits no remote has — goes on in its own agent session and kept work tree, told to push the work and open the pull request (a draft when the work is not finished), with the `note`, if any. With an open hand-off, it resolves it as Continue (`handoff.closed`, `end: "continued"`); else `job.continued` with `keptWork`. Its source takes the item back, as for Run again. A box action. 409: it has no work kept, it is not failed, its session cannot resume, or a newer job of its item exists (the item\'s `actions.push` in `keptWork` of `GET /api/failures` says why).', role: 'operator', body: keptWorkPushBody, returns: '`{ job, handoff? }`: the job, queued again, and the hand-off it resolved', errors: [400, 401, 404, 409] },
  { method: 'post', path: '/ui/api/failures/kept-work/:id/discard', tag: 'Failures', summary: 'Discard work not pushed', description: 'Work not pushed (issue #1010): the ended job\'s kept scratch dir is removed on its machine, whatever it holds — its git worktrees removed with --force —, then `job.work_removed` with `discarded` and who acted (`person`, `via`). The work is lost. A box action. 409: it has no work kept, it has not ended, or its machine is unknown, offline, out of reach, or kept it all the same (a client older than this hopper: update it, then discard again).', role: 'operator', returns: '`{ jobId, paths }`: the scratch dir removed', errors: [401, 404, 409] },
];

/** A stuck cause with a bulk action (issue #1010). */
export const stuckParams = z.object({ cause: z.enum(STUCK_BULK) });

/** A stuck cause's bulk action (issue #1010), as the OpenAPI document lists it. */
export const STUCK_OPERATIONS: Operation[] = [
  { method: 'post', path: '/ui/api/failures/stuck/:cause', tag: 'Failures', summary: 'Act on a stuck cause', description: 'Stuck work (issue #1010): runs the bulk action of one stuck cause (`stuck` in `GET /api/failures`) on each of its items now, one after another, through the same path as the item\'s own button: `continue`, `run_again` and `wont_do` resolve each open hand-off so (Won\'t do with its card\'s why as the note), `retry` runs each failure again, `push` is Push it on each job\'s work not pushed, `tend` is Tend again on each pull request the hopper gave up on. An item refused meanwhile is skipped with why; the others go on. A box action. 400: the cause has no bulk action.', role: 'operator', returns: '`StuckActResult`: `{ cause, done, refused: [{ id, why }] }`', errors: [400, 401] },
];

/** A problem's resolution (issue #623): a note, if any, kept in its `failure.resolved`. */
export const problemResolveBody = z.strictObject({ note: z.string().trim().max(NOTE_MAX).optional() });

const STATUS = { not_found: 404, conflict: 409 } as const;

function answer<T>(r: FailureAction<T>): T {
  if (r.ok) return r.value;
  throw new HttpError(STATUS[r.reason], r.message);
}

/** Who acts through the request's session; none signed in is refused. */
function actingIn(req: FastifyRequest) {
  const s = signedInOf(req);
  if (!s) throw new HttpError(401, 'sign in to act on failures');
  return actingOf(s);
}

export function registerFailureRoutes(app: FastifyInstance, o: { operator: Guard; admin: Guard; tenant: (req: FastifyRequest) => TenantParts }): void {
  // The done-check backfill (issue #637): each done-check failure waiting on a person judged again; what it changed.
  app.post('/ui/api/backfill/done-check', o.operator, async (req) => {
    actingIn(req);
    return o.tenant(req).failures.backfill.run();
  });
  // Who acted, and the way — the UI or the operator CLI —, is kept in the events (issue #623).
  app.post('/ui/api/failures/problems/:id/resolve', o.operator, async (req) => {
    const { note } = parseWith(problemResolveBody, req.body ?? {});
    return answer(o.tenant(req).failures.resolve(parseWith(idParams, req.params).id, actingIn(req), note || undefined));
  });
  app.post('/ui/api/failures/problems/:id/release', o.operator, async (req) => answer(o.tenant(req).failures.release(parseWith(idParams, req.params).id, actingIn(req))));
  // Who resolved it is kept on the hand-off, never written to the source (issue #551).
  app.post('/ui/api/failures/handoffs/:id/resolve', o.operator, async (req) => {
    const { action, note, link } = parseWith(handoffResolveBody, req.body);
    return answer(await o.tenant(req).failures.resolveHandoff(parseWith(idParams, req.params).id, { action, ...(note ? { note } : {}), ...(link ? { link } : {}) }, actingIn(req)));
  });
  // Work not pushed (issue #1010): Push it goes on in the job's own session; Discard removes its kept scratch dir.
  app.post('/ui/api/failures/kept-work/:id/push', o.operator, async (req) => {
    const { note } = parseWith(keptWorkPushBody, req.body ?? {});
    const t = o.tenant(req);
    const d = { store: t.store, resumable: t.engine.resumable, takesBack: t.registry.takesBack, continueJob: t.registry.continueJob, resolveHandoff: t.failures.resolveHandoff };
    return answer(await pushKeptWork(d, parseWith(idParams, req.params).id, note || undefined, actingIn(req)));
  });
  app.post('/ui/api/failures/kept-work/:id/discard', o.operator, async (req) => o.tenant(req).engine.discardWork(parseWith(idParams, req.params).id, actingIn(req)));
  // A stuck cause's bulk action (issue #1010): each item through its own button's path.
  app.post('/ui/api/failures/stuck/:cause', o.operator, async (req) => {
    const { cause } = parseWith(stuckParams, req.params);
    const by = actingIn(req);
    const t = o.tenant(req);
    const kept = { store: t.store, resumable: t.engine.resumable, takesBack: t.registry.takesBack, continueJob: t.registry.continueJob, resolveHandoff: t.failures.resolveHandoff };
    return actOnStuck({
      view: () => t.failures.view(), resolveHandoff: t.failures.resolveHandoff, retry: t.failures.retry, tendAgain: t.registry.tendAgain,
      push: (jobId, who) => pushKeptWork(kept, jobId, undefined, who),
    }, cause, by);
  });
  app.post('/ui/api/failures/:id/retry', o.operator, async (req) => answer(await o.tenant(req).failures.retry(parseWith(idParams, req.params).id, actingIn(req))));
  // Read at each assessment and sweep: applies without a restart.
  app.post('/ui/api/failures/settings', o.admin, async (req) => {
    const { auto, ...rest } = parseWith(failureSettingsBody, req.body);
    const f = o.tenant(req).failures;
    const was = f.settings().auto;
    const defined = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
    return f.setSettings({ ...defined, ...(auto ? { auto: { ...was, ...Object.fromEntries(Object.entries(auto).filter(([, v]) => v !== undefined)) } } : {}) });
  });
  app.post('/ui/api/failures/causes', o.admin, async (req) => o.tenant(req).failures.nameCause(parseWith(failureCauseBody, req.body)));
  app.post('/ui/api/failures/causes/forget', o.admin, async (req) => {
    const { signature: s } = parseWith(failureForgetBody, req.body);
    if (!o.tenant(req).failures.forgetCause(s)) throw new HttpError(404, `no named cause for signature ${s}`);
    return { forgotten: s };
  });
}
