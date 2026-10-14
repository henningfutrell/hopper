// The failure assessor's side of a timed-out job (issue #630, `timed-out.ts` for its rules, `chain.ts` for what it reads
// of its job and chain): its source asked first whether a pull request of its own is open, and its Continue — its own
// agent session resumes in its kept work tree when it can, else its item runs again; either one told it timed out
// while at work.
import type { RerunBy, RerunResult, UserStore } from '../domain/ports.ts';
import type { ActingPerson, ContinuedBy, FailureRecord, Job } from '../domain/types.ts';
import { timedOutBrief } from './brief.ts';

/** How long the assessor waits for a timed-out job's pull request lookup before it assesses without it. */
export const PR_LOOKUP_MS = 10_000;
const TIMED_OUT = 'timed out';

export interface TimeoutsDeps {
  store: UserStore;
  /** Whether a pull request of the job's own is open, by its source; undefined: its source cannot tell. Throws: not known. */
  pullRequestOpen?: ((job: Job) => Promise<boolean | undefined>) | undefined;
  logger: { warn(line: string): void };
  live(): boolean;
  resumable(job: Job): boolean;
  continueJob(jobId: string, brief: string, by: ContinuedBy): Promise<RerunResult>;
  rerun(jobId: string, by: RerunBy, brief?: string, acting?: ActingPerson): Promise<RerunResult>;
}

export function createTimeouts(d: TimeoutsDeps) {
  const { store } = d;
  return {
    /**
     * A timed-out job not assessed yet: its source asked whether a pull request of its own is open, the answer kept in
     * its liveness. A lookup that fails or takes longer than `PR_LOOKUP_MS` leaves it not known.
     */
    async lookUpPullRequest(jobId: string): Promise<void> {
      const job = store.jobs.get(jobId);
      if (!d.pullRequestOpen || !job || job.status !== 'failed' || job.assessment || job.error !== TIMED_OUT || job.liveness?.pullRequest !== undefined) return;
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), PR_LOOKUP_MS); });
      const open = await Promise.race([d.pullRequestOpen(job), late]).catch((e: unknown) => {
        d.logger.warn(`hopper: the pull request lookup for timed-out job ${jobId} failed: ${e instanceof Error ? e.message : String(e)}; assessed without it`);
        return undefined;
      }).finally(() => clearTimeout(timer));
      if (open === undefined || !d.live()) return;
      store.tx(() => {
        const cur = store.jobs.get(jobId);
        if (cur?.status === 'failed' && !cur.assessment) store.jobs.update(jobId, { liveness: { ...cur.liveness, pullRequest: open } });
      });
    },

    /** Its Continue: its own agent session in its kept work tree when it can resume, else its item again. */
    continueOf(r: FailureRecord): Promise<RerunResult> {
      const job = store.jobs.get(r.jobId);
      if (job && d.resumable(job) && job.workTree !== undefined) return d.continueJob(r.jobId, timedOutBrief(true), { recordId: r.id });
      return d.rerun(r.jobId, 'assessor', timedOutBrief(false));
    },
  };
}
