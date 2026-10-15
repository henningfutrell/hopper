// A person's Tend again (issue #1010, after-done.ts) on a pull request the hopper gave up on: its tend job ended failed,
// cancelled or rejected. Checked now (issue #1194, design.md "Actions answer at once"): refused with why when the hopper
// did not give up, its source is not running, or its tend job's end is not reported yet. Its run, after the answer,
// marks it (`tended.again`), so the step is due now, then tends it — the same step, a new row of retries,
// `job.pull_request_tended` with who pressed it —, or says why its source refused.
import type { GiveBackChecked } from '../domain/give-back.ts';
import type { JobSource, RerunResult, UserStore } from '../domain/ports.ts';
import { tendAgainRefusal } from '../domain/pull-requests.ts';
import type { ActingPerson, Job, Tended } from '../domain/types.ts';

export interface TendAgainContext {
  store: Pick<UserStore, 'jobs'>;
  sourceOf(job: Job): JobSource | undefined;
  finalReported(job: Job): boolean;
  setSource(jobId: string, source: Record<string, unknown>): void;
  now(): number;
  /** Tend the job's pull request when its step is due: undefined when it is not. */
  tendIfDue(source: JobSource, jobId: string, acting?: ActingPerson): Promise<RerunResult | undefined>;
}

export function createTendAgain(c: TendAgainContext) {
  const refused = (jobId: string, why: string) => ({ ok: false as const, reason: 'conflict' as const, message: `job ${jobId}'s pull request cannot be tended again: ${why}` });
  const NOT_REPORTED = 'its tend job\'s end is not reported to its source yet: the hopper tends it at the next sync';

  function checkTendAgain(jobId: string, acting: ActingPerson): GiveBackChecked {
    const job = c.store.jobs.get(jobId);
    if (!job) return { ok: false, reason: 'not_found', message: `job ${jobId} not found` };
    const tendJob = job.source ? c.store.jobs.getBySourceKey(job.source.key) : undefined;
    const why = tendAgainRefusal(job, tendJob);
    if (why) return refused(jobId, why);
    if (!c.sourceOf(job)) return refused(jobId, 'its source is not running');
    if (!c.finalReported(tendJob!)) return refused(jobId, NOT_REPORTED);
    return { ok: true, jobId, run: () => tendAgainNow(jobId, acting) };
  }

  async function tendAgainNow(jobId: string, acting: ActingPerson): Promise<RerunResult> {
    const job = c.store.jobs.get(jobId);
    const source = job ? c.sourceOf(job) : undefined;
    if (!job || !source) return refused(jobId, 'its source is not running');
    const s = job.sourceState!.source as { tended: Tended };
    c.setSource(jobId, { ...s, tended: { ...s.tended, again: new Date(c.now()).toISOString() } });
    // Not due: its tend job's end is not reported yet. The next sync tends it.
    return await c.tendIfDue(source, jobId, acting) ?? refused(jobId, NOT_REPORTED);
  }

  return {
    checkTendAgain,
    /** Tend again, checked, then run: the stuck cause's bulk action awaits each. */
    async tendAgain(jobId: string, acting: ActingPerson): Promise<RerunResult> {
      const checked = checkTendAgain(jobId, acting);
      return checked.ok ? tendAgainNow(jobId, acting) : checked;
    },
  };
}
