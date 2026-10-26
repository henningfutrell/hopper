// Report a bug (issue #694, design.md "Report a bug"): the form's context — the operating system and the hopper's
// version only (issue #2818) —, masked, with the public warning; the report as it would be posted, for the person to read
// before sending (issue #2818); and the report filed on the hopper's own repository through the person's own GitHub
// connection — or the similar open reports offered first, a comment on one, or a new one anyway. Kept to send later when
// GitHub cannot take it now. Nothing is posted while the user's public bug reports are off (issue #2818, the default; an
// admin turns them on). Your reports: each report filed or kept, a job's report waiting for a person's approval with its
// text, Approve and Discard, and a refresh that sends the kept ones and reads the filed ones' states.
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { arch, hostname, release } from 'node:os';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { BugReportRefused, commitCandidates, createBugReports, MAX_REPORT_DESCRIPTION, MAX_REPORT_TITLE, PUBLIC_REPORT_WARNING, REPORT_REPO, type BugReports, type HopperOwn } from '../../bug-reports/index.ts';
import type { BugReport } from '../../domain/bug-reports.ts';
import { RESEND_KEY } from '../../domain/post-key.ts';
import type { Operation } from '../openapi-operation.ts';
import { HttpError, parseWith } from '../errors.ts';
import { signedInOf, type TenantParts } from '../tenants.ts';
import { personOf } from './sessions.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

const jobId = z.string().min(1).max(200);
export const bugReportContextBody = z.strictObject({});
/** A report's text (issue #2818): a short title and a short, generic description. */
export const bugReportText = {
  title: z.string().trim().min(1, 'give the report a title').max(MAX_REPORT_TITLE, `a title of at most ${MAX_REPORT_TITLE} characters`),
  description: z.string().trim().min(1, 'describe the bug').max(MAX_REPORT_DESCRIPTION, `a description of at most ${MAX_REPORT_DESCRIPTION} characters`),
};
export const bugReportPreviewBody = z.strictObject(bugReportText);
export const bugReportIdBody = z.strictObject({ id: z.string().min(1).max(200) });
export const publicBugReportsBody = z.strictObject({ on: z.boolean() });
export const bugReportBody = z.strictObject({
  ...bugReportText,
  jobId: jobId.optional(),
  commentOn: z.number().int().min(1).optional(),
  force: z.boolean().optional(),
  key: z.string().regex(RESEND_KEY, 'a resend key: 8 to 64 letters, digits, _ or -').optional(),
});

