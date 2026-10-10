// Report a bug (issue #694, design.md "Report a bug"): one person's reports. `context` is what the form shows, masked,
// for the person to read and edit; `file` searches the open reports for a similar title first and answers those
// instead of filing, unless the person names one to comment on or files anyway; then it files on the hopper's own
// repository with the person's own GitHub connection (`bug_report.filed`, `bug_report.failed`). Never a token in an event.
import type { InstallInfo, Job, NewEvent } from '../domain/types.ts';
import { REPORT_LABEL, REPORT_REPO, reportBody, reportContext, reportTitle, searchTerms, similarityOf, type ReportSystem } from './context.ts';
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
}

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
  failureOf(jobId: string): string | undefined;
  install(): Partial<InstallInfo>;
  system(): ReportSystem;
  record(event: NewEvent): void;
  log(line: string): void;
}

export interface BugReports {
  /** The context of a report, masked; on a job when `jobId` names one (else 404). */
  context(jobId?: string): string;
  file(draft: BugReportDraft, by: string): Promise<BugReportAnswer>;
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
    if (terms.length === 0) return [];
    try {
      const found = await github.search(REPORT_REPO, REPORT_LABEL, terms);
      return found.map((r) => ({ r, s: similarityOf(terms, r.title) })).filter((x) => x.s >= SIMILAR_AT)
        .sort((a, b) => b.s - a.s).slice(0, MAX_SIMILAR).map((x) => x.r);
    } catch (e) {
      o.log(`hopper: Report a bug: the duplicate search failed, filing anyway: ${(e as Error).message}`);
      return [];
    }
  }
  return {
    context(jobId) {
      const job = jobId === undefined ? undefined : jobOf(jobId);
      const failureId = job ? o.failureOf(job.id) : undefined;
      return reportContext({ install: o.install(), system: o.system(), ...(job ? { job } : {}), ...(failureId ? { failureId } : {}) });
    },
    async file(d, by) {
      if (d.jobId !== undefined) jobOf(d.jobId);
      const at = { repo: REPORT_REPO, ...(d.jobId ? { jobId: d.jobId } : {}), by };
      const github = o.github();
      if ('problem' in github) {
        o.record({ type: 'bug_report.failed', ...(d.jobId ? { jobId: d.jobId } : {}), data: { ...at, error: github.problem } });
        throw new BugReportRefused(503, github.problem);
      }
      if (d.commentOn === undefined && !d.force) {
        const found = await similar(github, d.title);
        if (found.length > 0) return { kind: 'similar', similar: found };
      }
      const body = reportBody({ happened: d.happened, expected: d.expected, context: d.context });
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
    },
  };
}
