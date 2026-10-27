// The job egress allowlist (issue #2849, design.md "A job's egress allowlist"): the hosts the user's running jobs may connect
// out to through the hopper (`GET /job/egress`): the hopper's default hosts, unless turned off, the user's own hosts, and
// each repository's. Kept in the database, never in a file. Least role to change: admin. The hosts the jobs asked for (part
// 3): each host off the allowlist a job was refused in the last week, until a person approves it (it goes on the allowlist)
// or dismisses it; read from the refusals and answers in the event log, so nothing else is kept.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { JOB_EGRESS_ASK_WINDOW_MS, JOB_EGRESS_DEFAULTS, JOB_ENV_KEPT, jobEgressAsks, jobEgressHostProblem, jobEnvNameProblem, normalJobEgress, withJobEgressHost, type JobEgressAsk, type JobEgressSettings } from '../../domain/job-egress.ts';
import type { Operation } from '../openapi-operation.ts';
import { HttpError, parseWith } from '../errors.ts';
import { signedInOf, type TenantParts } from '../tenants.ts';
import { personOf } from './sessions.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

const entry = z.string().max(260).superRefine((h, ctx) => {
  const problem = jobEgressHostProblem(h);
  if (problem) ctx.addIssue({ code: 'custom', message: problem });
});
const envName = z.string().max(128).superRefine((n, ctx) => {
  const problem = jobEnvNameProblem(n);
  if (problem) ctx.addIssue({ code: 'custom', message: problem });
});
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export const jobEgressBody = z.strictObject({
  defaults: z.boolean(),
  hosts: z.array(entry).max(200),
  repos: z.record(z.string().regex(REPO, 'a repository is owner/name'), z.array(entry).max(200)).refine((r) => Object.keys(r).length <= 500, 'at most 500 repositories'),
  route: z.boolean().default(false),
  confine: z.boolean().default(false),
  scope: z.boolean().default(false),
  keep: z.array(envName).max(200).default([]),
  repoKeep: z.record(z.string().regex(REPO, 'a repository is owner/name'), z.array(envName).max(200)).refine((r) => Object.keys(r).length <= 500, 'at most 500 repositories').default({}),
});
export const jobEgressAskBody = z.strictObject({
  host: entry.refine((h) => !h.startsWith('*.'), 'an ask is one host, not a wildcard'),
  repo: z.string().regex(REPO, 'a repository is owner/name').optional(),
  answer: z.enum(['approve', 'dismiss']),
  for: z.enum(['repo', 'all']).optional(),
}).refine((b) => !(b.answer === 'approve' && b.for === 'repo' && !b.repo), 'approve for the repository names the repository');

const VIEW = '`egress`: `defaults` (whether the hopper\'s default hosts are on the allowlist), `hosts` (every job\'s) and `repos` (`owner/name` → the hosts of that repository\'s jobs) and `route` (whether a job\'s agent runs behind `hopper-egress`, so its connections go out through the hopper to these hosts only; read at each job\'s start, off when not given) and `confine` (with `route` only: whether the job\'s sandbox also gets a network namespace of its own whose one way out is `hopper-egress`; off when not given, and off whenever `route` is off) and `scope` (part 5: whether a job\'s agent keeps only some variables of its machine\'s environment — the hopper\'s own names, what the hopper set for the job, `keep` and its repository\'s `repoKeep`; read at each job\'s start, off when not given) and `keep` (variable names every job keeps) and `repoKeep` (`owner/name` → the names of that repository\'s jobs); `defaultHosts`: the hopper\'s default hosts — the model providers, GitHub and the package registries; `keptNames`: the names a scoped job always keeps beside its setting\'s, what the hopper set for it and the names that start with `LC_` or `HERDR_`; `asks`: the hosts off the allowlist the jobs were refused in the last week, that no person answered since, newest first — `host` (`host:port`), `repo`, `jobIds`, `at` (the newest refusal). An entry is `host:port`, or `*.domain:port` for the names under a domain.';