/** Report a bug's part of the API reference (src/http/openapi.ts). */
export const BUG_REPORT_OPERATIONS: Operation[] = [
  { method: 'post', path: '/ui/api/bug-reports/context', tag: 'Bug reports', summary: 'The context of a bug report', description: 'Issue #694: what every report carries, read-only — the operating system (platform, release, architecture) and the hopper\'s version, nothing else (issue #2818). Masked: the host name, IP addresses and private host names. `repo` is where a report goes; `warning` is the public warning the form shows; `on`: whether the user\'s public bug reports are on. Changes nothing.', role: 'operator', body: bugReportContextBody, returns: '`{ context, repo, warning, on }`' },
  { method: 'post', path: '/ui/api/bug-reports/preview', tag: 'Bug reports', summary: 'Preview a bug report', description: 'Issue #2818: the report as POST /ui/api/bug-reports would post it, for the person to read before sending: the `title` and the `body` — the fixed template (Description, then System: the OS and the hopper\'s version) —, scrubbed of email addresses, links off the hopper\'s repository, absolute file paths, host names and long ids, and masked; `removed`: the kinds removed. Changes nothing.', role: 'operator', body: bugReportPreviewBody, returns: '`{ title, body, removed, warning }`' },
  { method: 'get', path: '/api/bug-reports', tag: 'Bug reports', summary: 'Your reports', description: 'Issue #694: each bug report the user filed with Report a bug, or that one of their jobs filed, newest first (at most 200): its `title`, `state` (`approval`: a job\'s report kept until a person approves it, issue #2818, with its `body`; `sending`: on its way to GitHub now, issue #1591; `waiting`: kept, not on GitHub yet, with the `problem` of the last try; `open` or `closed`: the issue on GitHub as last read, at `checkedAt`), `kind` (`issue`, or `comment` on the open report `number`), `number` and `url` once on GitHub, `by`, `jobId` and `fromJob`; `removed`: the kinds the scrub removed before it was kept (issues #2812, #2818). Never the text of any other report. `publicReports`: whether the user\'s public bug reports are on (issue #2818). Not cached.', returns: '`{ reports: BugReportView[], publicReports }`' },
  { method: 'post', path: '/ui/api/bug-reports/settings', tag: 'Bug reports', summary: 'Turn public bug reports on or off', description: 'Issue #2818: whether this user\'s bug reports — a person\'s and their jobs\' — may be posted on the hopper\'s public tracker. Off by default: until an admin turns it on, Report a bug, a job\'s `hopper-gh report bug` and Approve are refused (409), and the kept reports are not sent.', role: 'admin', body: publicBugReportsBody, returns: '`{ publicReports }`' },
  { method: 'post', path: '/ui/api/bug-reports/approve', tag: 'Bug reports', summary: 'Approve a job\'s bug report', description: 'Issue #2818: a job\'s report waits (`approval`) until a person reads it and approves it. Approve sends it as the person\'s own report is sent — a new issue, or the comment on the open report the job named —, or keeps it to send later; 409 while public bug reports are off or when it waits no more, 404 when there is none.', role: 'operator', body: bugReportIdBody, returns: 'as POST /ui/api/bug-reports', errors: [404, 409, 502] },
  { method: 'post', path: '/ui/api/bug-reports/discard', tag: 'Bug reports', summary: 'Discard a job\'s bug report', description: 'Issue #2818: a job\'s report that waits for approval is removed, and never sent. 409 when it waits no more, 404 when there is none.', role: 'operator', body: bugReportIdBody, returns: '`{ ok: true }`', errors: [404, 409] },
  { method: 'post', path: '/ui/api/bug-reports/refresh', tag: 'Bug reports', summary: 'Refresh your reports', description: 'Issue #694: sends the kept reports now — with the person\'s own GitHub connection, as when they were filed — and reads the state of each filed report on GitHub; the hopper also does this every 10 minutes. One `bug_report.filed` (`later: true`) per report sent. Answers the reports after, as GET /api/bug-reports.', role: 'operator', body: z.strictObject({}), returns: '`{ reports: BugReportView[], publicReports }`' },
  { method: 'post', path: '/ui/api/bug-reports', tag: 'Bug reports', summary: 'File a bug report', description: 'Issue #694: refused (409) while the user\'s public bug reports are off (issue #2818). Files the report — the fixed template (issue #2818): `title` (at most 120 characters), `description` (at most 2000), and the hopper\'s context, scrubbed and masked as POST /ui/api/bug-reports/preview shows it — on the hopper\'s own repository through the person\'s own GitHub connection, so it is filed as that person, with the label `user-report` — no `hopper` label and no assignee, so it never starts a job. First the open `user-report` issues with a similar title are searched: when there are some, nothing is filed and they are answered (`kind: similar`). `commentOn` adds the report as a comment on one of them (`kind: commented`); `force` files a new one anyway (`kind: filed`). One `bug_report.filed`, or `bug_report.failed` with the reason (502: GitHub refused it). With no GitHub connection, or GitHub out of reach, refusing access to the repository (the app not installed there), rate-limited or failing, the report is kept (`kind: kept`, its `id` and the `problem`; `bug_report.kept`) and the hopper sends it later, as filed now (Your reports, GET /api/bug-reports). `key` (issue #2813): the resend key the form made for this report, 8 to 64 letters, digits, `_` or `-`; the same key sent again is answered what the first made — `filed` or `commented` with its issue, or `kept` while it is on its way or kept — and nothing is filed twice.', role: 'operator', body: bugReportBody, returns: '`{ kind: filed | commented, number, url }`, `{ kind: similar, similar: [{ number, title, url }] }` or `{ kind: kept, id, problem }`', errors: [404, 409, 502] },
];

/**
 * The hopper's own source tree: a job's report keeps a path or commit of it (issue #2812). Read at the first report, not at
 * import: a module that imports the routes in a browser test environment has no file URL (issue #2820).
 */
let hopperRoot: string | undefined;
const rootOfHopper = (): string => (hopperRoot ??= resolve(fileURLToPath(new URL('../../../', import.meta.url))));
const run = promisify(execFile);

