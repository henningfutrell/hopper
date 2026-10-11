// Report a bug (issue #694, design.md "Report a bug"): one person's reports. `context` is what the form shows, masked,
// for the person to read and edit; `file` searches the open reports for the failure's signature and a similar title
// first and answers those instead of filing, unless the person names one to comment on or files anyway; then it files on
// the hopper's own repository with the person's own GitHub connection (`bug_report.filed`, `bug_report.failed`).
// `fileForJob` is a running job's report, by the same path: its text masked whole, the job's context added, marked as
// the job's. Never a token in an event.
import type { InstallInfo, Job, NewEvent } from '../domain/types.ts';
import { maskReportText, REPORT_LABEL, REPORT_REPO, reportBody, reportContext, reportTitle, searchTerms, SIGNATURE_LINE, similarityOf, type ReportSystem } from './context.ts';
import type { ReportGitHub, SimilarReport } from './github.ts';

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
}

/** What a running job sends (`hopper-gh report bug`): a title and what happened, and its choice after a similar one. */
export interface JobReport { title: string; body: string; commentOn?: number; force?: boolean }

export type BugReportAnswer =
  | { kind: 'filed' | 'commented'; number: number; url: string }
  | { kind: 'similar'; similar: SimilarReport[] };

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
  /** The job's failure record: its id and its signature. */
  failureOf(jobId: string): { id: string; signature: string } | undefined;
  install(): Partial<InstallInfo>;
  system(): ReportSystem;
  record(event: NewEvent): void;
  log(line: string): void;
}

export interface BugReports {
  /** The context of a report, masked; on a job when `jobId` names one (else 404). */
  context(jobId?: string): string;
  file(draft: BugReportDraft, by: string): Promise<BugReportAnswer>;
  /** A running job's report on itself: its text masked, its context added; `bug_report.filed` says `fromJob`. */
  fileForJob(jobId: string, report: JobReport): Promise<BugReportAnswer>;
}

export function createBugReports(o: BugReportsOptions): BugReports {
  const jobOf = (id: string): Job => {
    const job = o.job(id);
    if (!job) throw new BugReportRefused(404, `job ${id} not found`);
    return job;
  };
  /**
   * Open reports of the same error — their text names the signature — then those like this title, best first, each
   * once; a failed search files the report as if there were none.
   */
  async function similar(github: ReportGitHub, title: string, signature: string | undefined): Promise<SimilarReport[]> {
    const terms = searchTerms(title);
    try {
      const same = signature ? await github.search(REPORT_REPO, REPORT_LABEL, [signature], 'body') : [];
      const found = terms.length === 0 ? [] : await github.search(REPORT_REPO, REPORT_LABEL, terms);
      const like = found.map((r) => ({ r, s: similarityOf(terms, r.title) })).filter((x) => x.s >= SIMILAR_AT)
        .sort((a, b) => b.s - a.s).map((x) => x.r);
      const seen = new Set<number>();
      return [...same, ...like].filter((r) => !seen.has(r.number) && seen.add(r.number)).slice(0, MAX_SIMILAR);
    } catch (e) {
      o.log(`hopper: Report a bug: the duplicate search failed, filing anyway: ${(e as Error).message}`);
      return [];
    }
  }
  const context = (jobId?: string): string => {
    const job = jobId === undefined ? undefined : jobOf(jobId);
    const failure = job ? o.failureOf(job.id) : undefined;
    return reportContext({ install: o.install(), system: o.system(), ...(job ? { job } : {}), ...(failure ? { failureId: failure.id, signature: failure.signature } : {}) });
  };
  async function file(d: BugReportDraft, by: string): Promise<BugReportAnswer> {
    if (d.jobId !== undefined) jobOf(d.jobId);
    const at = { repo: REPORT_REPO, ...(d.jobId ? { jobId: d.jobId } : {}), by, ...(d.fromJob ? { fromJob: true } : {}) };
    const github = o.github();
    if ('problem' in github) {
      o.record({ type: 'bug_report.failed', ...(d.jobId ? { jobId: d.jobId } : {}), data: { ...at, error: github.problem } });
      throw new BugReportRefused(503, github.problem);
    }
    if (d.commentOn === undefined && !d.force) {
      // The signature only while the context sent still names it: what the person removed is not searched for either.
      const signature = d.jobId === undefined ? undefined : o.failureOf(d.jobId)?.signature;
      const found = await similar(github, d.title, signature && d.context.includes(`${SIGNATURE_LINE}${signature}`) ? signature : undefined);
      if (found.length > 0) return { kind: 'similar', similar: found };
    }
    const body = reportBody({ happened: d.happened, expected: d.expected, context: d.context, ...(d.fromJob && d.jobId ? { fromJob: d.jobId } : {}) });
    try {
      const done = d.commentOn !== undefined
        ? await github.comment(REPORT_REPO, d.commentOn, `**${reportTitle(d.title)}**\n\n${body}`)
        : await github.create(REPORT_REPO, { title: reportTitle(d.title), body, labels: [REPORT_LABEL] });
      const kind = d.commentOn !== undefined ? 'comment' : 'issue';
      o.record({ type: 'bug_report.filed', ...(d.jobId ? { jobId: d.jobId } : {}), data: { ...at, kind, number: done.number, url: done.url } });
      return { kind: kind === 'comment' ? 'commented' : 'filed', ...done };
    } catch (e) {
      const error = (e as Error).message;
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
        title: maskReportText(r.title, host), happened: maskReportText(r.body, host), expected: '', context: context(jobId), jobId, fromJob: true,
        ...(r.commentOn !== undefined ? { commentOn: r.commentOn } : {}), ...(r.force ? { force: true } : {}),
      }, `job ${jobId}`);
    },
  };
}
