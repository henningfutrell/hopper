// Closed items (issue #529): the source of each open hand-off is asked, at most every ITEM_CHECK_MS, whether its
// item is closed; a closed one closes the hand-off (`item_closed`). A source that cannot tell, or fails to, leaves
// it open: asked again later.
import type { Clock, UserStore } from '../domain/ports.ts';
import type { Job } from '../domain/types.ts';

/** How often an open hand-off's source is asked whether its item is closed. */
export const ITEM_CHECK_MS = 10 * 60_000;

export interface ItemCheckOptions {
  store: Pick<UserStore, 'handoffs' | 'jobs'>;
  clock: Clock;
  itemClosed(job: Job): Promise<boolean | undefined>;
  /** Close the open hand-off: its item is closed. */
  closed(handoffId: string): void;
  logger: { warn(line: string): void };
  live(): boolean;
}

/** One pass over the open hand-offs whose check is due. */
export function createItemCheck(o: ItemCheckOptions): () => Promise<void> {
  /** When each open hand-off's item was last asked about. */
  let checkedAt = new Map<string, number>();
  return async () => {
    const at = o.clock.now().getTime();
    const checked = new Map<string, number>();
    for (const h of o.store.handoffs.list({ status: 'open', limit: 1_000_000 })) {
      const last = checkedAt.get(h.id);
      if (last !== undefined && at - last < ITEM_CHECK_MS) { checked.set(h.id, last); continue; }
      checked.set(h.id, at);
      const job = o.store.jobs.get(h.jobId);
      if (!job) continue;
      try {
        if (await o.itemClosed(job) === true && o.live()) o.closed(h.id);
      } catch (e) {
        o.logger.warn(`hopper: could not tell whether the item of job ${job.id} is closed: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (!o.live()) return;
    }
    checkedAt = checked;
  };
}
