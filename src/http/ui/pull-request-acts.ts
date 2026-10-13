// Merge now and Close PR (issue #677, design.md "PR waiting"): a person's act on a finished job's open pull request, from
// its card on the Pull requests page or `hopper pr merge|close`. The job's source merges it on the yolo path — whatever
// yolo mode and its checks say; GitHub still refuses a draft, merge conflicts or a required check — or closes it without
// a merge, and it is recorded with who pressed it. Least role: operator. Tend again (issue #1010): a person's act on a card the
// hopper gave up on — its tend job ended failed, cancelled or rejected —: the same step is tended at once, with who pressed it.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { PULL_REQUEST_ACTS, type PullRequestAct } from '../../domain/types.ts';
import type { Operation } from '../openapi-operation.ts';
import { HttpError, parseWith } from '../errors.ts';
import { signedInOf, type TenantParts } from '../tenants.ts';
import { actingOf } from './sessions.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

/** The job whose open pull request it is: a card's `jobId`. */
export const pullRequestActBody = z.strictObject({ jobId: z.string().min(1).max(200) });

const STATUS = { not_found: 404, conflict: 409, source: 502 } as const;

/** Merge now and Close PR's part of the API reference (src/http/openapi.ts). */
export const PULL_REQUEST_ACT_OPERATIONS: Operation[] = [
  { method: 'post', path: '/ui/api/pull-requests/merge', tag: 'Jobs', summary: 'Merge now', description: 'Issue #677: merge the open pull request of a finished job (a card\'s `jobId`) now, with a merge commit, on the same path as yolo mode, whether yolo mode is on or off and whatever its checks say. GitHub still refuses a draft, merge conflicts or a required check: 409 with what it said, and the card stays. The merge closes the issue through the pull request\'s closing keyword; a pull request with no closing keyword that is no part (`Part of #N`): the hopper closes the issue as completed and posts one comment that links the pull request. One `job.pull_request_merged` with `person` and `via`. `hopper pr merge <n>` does the same.', role: 'operator', body: pullRequestActBody, returns: '`{ outcome, pullRequest, part }`', errors: [404, 409, 502] },
  { method: 'post', path: '/ui/api/pull-requests/close', tag: 'Jobs', summary: 'Close PR', description: 'Issue #677: close the open pull request of a finished job without a merge. Its issue is flagged `hopper:pr-closed`, as for any pull request closed without a merge. One `job.pull_request_closed` with `person` and `via`. `hopper pr close <n>` does the same.', role: 'operator', body: pullRequestActBody, returns: '`{ outcome, pullRequest, part }`', errors: [404, 409, 502] },
  { method: 'post', path: '/ui/api/pull-requests/tend', tag: 'Jobs', summary: 'Tend again', description: 'Issue #1010: the hopper gave up on the pull request of a card (`gaveUp`, `waits: "tend failed"`): its tend job ended failed, cancelled or rejected. Its item runs again at once, by `tending`, with the same step\'s tend brief, and a new row of retries after a cancel by no person starts. One `job.pull_request_tended` with `person` and `via`. A box action. 409: the hopper did not give up on it (no tend ended, the tend job still runs, or the hopper tends it again by itself), a newer job of its item exists, its source is not running, its tend job\'s end is not reported yet, or its source refused the tend.', role: 'operator', body: pullRequestActBody, returns: '`{ job }`: the new tend job', errors: [404, 409] },
];

export function registerPullRequestActRoutes(app: FastifyInstance, o: { operator: Guard; tenant: (req: FastifyRequest) => TenantParts }): void {
  const route = (act: PullRequestAct) => app.post(`/ui/api/pull-requests/${act}`, o.operator, async (req) => {
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to merge or close a pull request');
    const { jobId } = parseWith(pullRequestActBody, req.body);
    const r = await o.tenant(req).registry.pullRequestAct(jobId, act, actingOf(s));
    if (!r.ok) throw new HttpError(STATUS[r.reason], r.message);
    return { outcome: r.outcome, pullRequest: r.pullRequest, part: r.part };
  });
  for (const act of PULL_REQUEST_ACTS) route(act);
  app.post('/ui/api/pull-requests/tend', o.operator, async (req) => {
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to tend a pull request again');
    const { jobId } = parseWith(pullRequestActBody, req.body);
    const r = await o.tenant(req).registry.tendAgain(jobId, actingOf(s));
    if (!r.ok) throw new HttpError(STATUS[r.reason], r.message);
    return { job: r.job };
  });
}
