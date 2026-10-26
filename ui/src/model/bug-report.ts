// Report a bug in the UI (issue #694), pure: the public warning (issue #2818), the draft the form keeps — a short title and
// a short description —, why it cannot be sent yet, the report as it would be posted, and what the daemon answers — a
// report filed or commented, the similar open reports offered first, or the report kept to send later —, and Your
// reports: each report with its state, a job's waiting for a person's approval.

/** What every place that offers Report a bug shows (issue #2818); the daemon's `PUBLIC_REPORT_WARNING`, word for word. */
export const PUBLIC_REPORT_WARNING = 'This report will be posted publicly on GitHub. Do not include names, emails, customer or company details, repository or host names, links, ids or file paths.';

/** The longest title and description a report takes (issue #2818). */
export const MAX_TITLE = 120;
export const MAX_DESCRIPTION = 2000;

export interface BugReportDraft { title: string; description: string }

/** What the form reads first: the context every report carries, and whether public bug reports are on. */
export interface BugReportContext { context: string; repo: string; warning: string; on: boolean }

/** The report as it would be posted (POST /ui/api/bug-reports/preview): scrubbed, masked, in the template. */
export interface BugReportPreview { title: string; body: string; removed: string[] }

export interface SimilarReport { number: number; title: string; url: string }

export type BugReportAnswer =
  | { kind: 'filed' | 'commented'; number: number; url: string }
  | { kind: 'similar'; similar: SimilarReport[] }
  | { kind: 'kept'; id: string; problem: string };

/**
 * What POST /ui/api/bug-reports takes: the draft, the job it is about, the choice after a similar one was offered, and the
 * form's resend key (issue #2813).
 */
export interface BugReportRequest extends BugReportDraft { jobId?: string; commentOn?: number; force?: boolean; key?: string }

/**
 * A new resend key for one form (issue #2813): sent with each send of it, so a second click or a resend files nothing more.
 * `crypto.getRandomValues`, not `randomUUID`: a LAN page over plain HTTP has no secure context.
 */
export function newResendKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `ui-${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export const emptyDraft = (): BugReportDraft => ({ title: '', description: '' });

/** Why the draft cannot be sent yet; undefined: it can. */
export function draftProblem(d: BugReportDraft): string | undefined {
  if (d.title.trim() === '') return 'Give the report a title';
  if (d.description.trim() === '') return 'Describe the bug';
  if (d.title.trim().length > MAX_TITLE) return `Keep the title to ${MAX_TITLE} characters`;
  if (d.description.trim().length > MAX_DESCRIPTION) return `Keep the description to ${MAX_DESCRIPTION} characters`;
  return undefined;
}

/** What the scrub removed, in words; undefined: nothing. */
export const removedLine = (removed: readonly string[] | undefined): string | undefined =>
  (removed && removed.length > 0 ? `Removed before sending: ${removed.join(', ')}` : undefined);

/** The request a send makes. */
export function reportRequest(d: BugReportDraft, o: { jobId?: string; commentOn?: number; force?: boolean; key?: string } = {}): BugReportRequest {
  return { ...d, ...(o.jobId ? { jobId: o.jobId } : {}), ...(o.commentOn !== undefined ? { commentOn: o.commentOn } : {}), ...(o.force ? { force: true } : {}), ...(o.key ? { key: o.key } : {}) };
}

/** The line that says what was done, with the issue's number. */
export const sentLine = (a: { kind: 'filed' | 'commented'; number: number }): string =>
  (a.kind === 'filed' ? `Report filed as issue #${a.number}.` : `Your report was added to issue #${a.number}.`);

/** A report in Your reports (GET /api/bug-reports): `sending` is on its way to GitHub, `waiting` is kept, not on GitHub yet. Never its text. */
export interface BugReportView {
  id: string;
  createdAt: string;
  by: string;
  jobId?: string;
  fromJob?: boolean;
  title: string;
  state: 'approval' | 'sending' | 'waiting' | 'open' | 'closed';
  kind: 'issue' | 'comment';
  number?: number;
  url?: string;
  problem?: string;
  /** What the scrub removed before it was kept, by kind (issues #2812, #2818). */
  removed?: string[];
  /** While `approval`: the report as it would be posted, for the person to read (issue #2818). */
  body?: string;
  tries: number;
  checkedAt?: string;
}

/** GET /api/bug-reports: the reports, and whether public bug reports are on (issue #2818). */
export interface YourReports { reports: BugReportView[]; publicReports: boolean }

const STATE_LABELS: Record<BugReportView['state'], string> = { approval: 'Waits for your approval', sending: 'Sending', waiting: 'Waiting to send', open: 'Open', closed: 'Closed' };

/** The state in words. */
export const stateLabel = (r: Pick<BugReportView, 'state'>): string => STATE_LABELS[r.state];

/** The report's line: its issue's number when it has one, then its title; a comment says where it went. */
export const reportLine = (r: Pick<BugReportView, 'title' | 'number' | 'kind' | 'state'>): string =>
  (r.number === undefined ? r.title : r.kind === 'comment' && (r.state === 'waiting' || r.state === 'sending' || r.state === 'approval') ? `${r.title} (to add to #${r.number})` : `#${r.number} ${r.title}`);

/** Who filed it, when a job did. */
export const filedBy = (r: Pick<BugReportView, 'fromJob' | 'jobId'>): string | undefined => (r.fromJob && r.jobId ? `Filed by job ${r.jobId}` : undefined);
