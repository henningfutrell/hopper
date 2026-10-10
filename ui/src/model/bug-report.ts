// Report a bug in the UI (issue #694), pure: the draft the form keeps, why it cannot be sent yet, and what the daemon
// answers — a report filed or commented, or the similar open reports offered first.

export interface BugReportDraft { title: string; happened: string; expected: string; context: string }

export interface SimilarReport { number: number; title: string; url: string }

export type BugReportAnswer =
  | { kind: 'filed' | 'commented'; number: number; url: string }
  | { kind: 'similar'; similar: SimilarReport[] };

/** What POST /ui/api/bug-reports takes: the draft, the job it is about, and the choice after a similar one was offered. */
export interface BugReportRequest extends BugReportDraft { jobId?: string; commentOn?: number; force?: boolean }

export const emptyDraft = (context = ''): BugReportDraft => ({ title: '', happened: '', expected: '', context });

/** Why the draft cannot be sent yet; undefined: it can. */
export function draftProblem(d: BugReportDraft): string | undefined {
  if (d.title.trim() === '') return 'Give the report a title';
  if (d.happened.trim() === '') return 'Say what happened';
  return undefined;
}

/** The request a send makes. */
export function reportRequest(d: BugReportDraft, o: { jobId?: string; commentOn?: number; force?: boolean } = {}): BugReportRequest {
  return { ...d, ...(o.jobId ? { jobId: o.jobId } : {}), ...(o.commentOn !== undefined ? { commentOn: o.commentOn } : {}), ...(o.force ? { force: true } : {}) };
}

/** The line that says what was done, with the issue's number. */
export const sentLine = (a: { kind: 'filed' | 'commented'; number: number }): string =>
  (a.kind === 'filed' ? `Report filed as issue #${a.number}.` : `Your report was added to issue #${a.number}.`);
