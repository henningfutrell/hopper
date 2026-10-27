// The job egress allowlist (issue #2849, design.md "A job's egress allowlist"): the hosts the user's running jobs may connect
// out to through the hopper (`GET /job/egress`): the hopper's default hosts, unless turned off, the user's own hosts, and
// each repository's. Kept in the database, never in a file. Least role to change: admin.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { JOB_EGRESS_DEFAULTS, jobEgressHostProblem, normalJobEgress, type JobEgressSettings } from '../../domain/job-egress.ts';
import type { Operation } from '../openapi-operation.ts';
import { HttpError, parseWith } from '../errors.ts';
import { signedInOf, type TenantParts } from '../tenants.ts';
import { personOf } from './sessions.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

const entry = z.string().max(260).superRefine((h, ctx) => {
  const problem = jobEgressHostProblem(h);
  if (problem) ctx.addIssue({ code: 'custom', message: problem });
});
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export const jobEgressBody = z.strictObject({
  defaults: z.boolean(),
  hosts: z.array(entry).max(200),
  repos: z.record(z.string().regex(REPO, 'a repository is owner/name'), z.array(entry).max(200)).refine((r) => Object.keys(r).length <= 500, 'at most 500 repositories'),
});

const VIEW = '`egress`: `defaults` (whether the hopper\'s default hosts are on the allowlist), `hosts` (every job\'s) and `repos` (`owner/name` → the hosts of that repository\'s jobs); `defaultHosts`: the hopper\'s default hosts — the model providers, GitHub and the package registries. An entry is `host:port`, or `*.domain:port` for the names under a domain.';

export const JOB_EGRESS_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/job-egress', tag: 'Vault', summary: 'The job egress allowlist', description: `Issue #2849: the hosts a running job may connect out to through the hopper (\`GET /job/egress\`, with its proxy token). A job of a repository gets the defaults (when on), the user's hosts and that repository's hosts. ${VIEW}`, returns: '`{ egress, defaultHosts }`' },
  { method: 'post', path: '/ui/api/job-egress', tag: 'Vault', summary: 'Set the job egress allowlist', description: `Issue #2849: the whole setting, entries and repositories kept in lowercase. 400 names the first entry that is not \`host:port\` or \`*.domain:port\`. Recorded as \`job_egress.changed\`. It applies to each connection a job makes from then on. ${VIEW}`, role: 'admin', body: jobEgressBody, returns: '`{ egress }`', errors: [400] },
];

export function registerJobEgressRoutes(app: FastifyInstance, o: { admin: Guard; tenant: (req: FastifyRequest) => TenantParts }): void {
  app.get('/api/job-egress', async (req) => ({ egress: o.tenant(req).store.settings.getJobEgress(), defaultHosts: JOB_EGRESS_DEFAULTS }));
  app.post('/ui/api/job-egress', o.admin, async (req) => {
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to change the job egress allowlist');
    const t = o.tenant(req);
    const egress: JobEgressSettings = normalJobEgress(parseWith(jobEgressBody, req.body));
    t.store.tx(() => {
      t.store.settings.setJobEgress(egress);
      t.store.events.append({ type: 'job_egress.changed', data: { by: personOf(s), defaults: egress.defaults, hosts: egress.hosts.length, repos: Object.keys(egress.repos).length } });
    });
    return { egress };
  });
}
