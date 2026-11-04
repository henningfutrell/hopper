// Head branch deletion (issue #2914, design.md "Head branch deletion"): whether the hopper deletes a pull request's head branch
// after its merge, and sweeps stale ones. On by default, per repository; an admin's; read at each deletion, so a change applies
// without a restart. Recorded as `head_branches.changed`.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { everyJobRepository } from '../../domain/job-repositories.ts';
import { DEFAULT_HEAD_BRANCHES, patchHeadBranches, type HeadBranchSettings, type HeadBranchView } from '../../domain/head-branches.ts';
import type { Operation } from '../openapi-operation.ts';
import { HttpError, parseWith } from '../errors.ts';
import { signedInOf, type TenantParts } from '../tenants.ts';
import { personOf } from './sessions.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

const repoName = z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'owner/repo').max(200);
/** Each repository named set on or off, or `null` to be on by default again. */
export const headBranchesBody = z.strictObject({ repos: z.record(repoName, z.boolean().nullable()) });

const settingsOf = (t: Pick<TenantParts, 'store'>): HeadBranchSettings => t.store.settings.getHeadBranches() ?? DEFAULT_HEAD_BRANCHES;
const viewOf = (t: Pick<TenantParts, 'store'>): HeadBranchView => ({ ...settingsOf(t), choices: { repos: everyJobRepository(t.store) } });

export const HEAD_BRANCH_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/head-branches', tag: 'Jobs', summary: 'Head branch deletion', description: 'Issue #2914: per repository, whether the hopper deletes a pull request\'s head branch after its merge and sweeps stale ones. A repository not named is on. `choices.repos`: the job repositories.', returns: '`{ repos, choices: { repos } }`' },
  { method: 'post', path: '/ui/api/head-branches', tag: 'Jobs', summary: 'Change head branch deletion', description: 'Issue #2914: `repos` sets each named repository on or off, or `null` to be on by default again. Recorded as `head_branches.changed` when it changes. Applies at the next deletion, without a restart.', role: 'admin', body: headBranchesBody, returns: '`{ repos, choices: { repos } }`', errors: [400] },
];

export function registerHeadBranchRoutes(app: FastifyInstance, o: { admin: Guard; tenant: (req: FastifyRequest) => TenantParts }): void {
  app.get('/api/head-branches', async (req) => viewOf(o.tenant(req)));
  app.post('/ui/api/head-branches', o.admin, async (req) => {
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to change head branch deletion');
    const t = o.tenant(req);
    const patch = parseWith(headBranchesBody, req.body);
    t.store.tx(() => {
      const from = settingsOf(t);
      const to = patchHeadBranches(from, patch);
      if (JSON.stringify(from.repos) === JSON.stringify(to.repos)) return;
      t.store.settings.setHeadBranches(to);
      t.store.events.append({ type: 'head_branches.changed', data: { from, to, by: personOf(s) } });
    });
    return viewOf(t);
  });
}
