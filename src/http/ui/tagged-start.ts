// One click on a tagged item (issue #2342, design.md "Tagged items"): Research, Propose or Start work submits a direct job
// made from the item (`taggedJob`), and the source keeps the start on the item (the intake action `tagged_start`), so a
// second click answers the first start and starts nothing. The click is the approval: a direct job is of a trusted origin,
// so no request card. Only an item the source's last sync listed and a person did not dismiss. Least role: operator. A box
// action: it starts a job.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Clock } from '../../domain/ports.ts';
import { TAGGED_STARTS, TAGGED_WORKS, type TaggedItem, type TaggedStarted } from '../../domain/tagged.ts';
import { taggedJob } from '../../domain/tagged-jobs.ts';
import type { Operation } from '../openapi-operation.ts';
import { HttpError, parseWith } from '../errors.ts';
import { signedInOf, type TenantParts } from '../tenants.ts';
import { sourceParams } from './job-bodies.ts';
import { actingOf } from './sessions.ts';

export const taggedStartBody = z.strictObject({
  key: z.string().min(1).max(500),
  start: z.enum(TAGGED_STARTS),
  /** Start work's kind of work; absent: a pull request's review, an issue's fix. */
  work: z.enum(TAGGED_WORKS).optional(),
}).refine((b) => b.start === 'work' || b.work === undefined, { message: 'only start work takes work' });

export const TAGGED_START_OPERATIONS: Operation[] = [
  { method: 'post', path: '/ui/api/sources/:name/tagged-start', tag: 'Jobs', summary: 'Start a job on a tagged item', description: 'Issue #2342: one click on a **tagged item** the source\'s last sync listed (`key`, its URL) and a person did not dismiss. `start` `research`: a research job (`hopper:research`); `propose`: a proposal (`hopper:proposal`); `work`: the work its item asks for — `work` `review` for a pull request (a draft review in its result), `fix` for an issue (a pull request that closes it) or a pull request (a push to its own branch); absent, the item\'s kind picks. It submits a **direct job** made from the item — its link, why it is tagged and its repository; its text stays on GitHub, where the job reads it as data —, with no authorization and, for `fix` only, the item\'s repository; `direct_job.submitted` records it. The job posts nothing on GitHub in the person\'s name: a review, a comment or a reply is a draft in its result. The click is the approval: no request card. The item keeps the start (`detail.tagged[].started`: `start`, `work`, `directJob`, `jobId`, `at`) while it is tagged; a second start answers the first one (`replayed`) and makes nothing. A box action: an API token needs to be a box token.', role: 'operator', body: taggedStartBody, errors: [400, 401, 404, 409], returns: '`{ started, directJob?, job?, replayed? }`: `started` the start kept on the item; `directJob` the `DirectJob` with its job; `job` the job queued' },
];

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

export function registerTaggedStartRoutes(app: FastifyInstance, o: { operator: Guard; tenant: (req: FastifyRequest) => TenantParts; clock: Clock }): void {
  app.post('/ui/api/sources/:name/tagged-start', o.operator, async (req) => {
    const { name } = parseWith(sourceParams, req.params);
    const b = parseWith(taggedStartBody, req.body);
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to start a job');
    const t = o.tenant(req);
    const status = t.registry.statuses().find((x) => x.name === name);
    if (!status) throw new HttpError(404, `no job source ${name}`);
    const item = (Array.isArray(status.detail?.tagged) ? status.detail.tagged as TaggedItem[] : []).find((i) => i.key === b.key);
    if (!item) throw new HttpError(404, `${b.key}: not a tagged item the last sync listed`);
    // What the source keeps, not what its last status shows: a start before its next sync is kept already.
    const before = t.store.settings.getTaggedRecord(name)?.started?.find((x) => x.key === b.key);
    if (before) return { started: before, ...(t.directJobs.get(before.directJob) ? { directJob: t.directJobs.get(before.directJob) } : {}), replayed: true };
    const made = t.directJobs.submit({ ...taggedJob(item, b.start, b.work) }, actingOf(s));
    const started: TaggedStarted = {
      key: item.key, start: b.start, ...(b.start === 'work' && b.work ? { work: b.work } : {}),
      directJob: made.directJob.id, ...(made.job ? { jobId: made.job.id } : {}), at: o.clock.now().toISOString(),
    };
    const r = await t.registry.intakeAction(name, { kind: 'tagged_start', keys: [item.key], started });
    if (!r.ok) throw new HttpError(r.reason === 'not_found' ? 404 : 409, r.message);
    if (!r.result.done.includes(item.key)) throw new HttpError(409, r.result.failed[item.key] ?? 'not kept');
    return { started, ...made };
  });
}
