// A failed end the hopper fixes itself (issue #1230, design.md "Own PR checks red"): a job that ended done while the checks
// of its own pull request were red, or its own pull request had merge conflicts or was a draft (issue #1265), is reported
// once assessed. While its Continue is pending, its end is told as one the
// hopper fixes (`fixing`): the issue stays as it is, never `hopper:failed`. Once a person has it — its hand-off opened, its
// retries spent or its Continue refused —, its end is told again, as failed.
import type { UserStore } from '../domain/ports.ts';
import { OWN_PR_CHECKS_RED_TEXT, OWN_PR_UNFINISHED_TEXT, type DomainEvent, type Job } from '../domain/types.ts';
import type { SyncFlags } from './sync-signals.ts';

export interface FixingReportsContext {
  store: Pick<UserStore, 'jobs' | 'failures'>;
  flagsOf(job: Job): SyncFlags;
  /** Tell the job's end to its source again. */
  reportAgain(jobId: string): void;
}

const redChecks = (job: Job): boolean => job.status === 'failed' && [OWN_PR_CHECKS_RED_TEXT, OWN_PR_UNFINISHED_TEXT].some((t) => t.test(job.error ?? ''));

export function createFixingReports(c: FixingReportsContext) {
  return {
    /** Its failure's report waits on its assessment: whether the hopper fixes it is not known yet. */
    waits: (job: Job): boolean => redChecks(job) && !job.assessment,
    /** Its failure is the hopper's to fix: its Continue is pending. */
    fixing: (job: Job): boolean => redChecks(job) && c.store.failures.get(job.assessment?.recordId ?? '')?.pending === 'continue',
    /** A hand-off opened for a failure told as one the hopper fixes: told again, as failed. True when the event was one; never a source call from a listener. */
    follows(e: DomainEvent): boolean {
      const job = e.type === 'handoff.opened' && e.jobId ? c.store.jobs.get(e.jobId) : undefined;
      if (!job || !c.flagsOf(job).fixingReported) return false;
      setImmediate(() => c.reportAgain(job.id));
      return true;
    },
  };
}
