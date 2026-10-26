// Report a bug (issue #694, design.md "Report a bug"): one person's reports. `context` is what the form shows, masked,
// for the person to read and edit — the System line only (issue #2478); `file` searches the open reports for a similar
// title first and answers those instead of filing, unless the person names one to comment on or files anyway; then it files on
// the hopper's own repository with the person's own GitHub connection (`bug_report.filed`, `bug_report.failed`).
// `fileForJob` is a running job's report, by the same path: its text masked whole, the context added, marked as a
// job's. With no GitHub connection, or GitHub out of reach or refusing access, the report is kept (`bug_report.kept`)
// and sent later (`later.ts`); every report filed or kept is a row, for Your reports. The row is kept `sending` before
// GitHub is asked, its id the post key in the text (issue #1591): GitHub may make the report and its answer be lost, and
// the send later looks for the key first, so a report is never filed twice. A report sent with a resend key (issue #2813) is
// kept as a row of that key's id, and the same key again — a resend after a lost answer, or a second click — is answered
// what the first made, and files nothing. Never a token in an event.
import { createHash } from 'node:crypto';
import type { BugReport } from '../domain/bug-reports.ts';
import type { BugReportRepository } from '../domain/ports.ts';
import type { Job, NewEvent } from '../domain/types.ts';
import { maskReportText, REPORT_LABEL, REPORT_REPO, reportBody, reportContext, reportTitle, searchTerms, similarityOf, type ReportSystem } from './context.ts';
import { ReportGitHubError, type ReportGitHub, type SimilarReport } from './github.ts';
import { sendReport } from './later.ts';

/** A title with at least this share of the terms is offered as similar. */
export const SIMILAR_AT = 0.5;
/** The most similar reports offered. */
export const MAX_SIMILAR = 5;

export interface BugReportDraft {
  title: string;
  happened: string;
  expected: string;
  /** The context as the person left it. */
  context: string;
  jobId?: string;
  /** Add the report as a comment on this open report. */
  commentOn?: number;
  /** File it even with a similar open report. */
  force?: boolean;
  /** A running job files it (`fileForJob`), not a person. */
  fromJob?: boolean;
  /** Its resend key (issue #2813): the same key again from the same sender is answered the first report. */
  key?: string;
}

/** What a running job sends (`hopper-gh report bug`): a title and what happened, and its choice after a similar one. */
export interface JobReport { title: string; body: string; commentOn?: number; force?: boolean; key?: string }

export type BugReportAnswer =
  | { kind: 'filed' | 'commented'; number: number; url: string }
  | { kind: 'similar'; similar: SimilarReport[] }
  /** Not sent: GitHub could not take it now (`problem`); the hopper keeps it and sends it later. */
  | { kind: 'kept'; id: string; problem: string };

/** Why a report was not filed: `status` as the HTTP edge answers it. */
export class BugReportRefused extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'BugReportRefused';
    this.status = status;
  }
}

export interface BugReportsOptions {
  /** The person's GitHub, or why there is none. */
  github(): ReportGitHub | { problem: string };
  job(id: string): Job | undefined;
  system(): ReportSystem;
  record(event: NewEvent): void;
  log(line: string): void;
  /** The person's reports: those filed, and those kept to send later. */
  reports: BugReportRepository;
  now(): string;
}

/**
 * GitHub could not take the report now, and may later: no answer, the connection refused or ended (401), no access to
 * the repository (403, 404: the app is not installed there), a rate limit (429), or GitHub's own failure (5xx).
 */
export const sendLater = (e: unknown): boolean => {
  const status = e instanceof ReportGitHubError ? e.status : undefined;
  return status === undefined || status === 401 || status === 403 || status === 404 || status === 429 || status >= 500;
};

/** The id of the report a resend key keeps (issue #2813): one per sender and key, so another sender's key is never answered. */
export const keyedReportId = (by: string, key: string): string => `k${createHash('sha256').update(`${by}\n${key}`).digest('hex').slice(0, 32)}`;

/** The answer to a resend key used again: what its report is now. Still `sending`: on its way, so kept, as the first will say. */
const answerOf = (r: BugReport): BugReportAnswer => (r.state === 'open' || r.state === 'closed'
  ? { kind: r.kind === 'comment' ? 'commented' : 'filed', number: r.number!, url: r.url! }
  : { kind: 'kept', id: r.id, problem: r.problem ?? 'this report is on its way to GitHub now' });

export interface BugReports {
  /** The context of a report, masked: the System line only. */
  context(): string;
  file(draft: BugReportDraft, by: string): Promise<BugReportAnswer>;
  /** A running job's report on itself: its text masked, the context added; `bug_report.filed` says `fromJob`. */
  fileForJob(jobId: string, report: JobReport): Promise<BugReportAnswer>;
}