/** What of a report's text is the hopper's own: a path in its tree, a commit its git knows (none without git). */
async function hopperOwn(text: string): Promise<HopperOwn> {
  const HOPPER_ROOT = rootOfHopper();
  const isCommit = (id: string): Promise<boolean> =>
    run('git', ['-C', HOPPER_ROOT, 'cat-file', '-e', `${id}^{commit}`], { timeout: 5_000 }).then(() => true, () => false);
  const ids = commitCandidates(text).slice(0, 50);
  const known = await Promise.all(ids.map(isCommit));
  return {
    isPath: (p) => {
      const at = resolve(HOPPER_ROOT, p);
      return at.startsWith(HOPPER_ROOT + sep) && existsSync(at);
    },
    commits: new Set(ids.filter((_, i) => known[i])),
  };
}

/** The hopper's version, as its package names it: what a report says it ran (issue #2818). */
let version: string | undefined;
const hopperVersion = (): string => (version ??= (JSON.parse(readFileSync(resolve(rootOfHopper(), 'package.json'), 'utf8')) as { version: string }).version);

/** One person's reports, over their parts. */
export function bugReportsOf(t: TenantParts, log: (line: string) => void): BugReports {
  return createBugReports({
    github: () => t.githubProxy.reports(),
    job: (id) => t.store.jobs.get(id),
    system: () => ({ platform: process.platform, release: release(), arch: arch(), version: hopperVersion(), hostname: hostname() }),
    record: (e) => { t.store.events.append(e); },
    log,
    reports: t.store.bugReports,
    now: () => new Date().toISOString(),
    enabled: () => t.store.settings.getPublicBugReports(),
    jobEvents: (id) => t.store.events.recent(1000, undefined, id),
    hopperOwn,
  });
}

/** A report as Your reports shows it: its text only while it waits for a person's approval (issue #2818). */
export type BugReportView = BugReport;
const viewOf = (t: TenantParts, reports: BugReport[]): { reports: BugReportView[]; publicReports: boolean } => ({
  reports: reports.map(({ body, ...r }) => (r.state === 'approval' && body !== undefined ? { ...r, body } : r)),
  publicReports: t.store.settings.getPublicBugReports(),
});

/** Your reports' read (issue #694), beside the other `/api/` reads. */
export function bugReportReadRoutes(app: FastifyInstance, o: { tenant: (req: FastifyRequest) => TenantParts }): void {
  app.get('/api/bug-reports', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const t = o.tenant(req);
    return viewOf(t, t.store.bugReports.list());
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

export function registerBugReportRoutes(app: FastifyInstance, o: { operator: Guard; admin: Guard; tenant: (req: FastifyRequest) => TenantParts }): void {
  const reports = (req: FastifyRequest) => bugReportsOf(o.tenant(req), (line) => req.log.warn(line));
  app.post('/ui/api/bug-reports/context', o.operator, async (req) => {
    parseWith(bugReportContextBody, req.body ?? {});
    return { context: reports(req).context(), repo: REPORT_REPO, warning: PUBLIC_REPORT_WARNING, on: o.tenant(req).store.settings.getPublicBugReports() };
  });
  app.post('/ui/api/bug-reports/preview', o.operator, async (req) => {
    const draft = parseWith(bugReportPreviewBody, req.body);
    return { ...await reports(req).preview(draft), warning: PUBLIC_REPORT_WARNING };
  });
  app.post('/ui/api/bug-reports/settings', o.admin, async (req) => {
    const { on } = parseWith(publicBugReportsBody, req.body);
    o.tenant(req).store.settings.setPublicBugReports(on);
    return { publicReports: on };
  });
  app.post('/ui/api/bug-reports/approve', o.operator, async (req) => {
    const { id } = parseWith(bugReportIdBody, req.body);
    return answer(() => reports(req).approve(id));
  });
  app.post('/ui/api/bug-reports/discard', o.operator, async (req) => {
    const { id } = parseWith(bugReportIdBody, req.body);
    await answer(() => reports(req).discard(id));
    return { ok: true };
  });
  app.post('/ui/api/bug-reports', o.operator, async (req) => {
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to report a bug');
    const draft = parseWith(bugReportBody, req.body);
    return answer(() => reports(req).file(draft, personOf(s)));
  });
  app.post('/ui/api/bug-reports/refresh', o.operator, async (req) => {
    parseWith(z.strictObject({}), req.body ?? {});
    const t = o.tenant(req);
    return viewOf(t, await t.githubProxy.bugReports.refresh());
  });
}
