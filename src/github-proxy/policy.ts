// What a job may ask the hopper to do on GitHub (issue #563, design.md "GitHub through the hopper"): the
// operations, the request's shape, and the check against who asks. Pure: no I/O, no clock.
//
// The hopper acts with its own GitHub connection — its oldest user's, the one that set it up — so who asks
// decides what it does with it:
// - a job of that same user (**its own job**) may file and read issues, comment, open a pull request from
//   its pushed branch on its own repository, mark one ready for review there, close its own issue as completed
//   (issue #652: it holds no GitHub token of its own), and read pull requests, on the hopper's job repositories;
// - a job of any other user (**another user's job**, treated as untrusted) may only file an issue there.
// Nothing a job asks for carries labels or assignees: a filed issue never becomes a job by itself.
// An issue a job files is a child of the job's own issue (issue #729, issue lineage): a follow-up, or — `required`, only
// for the hopper's own job — a required child, linked as a GitHub sub-issue, so the parent is not done while it is open.
import { z } from 'zod';

export const PROXY_OPS = ['issue.create', 'issue.comment', 'issue.view', 'issue.close', 'pr.create', 'pr.view', 'pr.ready'] as const;
export type ProxyOp = (typeof PROXY_OPS)[number];

const repo = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'repo must be owner/name');
const number = z.coerce.number().int().positive();
const text = (max: number) => z.string().min(1).max(max);
const branch = z.string().regex(/^[A-Za-z0-9._/-]{1,200}$/, 'a branch name: letters, digits, . _ / -');
/** A flag: from a form it comes as the text `true`. */
const flag = z.union([z.literal('true'), z.literal(true)]).transform(() => true as const);

/** One request, as the hopper takes it: the operation and only the fields it uses. GitHub's limits on titles and bodies. */
export const proxyRequest = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('issue.create'), repo, title: text(256), body: text(60_000), required: flag.optional() }),
  z.strictObject({ op: z.literal('issue.comment'), repo, number, body: text(60_000) }),
  z.strictObject({ op: z.literal('issue.view'), repo, number }),
  z.strictObject({ op: z.literal('issue.close'), repo, number }),
  z.strictObject({ op: z.literal('pr.create'), repo, head: branch, base: branch.optional(), title: text(256), body: text(60_000) }),
  z.strictObject({ op: z.literal('pr.view'), repo, number }),
  z.strictObject({ op: z.literal('pr.ready'), repo, number }),
]);
export type ProxyRequest = z.infer<typeof proxyRequest>;

/**
 * A job's bug report on the hopper itself (issue #694, design.md "Report a bug"): not an act of the hopper's connection
 * but of the job's own user's, by Report a bug's own path; so it has no repository of its own to check — it always goes
 * to the hopper's. `commentOn` adds it to a similar open report; `force` files it even with one.
 */
export const REPORT_OP = 'report.bug';
export const reportRequest = z.strictObject({
  op: z.literal(REPORT_OP), title: text(200), body: text(10_000), commentOn: number.optional(),
  force: flag.optional(),
});
export type ReportRequest = z.infer<typeof reportRequest>;

/** Who asks: the job, whether it is the hopper's own user's, and the repository it came from. */
export interface ProxyAsker {
  jobId: string;
  /** A job of the user whose GitHub connection the hopper acts with. */
  own: boolean;
  /** The job's own repository (its source's, or its parent's for a fork); absent: none. */
  repo?: string;
  /** The number of the job's own issue in that repository; absent: none. */
  issue?: number;
}

/** What a job of another user may ask: filing an issue. Everything else reads or writes as the hopper's user. */
const OTHERS_MAY: readonly ProxyOp[] = ['issue.create'];

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** Whether the asker may have the request done; else why not, in words the job can act on. */
export function checkRequest(req: ProxyRequest, asker: ProxyAsker, jobRepositories: readonly string[]): { ok: true } | { ok: false; reason: string } {
  if (!asker.own && !OTHERS_MAY.includes(req.op)) {
    return { ok: false, reason: `a job of another user may only file an issue through the hopper (issue.create), not ${req.op}` };
  }
  if (!jobRepositories.some((r) => same(r, req.repo))) {
    return { ok: false, reason: `${req.repo} is not one of the repositories the hopper works on, so it does nothing there for a job` };
  }
  const ownRepo = asker.repo !== undefined && same(asker.repo, req.repo);
  if (req.op === 'pr.create' && !ownRepo) {
    return { ok: false, reason: `a job opens a pull request only on its own repository${asker.repo ? ` (${asker.repo})` : ', and this job has none'}` };
  }
  if (req.op === 'pr.ready' && !ownRepo) {
    return { ok: false, reason: `a job marks a pull request ready only on its own repository${asker.repo ? ` (${asker.repo})` : ', and this job has none'}` };
  }
  if (req.op === 'issue.create' && req.required && !asker.own) {
    return { ok: false, reason: 'a job of another user files no required child: file it with no --required' };
  }
  if (req.op === 'issue.create' && req.required && (asker.repo === undefined || asker.issue === undefined)) {
    return { ok: false, reason: 'a required child is a child of the job\'s own issue, and this job has none: file it with no --required' };
  }
  if (req.op === 'issue.close' && !(ownRepo && asker.issue === req.number)) {
    return { ok: false, reason: `a job closes only its own issue${asker.repo && asker.issue !== undefined ? ` (${asker.repo}#${asker.issue})` : ', and this job has none'}` };
  }
  return { ok: true };
}

/** The job's issue a filed issue is a child of (issue #729), and whether the job marked it required. */
export interface IssueParent { repo: string; number: number; required: boolean }

/**
 * What every issue filed through the hopper carries at its end: its parent, the job's issue (issue #729: GitHub links
 * the mention back on the parent), that the hopper filed it for a job, which one, and that it waits for a person. Ids
 * only — GitHub text names no person and no machine (repo law); the hopper's event log has who asked and from where,
 * under the request id.
 */
export function filedNote(jobId: string, requestId: string, parent?: IssueParent): string {
  const ref = parent && `${parent.repo}#${parent.number}`;
  const lineage = !parent ? '' : parent.required ? `Required child of ${ref}: that issue is not done while this one is open.\n` : `Follow-up of ${ref}.\n`;
  return `\n\n---\n${lineage}Filed through hopper for job \`${jobId}\` (request \`${requestId}\`). It is not a job: it waits for a person to triage it.`;
}
