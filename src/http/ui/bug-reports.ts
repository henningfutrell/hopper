// Report a bug (issue #694, design.md "Report a bug"): the form's context, masked, for the person to read and edit, and
// the report filed on the hopper's own repository through the person's own GitHub connection — or the similar open
// reports offered first, a comment on one, or a new one anyway.
import { arch, hostname, release } from 'node:os';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { BugReportRefused, createBugReports, REPORT_REPO, type BugReports } from '../../bug-reports/index.ts';
import type { Updater } from '../../domain/ports.ts';
import type { Operation } from '../openapi-operation.ts';
import { HttpError, parseWith } from '../errors.ts';
import { signedInOf, type TenantParts } from '../tenants.ts';
import { identityName } from './sessions.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

const jobId = z.string().min(1).max(200);
export const bugReportContextBody = z.strictObject({ jobId: jobId.optional() });
export const bugReportBody = z.strictObject({
  title: z.string().trim().min(1, 'give the report a title').max(200),
  happened: z.string().trim().min(1, 'say what happened').max(10_000),
  expected: z.string().max(10_000).default(''),
  context: z.string().max(20_000).default(''),
  jobId: jobId.optional(),
  commentOn: z.number().int().min(1).optional(),
  force: z.boolean().optional(),
});

/** Report a bug's part of the API reference (src/http/openapi.ts). */
export const BUG_REPORT_OPERATIONS: Operation[] = [
  { method: 'post', path: '/ui/api/bug-reports/context', tag: 'Bug reports', summary: 'The context of a bug report', description: 'Issue #694: what the Report a bug form fills in, for the person to read and edit before sending — the hopper\'s version and revision, the install type (container or host), the system, and with `jobId` the job, its failure, its state in plain words and its last 20 log lines. Masked: GitHub tokens, keys, the host name, IP addresses, private host names and home directories. Never the job\'s item: its repository, title or text. `repo` is where a report goes. Changes nothing.', role: 'operator', body: bugReportContextBody, returns: '`{ context, repo }`', errors: [404] },
  { method: 'post', path: '/ui/api/bug-reports', tag: 'Bug reports', summary: 'File a bug report', description: 'Issue #694: files the report on the hopper\'s own repository through the person\'s own GitHub connection, so it is filed as that person, with the label `user-report` — no `hopper` label and no assignee, so it never starts a job. First the open `user-report` issues with a similar title are searched: when there are some, nothing is filed and they are answered (`kind: similar`). `commentOn` adds the report as a comment on one of them (`kind: commented`); `force` files a new one anyway (`kind: filed`). GitHub tokens and keys are always masked; the rest is as the person sent it. One `bug_report.filed`, or `bug_report.failed` with the reason (503: no GitHub connection; 502: GitHub refused).', role: 'operator', body: bugReportBody, returns: '`{ kind: filed | commented, number, url }` or `{ kind: similar, similar: [{ number, title, url }] }`', errors: [404, 502, 503] },
];

/** One person's reports, over their parts. */
export function bugReportsOf(t: TenantParts, updater: Pick<Updater, 'status'>, log: (line: string) => void): BugReports {
  return createBugReports({
    github: () => t.githubProxy.reports(),
    job: (id) => t.store.jobs.get(id),
    failureOf: (id) => { const r = t.store.failures.forJob(id); return r ? { id: r.id, signature: r.signature } : undefined; },
    install: () => updater.status().installed ?? {},
    system: () => ({ platform: process.platform, release: release(), arch: arch(), node: process.version, hostname: hostname() }),
    record: (e) => { t.store.events.append(e); },
    log,
  });
}

/** `fn`'s answer; a refusal as the HTTP error it names. */
const answer = async <T>(fn: () => T | Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof BugReportRefused) throw new HttpError(e.status, e.message);
    throw e;
  }
};

export function registerBugReportRoutes(app: FastifyInstance, o: { operator: Guard; tenant: (req: FastifyRequest) => TenantParts; updater: Pick<Updater, 'status'> }): void {
  const reports = (req: FastifyRequest) => bugReportsOf(o.tenant(req), o.updater, (line) => req.log.warn(line));
  app.post('/ui/api/bug-reports/context', o.operator, async (req) => {
    const { jobId: id } = parseWith(bugReportContextBody, req.body);
    return { context: await answer(() => reports(req).context(id)), repo: REPORT_REPO };
  });
  app.post('/ui/api/bug-reports', o.operator, async (req) => {
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to report a bug');
    const draft = parseWith(bugReportBody, req.body);
    return answer(() => reports(req).file(draft, identityName(s.identity)));
  });
}
