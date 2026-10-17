// The user's GitLab account from the UI (issue #1448 part 2, design.md "A GitLab source"): connect GitLab with a personal
// access token, at gitlab.com or at a GitLab of the user's own; pick the projects whose issues Intake lists; read the projects
// the token reaches again; remove the account. The read side, GET /api/gitlab-account, answers its status: never the token.
// The user's own account: their session's user alone, an admin's act.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { NoGitLabAccount } from '../../gitlab/account.ts';
import { isGitLabProject } from '../../domain/gitlab-account.ts';
import { HttpError, parseWith } from '../errors.ts';
import type { Operation } from '../openapi-operation.ts';
import type { TenantParts } from '../tenants.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

export const gitlabAccountBody = z.discriminatedUnion('action', [
  // Never logged, never answered.
  z.strictObject({ action: z.literal('connect'), token: z.string().trim().min(1).max(1024).regex(/^\S+$/, 'one token, no spaces'), baseUrl: z.string().trim().min(1).max(2048).optional() }),
  z.strictObject({ action: z.literal('choose'), projects: z.array(z.string().refine(isGitLabProject, 'group/name')).max(5000) }),
  z.strictObject({ action: z.enum(['refresh', 'disconnect']) }),
]);

/** Its part of the API reference (src/http/openapi.ts). */
export const GITLAB_ACCOUNT_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/gitlab-account', tag: 'Jobs', summary: 'The GitLab account you connected', description: 'Connected (the account, its GitLab URL, when, the projects picked, the projects the token reaches as last read), expired (GitLab refused its token: connect again with a new token), unreadable (its token is sealed under a master key the runtime does not give), or not connected (with why the last connect failed). Facts only, never a token.', returns: '`{ account: GitLabAccountStatus }`' },
  { method: 'post', path: '/ui/api/gitlab-account', tag: 'Jobs', summary: 'Connect GitLab, pick projects, read them again, or remove the account', description: '`connect` attaches the GitLab account a personal access token (`token`) is, at `baseUrl` (absent: https://gitlab.com; https, or http on this machine only): GitLab must take it and the source email match applies (a confirmed email of the account must be the one you signed in with); the token is kept in your vault as a system secret, never answered, never deleted at GitLab; a refusal answers `failed` with why and keeps nothing. `choose` sets the picked projects, the whole list: the open issues labelled `hopper` in each are listed in Intake; no job is taken from GitLab yet. `refresh` reads the projects the token reaches again. `disconnect` forgets the account and its token. No account (`choose`, `refresh`): 404.', role: 'admin', body: gitlabAccountBody, returns: '`{ account: GitLabAccountStatus }`', errors: [400, 404] },
];

export function registerGitLabAccountRoutes(app: FastifyInstance, o: { admin: Guard; tenant: (req: FastifyRequest) => TenantParts; email: (req: FastifyRequest) => string | undefined }): void {
  app.get('/api/gitlab-account', async (req) => ({ account: o.tenant(req).gitlabAccount.status() }));
  app.post('/ui/api/gitlab-account', o.admin, async (req) => {
    const body = parseWith(gitlabAccountBody, req.body);
    const { gitlabAccount } = o.tenant(req);
    const notFound = (e: Error) => { throw e instanceof NoGitLabAccount ? new HttpError(404, e.message) : e; };
    if (body.action === 'connect') {
      // The source email match (issue #1380): the account must have the email the session's identity signed in with.
      const email = o.email(req);
      return { account: await gitlabAccount.connect({ token: body.token, ...(body.baseUrl ? { baseUrl: body.baseUrl } : {}) }, email ? { email } : {}) };
    }
    if (body.action === 'choose') { try { return { account: gitlabAccount.choose(body.projects) }; } catch (e) { return notFound(e as Error); } }
    if (body.action === 'refresh') return { account: await gitlabAccount.refresh().catch(notFound) };
    return { account: gitlabAccount.disconnect() };
  });
}