export const JOB_EGRESS_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/job-egress', tag: 'Vault', summary: 'The job egress allowlist', description: `Issue #2849: the hosts a running job may connect out to through the hopper (\`GET /job/egress\`, with its proxy token). A job of a repository gets the defaults (when on), the user's hosts and that repository's hosts. ${VIEW}`, returns: '`{ egress, defaultHosts, keptNames, asks }`' },
  { method: 'post', path: '/ui/api/job-egress', tag: 'Vault', summary: 'Set the job egress allowlist', description: `Issue #2849: the whole setting, entries and repositories kept in lowercase. 400 names the first entry that is not \`host:port\` or \`*.domain:port\`, or the first name that is no variable name. Recorded as \`job_egress.changed\`. It applies to each connection a job makes from then on. ${VIEW}`, role: 'admin', body: jobEgressBody, returns: '`{ egress }`', errors: [400] },
  { method: 'post', path: '/ui/api/job-egress/asks', tag: 'Vault', summary: 'Answer a host the jobs asked for', description: `Issue #2849 part 3: \`answer\` \`approve\` adds \`host\` (\`host:port\`, one host, not a wildcard) to the allowlist — \`for\` \`repo\` (the default when \`repo\` is given), for the jobs of \`repo\`, or \`all\`, for every job —, so a job's next try goes through; \`dismiss\` leaves it off, and it asks again only when a job is refused after this. Recorded as \`job_egress.ask_answered\`. ${VIEW}`, role: 'admin', body: jobEgressAskBody, returns: '`{ egress, defaultHosts, keptNames, asks }`', errors: [400] },
];

async function viewOf(t: TenantParts, now: number): Promise<{ egress: JobEgressSettings; defaultHosts: readonly string[]; keptNames: readonly string[]; asks: JobEgressAsk[] }> {
  const events = await t.store.reads.eventsBetween(['job.egress_denied', 'job_egress.ask_answered'], new Date(now - JOB_EGRESS_ASK_WINDOW_MS).toISOString());
  const egress = t.store.settings.getJobEgress();
  return { egress, defaultHosts: JOB_EGRESS_DEFAULTS, keptNames: JOB_ENV_KEPT, asks: jobEgressAsks(egress, events) };
}

export function registerJobEgressRoutes(app: FastifyInstance, o: { admin: Guard; tenant: (req: FastifyRequest) => TenantParts }): void {
  app.get('/api/job-egress', async (req) => viewOf(o.tenant(req), Date.now()));
  app.post('/ui/api/job-egress', o.admin, async (req) => {
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to change the job egress allowlist');
    const t = o.tenant(req);
    const egress: JobEgressSettings = normalJobEgress(parseWith(jobEgressBody, req.body));
    t.store.tx(() => {
      t.store.settings.setJobEgress(egress);
      t.store.events.append({ type: 'job_egress.changed', data: { by: personOf(s), defaults: egress.defaults, route: egress.route, confine: egress.confine, scope: egress.scope, hosts: egress.hosts.length, repos: Object.keys(egress.repos).length, keep: egress.keep.length, repoKeep: Object.keys(egress.repoKeep).length } });
    });
    return { egress };
  });
  app.post('/ui/api/job-egress/asks', o.admin, async (req) => {
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to answer a host the jobs asked for');
    const t = o.tenant(req);
    const b = parseWith(jobEgressAskBody, req.body);
    const at = b.host.lastIndexOf(':');
    const host = b.host.slice(0, at).toLowerCase();
    const port = Number(b.host.slice(at + 1));
    const repo = b.repo?.toLowerCase();
    const scope = b.for ?? (repo ? 'repo' : 'all');
    t.store.tx(() => {
      if (b.answer === 'approve') t.store.settings.setJobEgress(withJobEgressHost(t.store.settings.getJobEgress(), b.host, scope === 'repo' ? repo : undefined));
      t.store.events.append({ type: 'job_egress.ask_answered', data: { by: personOf(s), host, port, ...(repo ? { repo } : {}), answer: b.answer === 'approve' ? 'approved' : 'dismissed', ...(b.answer === 'approve' ? { for: scope } : {}) } });
    });
    return viewOf(t, Date.now());
  });
}
