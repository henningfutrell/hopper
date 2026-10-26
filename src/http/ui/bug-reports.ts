// Report a bug (issue #694, design.md "Report a bug"): the form's context — the System line only (issue #2478) —, masked,
// for the person to read and edit, and
// the report filed on the hopper's own repository through the person's own GitHub connection — or the similar open
// reports offered first, a comment on one, or a new one anyway. Kept to send later when GitHub cannot take it now. Your
// reports: each report filed or kept, and a refresh that sends the kept ones and reads the filed ones' states.
import { arch, hostname, release } from 'node:os';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { BugReportRefused, createBugReports, REPORT_REPO, type BugReports } from '../../bug-reports/index.ts';
import type { BugReport } from '../../domain/bug-reports.ts';
import { RESEND_KEY } from '../../domain/post-key.ts';
import type { Operation } from '../openapi-operation.ts';
import { HttpError, parseWith } from '../errors.ts';
import { signedInOf, type TenantParts } from '../tenants.ts';
import { personOf } from './sessions.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

const jobId = z.string().min(1).max(200);
export const bugReportContextBody = z.strictObject({});
export const bugReportBody = z.strictObject({
  title: z.string().trim().min(1, 'give the report a title').max(200),
  happened: z.string().trim().min(1, 'say what happened').max(10_000),
  expected: z.string().max(10_000).default(''),
  context: z.string().max(20_000).default(''),
  jobId: jobId.optional(),
  commentOn: z.number().int().min(1).optional(),
  force: z.boolean().optional(),
  key: z.string().regex(RESEND_KEY, 'a resend key: 8 to 64 letters, digits, _ or -').optional(),
});

/** Report a bug's part of the API reference (src/http/openapi.ts). */
export const BUG_REPORT_OPERATIONS: Operation[] = [
  { method: 'post', path: '/ui/api/bug-reports/context', tag: 'Bug reports', summary: 'The context of a bug report', description: 'Issue #694: what the Report a bug form fills in, for the person to read and edit before sending — the System line only (issue #2478): the platform, its release, the architecture and the Node version. Never the hopper\'s version, its install type or a job. Masked: the host name, IP addresses and private host names. `repo` is where a report goes. Changes nothing.', role: 'operator', body: bugReportContextBody, returns: '`{ context, repo }`' },
  { method: 'get', path: '/api/bug-reports', tag: 'Bug reports', summary: 'Your reports', description: 'Issue #694: each bug report the user filed with Report a bug, or that one of their jobs filed, newest first (at most 200): its `title`, `state` (`sending`: on its way to GitHub now, issue #1591; `waiting`: kept, not on GitHub yet, with the `problem` of the last try; `open` or `closed`: the issue on GitHub as last read, at `checkedAt`), `kind` (`issue`, or `comment` on the open report `number`), `number` and `url` once on GitHub, `by`, `jobId` and `fromJob`. Never its text. Not cached.', returns: '`{ reports: BugReportView[] }`' },
  { method: 'post', path: '/ui/api/bug-reports/refresh', tag: 'Bug reports', summary: 'Refresh your reports', description: 'Issue #694: sends the kept reports now — with the person\'s own GitHub connection, as when they were filed — and reads the state of each filed report on GitHub; the hopper also does this every 10 minutes. One `bug_report.filed` (`later: true`) per report sent. Answers the reports after, as GET /api/bug-reports.', role: 'operator', body: z.strictObject({}), returns: '`{ reports: BugReportView[] }`' },
  { method: 'post', path: '/ui/api/bug-reports', tag: 'Bug reports', summary: 'File a bug report', description: 'Issue #694: files the report on the hopper\'s own repository through the person\'s own GitHub connection, so it is filed as that person, with the label `user-report` — no `hopper` label and no assignee, so it never starts a job. First the open `user-report` issues with a similar title are searched: when there are some, nothing is filed and they are answered (`kind: similar`). `commentOn` adds the report as a comment on one of them (`kind: commented`); `force` files a new one anyway (`kind: filed`). GitHub tokens and keys are always masked; the rest is as the person sent it. One `bug_report.filed`, or `bug_report.failed` with the reason (502: GitHub refused it). With no GitHub connection, or GitHub out of reach, refusing access to the repository (the app not installed there), rate-limited or failing, the report is kept (`kind: kept`, its `id` and the `problem`; `bug_report.kept`) and the hopper sends it later, as filed now (Your reports, GET /api/bug-reports). `key` (issue #2813): the resend key the form made for this report, 8 to 64 letters, digits, `_` or `-`; the same key sent again is answered what the first made — `filed` or `commented` with its issue, or `kept` while it is on its way or kept — and nothing is filed twice.', role: 'operator', body: bugReportBody, returns: '`{ kind: filed | commented, number, url }`, `{ kind: similar, similar: [{ number, title, url }] }` or `{ kind: kept, id, problem }`', errors: [404, 502] },
];

/** One person's reports, over their parts. */
export function bugReportsOf(t: TenantParts, log: (line: string) => void): BugReports {
  return createBugReports({
    github: () => t.githubProxy.reports(),
    job: (id) => t.store.jobs.get(id),
    system: () => ({ platform: process.platform, release: release(), arch: arch(), node: process.version, hostname: hostname() }),
    record: (e) => { t.store.events.append(e); },
    log,
    reports: t.store.bugReports,
    now: () => new Date().toISOString(),
  });
}

/** A report as Your reports shows it: never its text. */
export type BugReportView = Omit<BugReport, 'body'>;
const viewOf = (reports: BugReport[]): { reports: BugReportView[] } => ({ reports: reports.map(({ body: _, ...r }) => r) });

/** Your reports' read (issue #694), beside the other `/api/` reads. */
export function bugReportReadRoutes(app: FastifyInstance, o: { tenant: (req: FastifyRequest) => TenantParts }): void {
  app.get('/api/bug-reports', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    return viewOf(o.tenant(req).store.bugReports.list());
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

export function registerBugReportRoutes(app: FastifyInstance, o: { operator: Guard; tenant: (req: FastifyRequest) => TenantParts }): void {
  const reports = (req: FastifyRequest) => bugReportsOf(o.tenant(req), (line) => req.log.warn(line));
  app.post('/ui/api/bug-reports/context', o.operator, async (req) => {
    parseWith(bugReportContextBody, req.body ?? {});
    return { context: reports(req).context(), repo: REPORT_REPO };
  });
  app.post('/ui/api/bug-reports', o.operator, async (req) => {
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to report a bug');
    const draft = parseWith(bugReportBody, req.body);
    return answer(() => reports(req).file(draft, personOf(s)));
  });
  app.post('/ui/api/bug-reports/refresh', o.operator, async (req) => {
    parseWith(z.strictObject({}), req.body ?? {});
    return viewOf(await o.tenant(req).githubProxy.bugReports.refresh());
  });
}
