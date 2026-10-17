// Own PR checks red (issue #1230, design.md "Own PR checks red"): a job that ended done while the checks of its own pull
// request were red is the hopper's to finish, not a person's, while its retries last. Its Continue is pending on its record,
// and each sweep takes one step, from the pull request as its source reads it now: checks still running, it waits; checks
// that pass, or no such pull request, leave it to the done check, then to a Continue; red, the failed checks run again once
// for each head commit — the flake guard, recorded as `job.checks_rerun_asked` before it is asked (issue #1607: a stop
// meanwhile makes no second one) and as `job.checks_rerun` after —, and red again, the job goes on in its own agent
// session in its kept work tree (else a new job of its item), told the failed checks and their logs' excerpts.
import type { JobSource, RerunBy, RerunResult, UserStore } from '../domain/ports.ts';
import { OWN_PR_CHECKS_RED } from './causes.ts';
import { checksRedBrief, type ChecksRerun, type ContinuedBy, type FailedCheck, type FailureRecord, type Job, type OwnPullRequestChecks } from '../domain/types.ts';

/** How long after a step the next one is taken while the checks run. */
export const CHECKS_WAIT_MS = 60_000;
/** The longest the Continue waits on checks that keep running; then the job goes on, told what is known. */
export const MAX_CHECKS_WAIT_MS = 60 * 60_000;

/** What the failure assessor is given for it, by the job's source. */
export interface ChecksRedOptions {
  /** The job's own pull request and its checks; undefined: none, or the source cannot tell. Throws: not known now. */
  ownPullRequestChecks?(job: Job): Promise<OwnPullRequestChecks | undefined>;
  /** Run the failed checks again once; undefined: the source cannot. Throws: not known now. */
  rerunChecks?(job: Job, failed: readonly FailedCheck[]): Promise<ChecksRerun | undefined>;
  /** The failed checks, each with its log's excerpt or why it could not be read. Never throws. */
  checkLogs?(job: Job, failed: readonly FailedCheck[]): Promise<FailedCheck[]>;
  /** How long between looks while the checks run. Absent: `CHECKS_WAIT_MS`. */
  checksWaitMs?: number;
}

export interface ChecksRedDeps extends ChecksRedOptions {
  store: Pick<UserStore, 'jobs' | 'events' | 'failures' | 'tx'>;
  resumable(job: Job): boolean;
  continueJob(jobId: string, brief: string, by: ContinuedBy): Promise<RerunResult>;
  rerun(jobId: string, by: RerunBy, brief?: string): Promise<RerunResult>;
  now(): Date;
  live?(): boolean;
}

/** The failure assessor's half, from the job's source (`users/runtime.ts`): `sourceOf` the job's running source. */
export function checksRedOf(sourceOf: (job: Job) => JobSource | undefined): Omit<ChecksRedOptions, 'checksWaitMs'> {
  return {
    ownPullRequestChecks: async (job) => sourceOf(job)?.ownPullRequestChecks?.(job),
    rerunChecks: async (job, failed) => sourceOf(job)?.rerunChecks?.(failed),
    checkLogs: async (job, failed) => { const s = sourceOf(job); return s?.checkLogs ? s.checkLogs(failed) : [...failed]; },
  };
}

/** One step: wait `ms` and say why, or go on — the done check first, then the Continue with `go`. */
export type ChecksRedStep = { kind: 'wait'; ms: number; note: string } | { kind: 'go'; go(): Promise<RerunResult> };

