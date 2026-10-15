// Repositories with no checks (issue #677, design.md "Repositories with no checks"): each job repository's checks, and the
// "Add PR checks" job for one with none — queued with one button as the person's own issue, or dismissed for that
// repository. The list answers from the database and never reads GitHub (issue #1250); Refresh reads GitHub in the
// background, and `?repo=` reads that one repository now. The service is the user's (`githubProxy.repoChecks`), with its
// schedule. Least role to act: operator.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { RepoChecksRefused } from '../../repo-checks/index.ts';
import type { Operation } from '../openapi-operation.ts';
import { HttpError, parseWith } from '../errors.ts';
import { signedInOf, type TenantParts } from '../tenants.ts';
import { identityName } from './sessions.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

const repoName = z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'owner/repo').max(200);
export const repoChecksQuery = z.object({ repo: repoName.optional() });
export const repoChecksQueueBody = z.strictObject({ repo: repoName });
export const repoChecksDismissBody = z.strictObject({ repo: repoName, dismissed: z.boolean() });
export const repoChecksRefreshBody = z.strictObject({ repo: repoName.optional() });

/** Repositories with no checks' part of the API reference (src/http/openapi.ts). */
export const REPO_CHECKS_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/repo-checks', tag: 'Jobs', summary: 'Repositories with no checks, and their setup', query: repoChecksQuery, description: 'Issue #677: each job repository\'s checks for pull requests. `state`: `checks` when its default branch requires a status check (branch protection or a ruleset), a workflow file runs on pull requests, or one of its 5 newest pull requests had checks; `no checks` with none of the three; `unknown` when GitHub could not be read (`error` says why) or was not read yet. `found` what was found, `checkedAt` when, its `yolo` mode, `dismissed`. With no checks and not dismissed, `recommendation`: the job "Add PR checks to <repo>", and `queued` its open issue when one is there. Read with the person\'s own GitHub connection, never at read time (issue #1250): the list answers what the database holds, `reading` while a read is under way; Refresh reads GitHub in the background, and so does the schedule, each repository 30 minutes after its last read (after a failure 1 minute, doubled with each failure in a row, at most 30). Each read is conditional: an answer GitHub says is unchanged (304) costs no call. Issue #652: `setup`, the repository setup — each guarded branch (the default branch and each release branch it has) needs a pull request and a status check and takes no force push, and secret scanning and push protection are on: `state` `set up`, `not set up` (`problems`, in words) or `unknown` (`unread`: what GitHub did not show, as it shows branch protection and the security settings only to a repository admin; or not read); `found.setup` what was read. `?repo=owner/name` answers that one repository, read now (404: no job repository). `hopper repo checks <repo>` does the same.', returns: '`RepoChecksView`, or `RepoChecks` with `repo`', errors: [404] },
  { method: 'post', path: '/ui/api/repo-checks/queue', tag: 'Jobs', summary: 'Queue the Add PR checks job', description: 'Issue #677: files "Add PR checks to <repo>" for a job repository with no checks, through the person\'s own GitHub connection: an issue with the hopper label, assigned to their connected account, so a job source takes it as any other job. The job finds the repository\'s stack and adds a workflow for the typecheck, the lint, the tests and the build on pull requests, and the required status checks where its token allows. An open issue of that title is answered instead (`kind: exists`). One `repo_checks.job_queued`. 404: no job repository; 409: it has checks, or they are not known; 503: no GitHub connection; 502: GitHub refused.', role: 'operator', body: repoChecksQueueBody, returns: '`{ kind: filed | exists, number, url }`', errors: [400, 404, 409, 502, 503] },
  { method: 'post', path: '/ui/api/repo-checks/refresh', tag: 'Jobs', summary: 'Read the repositories\' checks again', description: 'Issue #1250: reads each job repository\'s checks and setup from GitHub again, or only `repo`, in the background, with the person\'s own GitHub connection and conditional requests. Answers at once with the list as the database holds it, `reading` on each repository read now; a read already under way is joined, not repeated. 404: no job repository.', role: 'operator', body: repoChecksRefreshBody, returns: '`RepoChecksView`', errors: [400, 404] },
  { method: 'post', path: '/ui/api/repo-checks/dismiss', tag: 'Jobs', summary: 'Dismiss the Add PR checks job', description: 'Issue #677: `dismissed: true` hides the recommendation for that job repository, `false` brings it back. The "no checks" warning stays. Kept in the user\'s settings; one `repo_checks.dismissed` when it changes.', role: 'operator', body: repoChecksDismissBody, returns: '`RepoChecks`', errors: [400, 404] },
];

/** `fn`'s answer; a refusal as the HTTP error it names. */
const answer = async <T>(fn: () => T | Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof RepoChecksRefused) throw new HttpError(e.status, e.message);
    throw e;
  }
};

export function registerRepoChecksRoutes(app: FastifyInstance, o: { operator: Guard; tenant: (req: FastifyRequest) => TenantParts }): void {
  const service = (req: FastifyRequest) => o.tenant(req).githubProxy.repoChecks;
  app.get('/api/repo-checks', async (req) => {
    const { repo } = parseWith(repoChecksQuery, req.query);
    return answer<unknown>(() => (repo === undefined ? service(req).list() : service(req).one(repo)));
  });
  app.post('/ui/api/repo-checks/queue', o.operator, async (req) => {
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to queue a job');
    const { repo } = parseWith(repoChecksQueueBody, req.body);
    return answer(() => service(req).queue(repo, identityName(s.identity)));
  });
  app.post('/ui/api/repo-checks/refresh', o.operator, async (req) => {
    const { repo } = parseWith(repoChecksRefreshBody, req.body);
    return answer(() => service(req).refresh(repo).view);
  });
  app.post('/ui/api/repo-checks/dismiss', o.operator, async (req) => {
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to dismiss a recommendation');
    const { repo, dismissed } = parseWith(repoChecksDismissBody, req.body);
    return answer(() => service(req).dismiss(repo, dismissed, identityName(s.identity)));
  });
}
