// A failure a job reported as a hopper bug (issue #1147, design.md "A failure the job reported as a hopper bug"): a job
// that filed a bug report on the hopper about itself while it ran (`hopper-gh report bug`), and then failed with a
// failure the rules hand to a person, waits on that report instead — the hopper failed it, not its work. It is held on a
// problem of the report, and runs again once the report's fix landed: its issue closed as completed, and this hopper's
// build newer than that close. Pure.
import type { BugReport } from '../domain/bug-reports.ts';

/** The cause of a problem of a hopper bug report: never a known cause matched by text, so not in `BUILTIN_CAUSES`. */
export const HOPPER_BUG_CAUSE = 'hopper-bug';

const PREFIX = 'hopper-bug:';

/** The job's own report on the hopper, filed while it ran; the newest when it filed more (`reports` newest first). */
export const ownReport = (reports: readonly BugReport[], jobId: string): BugReport | undefined =>
  reports.find((r) => r.fromJob === true && r.jobId === jobId);

/** The problem's signature: the report's issue, so the jobs that report one bug wait on one problem; its id until it is sent. */
export const reportSignature = (r: BugReport): string => (r.number !== undefined ? `${PREFIX}#${r.number}` : `${PREFIX}report:${r.id}`);

export const reportTitle = (r: BugReport): string => (r.number !== undefined ? `Hopper bug #${r.number}` : 'Hopper bug (its report is not sent yet)');

export const reportReason = (r: BugReport): string =>
  `it reported a hopper bug (${r.number !== undefined ? `#${r.number}` : 'its report is not sent yet'}): it waits for the fix, then runs again`;

/** The reports a problem of `signature` waits on. */
export const reportsOf = (signature: string, reports: readonly BugReport[]): BugReport[] =>
  reports.filter((r) => reportSignature(r) === signature || (r.number !== undefined && signature === `${PREFIX}#${r.number}`));

/**
 * Its fix landed: the issue closed as completed (the merge of its fix closes it), and this hopper's build made after
 * that close, so the build has the fix. `installedAt` not known (no install record, a run from a checkout): the close alone.
 */
export function fixLanded(r: BugReport, installedAt?: string): boolean {
  if (r.state !== 'closed' || r.closedAs !== 'completed' || r.closedAt === undefined) return false;
  return installedAt === undefined || Date.parse(installedAt) > Date.parse(r.closedAt);
}
