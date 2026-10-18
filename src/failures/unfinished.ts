// Own PR unfinished (issue #1265, design.md "Own PR unfinished"): a job that ended done while its own pull request had merge
// conflicts with its base, or was a draft, is the hopper's to finish, not a person's, while its retries last. Its Continue
// asks the job's source for the step that finishes the pull request now, and the job goes on in its own agent session in its
// kept work tree (else a new job of its item), told that step: rebase and resolve the conflicts, or mark it ready. Done criteria
// unmet (issue #1924) goes on the same way, told what the done check found.
import type { RerunBy, RerunResult, UserStore } from '../domain/ports.ts';
import { unfinishedBrief, type ContinuedBy, type FailureRecord, type Job, type UnfinishedPullRequest } from '../domain/types.ts';
import { DONE_CRITERIA_UNMET, OWN_PR_UNFINISHED } from './causes.ts';
import { doneCriteriaBrief } from '../domain/conditional-skills.ts';

export interface UnfinishedDeps {
  store: Pick<UserStore, 'jobs'>;
  /** The job's own open pull request and the step that finishes it, by its source; undefined: none. Throws: not known now. */
  unfinishedPullRequest?(job: Job): Promise<UnfinishedPullRequest | undefined>;
  resumable(job: Job): boolean;
  continueJob(jobId: string, brief: string, by: ContinuedBy): Promise<RerunResult>;
  rerun(jobId: string, by: RerunBy, brief?: string): Promise<RerunResult>;
}

export function createUnfinished(d: UnfinishedDeps) {
  // Done criteria unmet (issue #1924): sent back told what the done check found, kept in the record's evidence.
  const criteriaContinue = async (r: FailureRecord): Promise<RerunResult> => {
    const job = d.store.jobs.get(r.jobId);
    if (!job) return { ok: false, reason: 'not_found', message: `job ${r.jobId} not found` };
    const resumes = d.resumable(job) && job.workTree !== undefined;
    return resumes ? d.continueJob(r.jobId, doneCriteriaBrief(r.evidence.error, true), { recordId: r.id })
      : d.rerun(r.jobId, 'assessor', doneCriteriaBrief(r.evidence.error, false));
  };
  return {
    /** The record's Continue, made now, when its cause is Own PR unfinished; undefined: any other record. */
    continueOf(r: FailureRecord): Promise<RerunResult> | undefined {
      if (r.causeId === DONE_CRITERIA_UNMET) return criteriaContinue(r);
      if (r.causeId !== OWN_PR_UNFINISHED) return undefined;
      return (async (): Promise<RerunResult> => {
        const job = d.store.jobs.get(r.jobId);
        if (!job) return { ok: false, reason: 'not_found', message: `job ${r.jobId} not found` };
        let finish: UnfinishedPullRequest | undefined;
        try {
          finish = await d.unfinishedPullRequest?.(job);
        } catch (e) {
          return { ok: false, reason: 'source', message: `its pull request could not be read: ${e instanceof Error ? e.message : String(e)}` };
        }
        const resumes = d.resumable(job) && job.workTree !== undefined;
        return resumes ? d.continueJob(r.jobId, unfinishedBrief(finish, true), { recordId: r.id })
          : d.rerun(r.jobId, 'assessor', unfinishedBrief(finish, false));
      })();
    },
  };
}
