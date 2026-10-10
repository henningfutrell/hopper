// The work check (issues #529, #621): the source of each open hand-off is asked, at once for a new one and then at most
// every WORK_CHECK_MS, what its job's work shows — its item and the pull requests the job opened or pushed to. The
// answer is kept on the hand-off (`checked`), which says it on the card, closes it when its item is closed or gone, and
// finishes its job when the work shipped. A source that cannot tell, or fails to, leaves it as it was: asked again later.
import type { Clock, UserStore } from '../domain/ports.ts';
import type { Job, WorkState } from '../domain/types.ts';

/** How often an open hand-off's source is asked what its job's work shows. */
export const WORK_CHECK_MS = 10 * 60_000;

export interface WorkCheckOptions {
  store: Pick<UserStore, 'handoffs' | 'jobs'>;
  clock: Clock;
  workState(job: Job): Promise<Omit<WorkState, 'checkedAt'> | undefined>;
  /** Keep what the open hand-off's work showed, and act on it. */
  checked(handoffId: string, work: WorkState): void;
  logger: { warn(line: string): void };
  live(): boolean;
}

/** One pass over the open hand-offs whose check is due. */
export function createWorkCheck(o: WorkCheckOptions): () => Promise<void> {
  /** When each open hand-off's work was last asked about. */
  let checkedAt = new Map<string, number>();
  return async () => {
    const at = o.clock.now().getTime();
    const checked = new Map<string, number>();
    for (const h of o.store.handoffs.list({ status: 'open', limit: 1_000_000 })) {
      const last = checkedAt.get(h.id);
      if (last !== undefined && at - last < WORK_CHECK_MS) { checked.set(h.id, last); continue; }
      checked.set(h.id, at);
      const job = o.store.jobs.get(h.jobId);
      if (!job) continue;
      try {
        const work = await o.workState(job);
        if (work && o.live()) o.checked(h.id, { ...work, checkedAt: o.clock.now().toISOString() });
      } catch (e) {
        o.logger.warn(`hopper: could not tell what the work of job ${job.id} shows: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (!o.live()) return;
    }
    checkedAt = checked;
  };
}
