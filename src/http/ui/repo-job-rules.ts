// Settings → Job rules, per repository (issue #1472, design.md "Repository job rules"): what every job of one repository
// (`owner/name`), or of every repository of an owner (`owner/*`), is told after the job rules — the config record
// `repo-job-rules`, replaced whole against the version read. Read when each job starts, so an edit reaches the next job.
// Least role to change: admin.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { RepoJobRulesView } from '../../domain/types.ts';
import { repoJobRulesView, writeRepoJobRules } from '../../job-rules/repo-rules.ts';
import type { Operation } from '../openapi-operation.ts';
import { HttpError, parseWith } from '../errors.ts';
import type { TenantParts } from '../tenants.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

// The names and texts are checked by repoJobRulesProblem when they are written.
export const repoJobRulesBody = z.strictObject({ repos: z.record(z.string(), z.string()), version: z.string().min(1) });

export const REPO_JOB_RULES_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/repo-job-rules', tag: 'Jobs', summary: 'The repository job rules', description: 'Issue #1472: what every job of a repository (`owner/name`), or of every repository of an owner (`owner/*`), is told after the job rules, sorted by name; and the record\'s `version`.', returns: '`RepoJobRulesView`' },
  { method: 'post', path: '/ui/api/repo-job-rules', tag: 'Jobs', summary: 'Replace the repository job rules', description: 'Issue #1472. `repos` maps `owner/name` or `owner/*` to a text, at most 16 KiB each and 100 in all, against the `version` read from GET /api/repo-job-rules. The next job of the repository gets them.', role: 'admin', body: repoJobRulesBody, returns: 'the new `RepoJobRulesView`', errors: [400, 409] },
];

const STATUS = { invalid: 400, conflict: 409 } as const;

export function registerRepoJobRulesRoutes(app: FastifyInstance, o: { admin: Guard; tenant: (req: FastifyRequest) => TenantParts }): void {
  app.get('/api/repo-job-rules', async (req): Promise<RepoJobRulesView> => repoJobRulesView(o.tenant(req).store.config));
  app.post('/ui/api/repo-job-rules', o.admin, async (req) => {
    const { repos, version } = parseWith(repoJobRulesBody, req.body);
    const r = writeRepoJobRules(o.tenant(req).store.config, repos, version);
    if (!r.ok) throw new HttpError(STATUS[r.code], r.error);
    return r.view;
  });
}