export function createChecksRed(d: ChecksRedDeps) {
  const { store } = d;
  const waitMs = d.checksWaitMs ?? CHECKS_WAIT_MS;
  /** The Continue each record's last step made ready, made by `continueOf`. */
  const ready = new Map<string, () => Promise<RerunResult>>();

  /**
   * This record's run again of the checks of `head`, if one was asked: what it did (`job.checks_rerun`), or only that it
   * was asked (`job.checks_rerun_asked`: the hopper stopped meanwhile, so whether any check ran again is not known).
   */
  const rerunOf = (r: FailureRecord, pullRequest: string, head: string) => store.events.recent(50, ['job.checks_rerun', 'job.checks_rerun_asked'], r.jobId)
    .find((e) => e.data.pullRequest === pullRequest && e.data.head === head);

  /** The Continue: its own agent session in its kept work tree when it can resume, else its item again; both told `checks`. */
  function goOn(r: FailureRecord, job: Job, pullRequest: string, failed: readonly FailedCheck[], rerunByHopper: boolean): () => Promise<RerunResult> {
    return async () => {
      const told = d.checkLogs && failed.length > 0 ? await d.checkLogs(job, failed) : [...failed];
      const checks = { failed: told, rerun: !rerunByHopper, rerunByHopper };
      const resumes = d.resumable(job) && job.workTree !== undefined;
      return resumes ? d.continueJob(r.jobId, checksRedBrief(pullRequest, checks, true), { recordId: r.id })
        : d.rerun(r.jobId, 'assessor', checksRedBrief(pullRequest, checks, false));
    };
  }

  return {
    /** The next step of the record's pending Continue. Throws when its source cannot tell now: asked again later. */
    async step(r: FailureRecord): Promise<ChecksRedStep> {
      const job = store.jobs.get(r.jobId);
      if (!job) return { kind: 'go', go: () => Promise.resolve({ ok: false, reason: 'not_found', message: `job ${r.jobId} not found` }) };
      const own = await d.ownPullRequestChecks?.(job);
      const since = Date.parse(r.at);
      if (own?.checks === 'pending' && d.now().getTime() - since < MAX_CHECKS_WAIT_MS) {
        return { kind: 'wait', ms: waitMs, note: `the checks of ${own.pullRequest} are running` };
      }
      // Passing, none, or not known: the done check decides; not done, the job goes on, told what is known.
      if (own?.checks !== 'failing') {
        return { kind: 'go', go: goOn(r, job, own?.pullRequest ?? 'of this job', [], false) };
      }
      const head = own.headOid ?? '';
      const made = rerunOf(r, own.pullRequest, head);
      if (!made && d.rerunChecks) {
        store.events.append({ type: 'job.checks_rerun_asked', jobId: job.id, data: { recordId: r.id, pullRequest: own.pullRequest, head, checks: own.failed.map((c) => c.name) } });
        const result = await d.rerunChecks(job, own.failed);
        const rerun = result?.rerun ?? [];
        const refused = result ? result.refused : 'its source cannot run checks again';
        store.events.append({
          type: 'job.checks_rerun', jobId: job.id,
          data: { recordId: r.id, pullRequest: own.pullRequest, head, checks: rerun, ...(refused ? { refused } : {}) },
        });
        if (rerun.length > 0) return { kind: 'wait', ms: waitMs, note: `its failed checks run again: ${rerun.join(', ')}` };
        return { kind: 'go', go: goOn(r, job, own.pullRequest, own.failed, false) };
      }
      // Red again after the run again (or never run again: the job may, once).
      const ranAgain = made?.type === 'job.checks_rerun' && Array.isArray(made.data.checks) && made.data.checks.length > 0;
      return { kind: 'go', go: goOn(r, job, own.pullRequest, own.failed, ranAgain) };
    },
    /**
     * Before the done check of a pending Continue of this cause: true when it waits — its record put off, saying why —, else
     * its Continue is ready for `continueOf`. Any other record: false. A source that cannot tell puts it off `laterMs`.
     */
    async waits(r: FailureRecord, laterMs: number): Promise<boolean> {
      if (r.pending !== 'continue' || r.causeId !== OWN_PR_CHECKS_RED) return false;
      const s = await this.step(r).catch((e: unknown): ChecksRedStep => ({ kind: 'wait', ms: laterMs, note: `its pull request's checks could not be read: ${e instanceof Error ? e.message : String(e)}` }));
      if (d.live && !d.live()) return true;
      if (s.kind === 'go') { ready.set(r.id, s.go); return false; }
      store.tx(() => { if (store.failures.get(r.id)?.pending) store.failures.update(r.id, { pendingAt: new Date(d.now().getTime() + s.ms).toISOString(), note: s.note }); });
      return true;
    },
    /** The Continue `waits` made ready for the record, made now; undefined: none. */
    continueOf(r: FailureRecord): Promise<RerunResult> | undefined {
      const go = ready.get(r.id);
      ready.delete(r.id);
      return go?.();
    },
  };
}
