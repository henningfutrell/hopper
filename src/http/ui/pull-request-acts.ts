// Merge now and Close PR (issue #677, design.md "PR waiting"): a person's act on a finished job's open pull request, from
// its card on the Pull requests page or `hopper pr merge|close`. Answered at once (issue #1194): after the answer the
// job's source merges it on the yolo path — whatever yolo mode and its checks say; GitHub still refuses a draft, merge
// conflicts or a required check — or closes it without a merge, and it is recorded with who pressed it; a refusal is
// recorded with why (`job.pull_request_act_failed`). Least role: operator. Tend again (issue #1010): a person's act on a card the
// hopper gave up on — its tend job ended failed, cancelled or rejected —: the same step is tended, with who pressed it,
// after the answer (issue #1194). A pull request's diff (issue #1169): a person reads it with their own connection, for a
// job repository only; it changes and records nothing.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { PULL_REQUEST_ACTS, type PullRequestAct } from '../../domain/types.ts';
import type { PullRequestDiff } from '../../domain/pull-request-diff.ts';
import type { Operation } from '../openapi-operation.ts';
import { HttpError, parseWith } from '../errors.ts';
import { signedInOf, type TenantParts } from '../tenants.ts';
import { actingOf } from './sessions.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

/** The job whose open pull request it is: a card's `jobId`. */
export const pullRequestActBody = z.strictObject({ jobId: z.string().min(1).max(200) });

/** A job repository's pull request: its diff's read. */
export const pullRequestDiffBody = z.strictObject({
  repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'repo must be owner/name').max(200),
  number: z.number().int().positive(),
});

const STATUS = { not_found: 404, conflict: 409 } as const;

/** Merge now and Close PR's part of the API reference (src/http/openapi.ts). */
export const PULL_REQUEST_ACT_OPERATIONS: Operation[] = [
  { method: 'post', path: '/ui/api/pull-requests/merge', tag: 'Jobs', summary: 'Merge now', description: 'Issue #677: merge the open pull request of a finished job (a card\'s `jobId`) now, with a merge commit, on the same path as yolo mode, whether yolo mode is on or off and whatever its checks say. Answered at once (issue #1194): 202 once the checks pass; the merge runs after. GitHub still refuses a draft, merge conflicts or a required check: `job.pull_request_act_failed` records what it said, and the card stays. Sent again while one runs, it answers that one. 409: the job has no open pull request, or its source is not running. The merge closes the issue through the pull request\'s closing keyword; a pull request with no closing keyword that is no part (`Part of #N`): the hopper closes the issue as completed and posts one comment that links the pull request. One `job.pull_request_merged` with `person` and `via`. `hopper pr merge <n>` does the same.', role: 'operator', body: pullRequestActBody, returns: '`{ jobId, act: "merge" }`: the job, its merge running', errors: [404, 409] },
  { method: 'post', path: '/ui/api/pull-requests/close', tag: 'Jobs', summary: 'Close PR', description: 'Issue #677: close the open pull request of a finished job without a merge. Answered at once (issue #1194): 202 once the checks pass; the close runs after, and one that fails records `job.pull_request_act_failed` with why. Its issue is flagged `hopper:pr-closed`, as for any pull request closed without a merge. One `job.pull_request_closed` with `person` and `via`. `hopper pr close <n>` does the same.', role: 'operator', body: pullRequestActBody, returns: '`{ jobId, act: "close" }`: the job, its close running', errors: [404, 409] },
  { method: 'post', path: '/ui/api/pull-requests/tend', tag: 'Jobs', summary: 'Tend again', description: 'Issue #1010: the hopper gave up on the pull request of a card (`gaveUp`, `waits: "tend failed"`): its tend job ended failed, cancelled or rejected. Its item runs again at once, by `tending`, with the same step\'s tend brief, and a new row of retries after a cancel by no person starts. One `job.pull_request_tended` with `person` and `via`. A box action. Answered at once (issue #1194): 202 once the checks pass; the tend runs after. A tend its source refuses records `job.give_back_failed` with why, and the card says it. Sent again while one runs, it answers that one. 409: the hopper did not give up on it (no tend ended, the tend job still runs, or the hopper tends it again by itself), a newer job of its item exists, its source is not running, or its tend job\'s end is not reported yet.', role: 'operator', body: pullRequestActBody, returns: '`{ jobId, giveBack: "tend" }`: the job whose pull request it is, its tend running', errors: [404, 409] },
  { method: 'post', path: '/ui/api/pull-requests/diff', tag: 'Jobs', summary: 'Read a pull request\'s diff', description: 'Issue #1169: the diff of pull request `number` of job repository `repo`, read on GitHub with the person\'s own connection, as a job\'s `pr diff` reads it (issue #1074): `files` (each `file`, `status`, `additions`, `deletions`, and `from` when it moved) and `diff`, each file\'s patch as `git diff` writes it; a binary or too large file says it has none. A diff longer than 200,000 characters is cut and says `truncated`. A read, but a POST under /ui/api, so that the role guard applies. It changes and records nothing. 404: not a job repository, or GitHub has no such pull request; 503: no GitHub connection; 502: GitHub refused.', role: 'operator', body: pullRequestDiffBody, returns: '`PullRequestDiff` `{ number, url, files, diff, truncated? }`', errors: [400, 404, 502, 503] },
];

export function registerPullRequestActRoutes(app: FastifyInstance, o: { operator: Guard; tenant: (req: FastifyRequest) => TenantParts }): void {
  const route = (act: PullRequestAct) => app.post(`/ui/api/pull-requests/${act}`, o.operator, async (req, reply) => {
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to merge or close a pull request');
    const { jobId } = parseWith(pullRequestActBody, req.body);
    // Answered once checked; the merge or close runs after (issue #1194).
    const r = o.tenant(req).registry.pullRequestAct(jobId, act, actingOf(s));
    if (!r.ok) throw new HttpError(STATUS[r.reason], r.message);
    return reply.code(202).send({ jobId: r.jobId, act: r.act });
  });
  for (const act of PULL_REQUEST_ACTS) route(act);
  app.post('/ui/api/pull-requests/tend', o.operator, async (req, reply) => {
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to tend a pull request again');
    const { jobId } = parseWith(pullRequestActBody, req.body);
    // Answered once checked; the tend runs after (issue #1194).
    const registry = o.tenant(req).registry;
    const r = registry.afterAnswer('tend', registry.checkTendAgain(jobId, actingOf(s)), actingOf(s));
    if (!r.ok) throw new HttpError(STATUS[r.reason], r.message);
    return reply.code(202).send({ jobId: r.jobId, giveBack: r.giveBack });
  });
  app.post('/ui/api/pull-requests/diff', o.operator, async (req): Promise<PullRequestDiff> => {
    const b = parseWith(pullRequestDiffBody, req.body);
    const t = o.tenant(req);
    // Read as the job repository is spelled in the settings.
    const repo = t.store.settings.getJobRepositories('github').find((r) => r.toLowerCase() === b.repo.toLowerCase());
    if (!repo) throw new HttpError(404, `${b.repo} is not a job repository`);
    const { number } = b;
    const api = t.githubProxy.reads();
    if ('problem' in api) throw new HttpError(503, api.problem);
    try {
      const d = await api.perform({ op: 'pr.diff', repo, number });
      return { number, url: d.url, files: d.files as PullRequestDiff['files'], diff: d.diff as string, ...(d.truncated ? { truncated: true } : {}) };
    } catch (err) {
      throw new HttpError((err as { status?: number }).status === 404 ? 404 : 502, (err as Error).message);
    }
  });
}
