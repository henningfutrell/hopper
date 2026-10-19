// A failed job whose work landed (issues #350, #1067): its item's issue closed as complete, as the work-item ledger holds
// it. The sync loop asks before it reports a failure; the ledger's rule (`issueClosedAsComplete`) decides, and a read of
// the source is only ever ledger input. Tending asks the same of a job it would tend (issue #2127, `issueClosed`).
import type { JobSource, SourceHost, UserStore } from '../domain/ports.ts';
import type { Job } from '../domain/types.ts';
import { issueChangeEvent, issueClosedAsComplete } from '../domain/work-items.ts';
import type { Slot } from './sync-slots.ts';

/**
 * Finish `job` instead of reporting its failure when the work-item ledger holds its item's issue closed as complete. When
 * the ledger does not hold it closed, the source reads the item once and the read is recorded first
 * (`work_item.issue_closed`, `via: read`): one rule, the ledger's. Throws when the read fails: the caller asks again.
 */
export async function finishIfClosedAsComplete(host: Pick<SourceHost, 'store' | 'finishShipped'>, source: Pick<JobSource, 'issueState'>, job: Job): Promise<void> {
  const key = job.source?.key;
  if (key === undefined) return;
  const { store } = host;
  const item = store.workItems.get(key);
  if (item?.jobId === job.id && item.issueState !== 'closed' && source.issueState) {
    const read = await source.issueState(job);
    const event = read && issueChangeEvent(item, read, 'read');
    if (event) store.events.append(event);
  }
  const now = store.workItems.get(key);
  if (now?.jobId === job.id && issueClosedAsComplete(now)) host.finishShipped(job.id);
}

/** A failed job whose work landed is finished instead (`finishIfClosedAsComplete`). false: asking failed, kept on its slot; the next sync asks again. */
export async function finishedIfClosedAsComplete(host: Pick<SourceHost, 'store' | 'finishShipped'>, slot: Pick<Slot, 'source' | 'retrying'>, job: Job): Promise<boolean> {
  try {
    await finishIfClosedAsComplete(host, slot.source, job);
    return true;
  } catch (e) {
    slot.retrying.set(job.id, e instanceof Error ? e.message : String(e));
    return false;
  }
}

/**
 * Whether `job` is a tend job and the work-item ledger holds its item's issue closed (issue #2127): its pull request is
 * tended no more. Only after a tend job: a closed item's first tend still runs (issue #927, a recorded merge GitHub
 * contradicts).
 */
export const heldClosed = (store: Pick<UserStore, 'workItems'>, job: Job): boolean =>
  job.spec.tend === true && job.source !== undefined && store.workItems.get(job.source.key)?.issueState === 'closed';

/**
 * Whether `job` is a tend job whose work item's issue is closed, before a tend (issue #2127): a tend job that found nothing
 * left to merge closes it, and the next tend's Run again would reopen it. When the ledger does not hold it closed, the
 * source reads it once, and the read is recorded first (`work_item.issue_closed`, `via: read`). A read that fails, or a
 * source that cannot say: open.
 */
export async function issueClosed(store: Pick<UserStore, 'workItems' | 'events'>, source: Pick<JobSource, 'name' | 'issueState'>, job: Job | undefined): Promise<boolean> {
  const item = job?.spec.tend && job.source ? store.workItems.get(job.source.key) : undefined;
  if (!job || !item) return false;
  if (item.issueState === 'closed') return true;
  if (!source.issueState) return false;
  const read = await source.issueState(job).catch((e: unknown) =>
    void console.warn(`hopper: ${source.name}: whether the issue of ${item.key} is closed was not read, it is tended: ${(e as Error).message}`));
  const event = read && issueChangeEvent(item, read, 'read');
  if (event) store.events.append(event);
  return heldClosed(store, job);
}