export function createBugReports(o: BugReportsOptions): BugReports {
  const jobOf = (id: string): Job => {
    const job = o.job(id);
    if (!job) throw new BugReportRefused(404, `job ${id} not found`);
    return job;
  };
  /** Open reports like this title, best first; a failed search files the report as if there were none. */
  async function similar(github: ReportGitHub, title: string): Promise<SimilarReport[]> {
    const terms = searchTerms(title);
    try {
      const found = terms.length === 0 ? [] : await github.search(REPORT_REPO, REPORT_LABEL, terms);
      return found.map((r) => ({ r, s: similarityOf(terms, r.title) })).filter((x) => x.s >= SIMILAR_AT)
        .sort((a, b) => b.s - a.s).map((x) => x.r).slice(0, MAX_SIMILAR);
    } catch (e) {
      o.log(`hopper: Report a bug: the duplicate search failed, filing anyway: ${(e as Error).message}`);
      return [];
    }
  }
  const context = (): string => reportContext(o.system());
  /**
   * The report's row, in `state`, with the body to send; with a resend key, its own id, or the report that key kept first
   * (`first`): a second send at once, which files nothing.
   */
  const row = (d: BugReportDraft, by: string, body: string, state: 'sending' | 'waiting', problem?: string): BugReport | { first: BugReport } => {
    const input: Omit<BugReport, 'id'> = {
      createdAt: o.now(), by, ...(d.jobId ? { jobId: d.jobId } : {}), ...(d.fromJob ? { fromJob: true } : {}),
      title: reportTitle(d.title), state, kind: d.commentOn !== undefined ? 'comment' : 'issue',
      ...(d.commentOn !== undefined ? { number: d.commentOn } : {}), body, ...(problem !== undefined ? { problem } : {}), tries: 1, checkedAt: o.now(),
    };
    if (d.key === undefined) return o.reports.add(input);
    const id = keyedReportId(by, d.key);
    // A first that GitHub refused meanwhile is gone: the key files again.
    for (;;) {
      const added = o.reports.addOnce(id, input);
      if (added) return added;
      const first = o.reports.get(id);
      if (first) return { first };
    }
  };
  /** Kept to send later: `bug_report.kept`, and the answer that says so. */
  function kept(d: BugReportDraft, at: Record<string, unknown>, id: string, problem: string): BugReportAnswer {
    o.record({ type: 'bug_report.kept', ...(d.jobId ? { jobId: d.jobId } : {}), data: { ...at, id, problem } });
    return { kind: 'kept', id, problem };
  }
  async function file(d: BugReportDraft, by: string): Promise<BugReportAnswer> {
    if (d.jobId !== undefined) jobOf(d.jobId);
    const at = { repo: REPORT_REPO, ...(d.jobId ? { jobId: d.jobId } : {}), by, ...(d.fromJob ? { fromJob: true } : {}) };
    const first = d.key !== undefined ? o.reports.get(keyedReportId(by, d.key)) : undefined;
    if (first) return answerOf(first);
    const body = reportBody({ happened: d.happened, expected: d.expected, context: d.context, ...(d.fromJob ? { fromJob: true } : {}) });
    const github = o.github();
    if ('problem' in github) {
      const waiting = row(d, by, body, 'waiting', github.problem);
      return 'first' in waiting ? answerOf(waiting.first) : kept(d, at, waiting.id, github.problem);
    }
    if (d.commentOn === undefined && !d.force) {
      const found = await similar(github, d.title);
      if (found.length > 0) return { kind: 'similar', similar: found };
    }
    const sending = row(d, by, body, 'sending');
    if ('first' in sending) return answerOf(sending.first);
    const kind = sending.kind;
    try {
      const done = await sendReport(github, { key: sending.id, kind, title: sending.title, body, ...(d.commentOn !== undefined ? { number: d.commentOn } : {}) });
      o.reports.update(sending.id, { state: 'open', number: done.number, url: done.url, body: undefined });
      o.record({ type: 'bug_report.filed', ...(d.jobId ? { jobId: d.jobId } : {}), data: { ...at, kind, number: done.number, url: done.url } });
      return { kind: kind === 'comment' ? 'commented' : 'filed', ...done };
    } catch (e) {
      const error = (e as Error).message;
      if (sendLater(e)) {
        o.reports.update(sending.id, { state: 'waiting', problem: error });
        return kept(d, at, sending.id, error);
      }
      o.reports.remove(sending.id);
      o.record({ type: 'bug_report.failed', ...(d.jobId ? { jobId: d.jobId } : {}), data: { ...at, error } });
      throw new BugReportRefused(502, error);
    }
  }
  return {
    context,
    file,
    fileForJob(jobId, r) {
      const host = o.system().hostname;
      return file({
        title: maskReportText(r.title, host), happened: maskReportText(r.body, host), expected: '', context: context(), jobId, fromJob: true,
        ...(r.commentOn !== undefined ? { commentOn: r.commentOn } : {}), ...(r.force ? { force: true } : {}), ...(r.key !== undefined ? { key: r.key } : {}),
      }, `job ${jobId}`);
    },
  };
}
